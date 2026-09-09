import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  expectConsistent,
  issuedKeys,
  pay,
  resetDatabase,
  setPsp,
  setStub,
  startApp,
  type TestApp,
} from './helpers.js';

let t: TestApp;
let ds: DataSource;

beforeAll(async () => {
  process.env.SUPPLIER_TIMEOUT_MS = '250';
  process.env.SUPPLIER_RETRY_BASE_MS = '30';
  process.env.SUPPLIER_MAX_ATTEMPTS = '3';
  process.env.RECOVERY_INTERVAL_MS = '3600000';
  t = await startApp();
  ds = t.app.get(DataSource);
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await resetDatabase(t.app);
  for (const supplier of ['a', 'b']) {
    await setStub(t, supplier, {
      errorRate: 0,
      timeoutRate: 0,
      hangMs: 1000,
      unavailableSkus: [],
    });
  }
  await setPsp(t, { errorRate: 0 });
});

const outcomes = (order: any, itemId: string) =>
  order.attempts
    .filter((a: any) => a.itemId === itemId)
    .map((a: any) => `${a.supplier}:${a.outcome}`);

const pspRefunds = async () =>
  (await t.api('GET', '/stubs/payments')).body.refunds;

describe('orders with several items', () => {
  it('delivers every item, each by the supplier that stocks it', async () => {
    const order = await t.createOrder([
      'KEY-GTA5',
      'SUB-YT-3M',
      'GIFT-PSN-1000',
    ]);
    expect(order.amount).toBe(1990 + 1490 + 1000);
    await pay(t, order);

    const delivered = await t.waitForStatus(order.id, 'delivered');
    expect(
      delivered.items.map((i: any) => [i.sku, i.status, i.delivery.supplier]),
    ).toEqual([
      ['KEY-GTA5', 'delivered', 'a'],
      ['SUB-YT-3M', 'delivered', 'b'],
      ['GIFT-PSN-1000', 'delivered', 'b'],
    ]);
    expect(new Set(delivered.items.map((i: any) => i.delivery.code)).size).toBe(
      3,
    );
    expect(delivered.money).toEqual({
      paid: 4480,
      delivered: 4480,
      refunded: 0,
      pending: 0,
    });
    await expectConsistent(t.app);
  });

  it('refunds the line no supplier can issue; the rest stays with the customer', async () => {
    await setStub(t, 'a', { unavailableSkus: ['KEY-EFT'] });
    await setStub(t, 'b', { unavailableSkus: ['KEY-EFT'] });
    const order = await t.createOrder(['KEY-GTA5', 'KEY-EFT', 'SUB-YT-3M']);
    await pay(t, order);

    const final = await t.waitForStatus(order.id, 'partially_delivered');
    const [gta, eft, yt] = final.items;
    expect(gta).toMatchObject({ status: 'delivered', refund: null });
    expect(yt).toMatchObject({ status: 'delivered', refund: null });
    expect(eft).toMatchObject({
      status: 'refunded',
      delivery: null,
      refund: { amount: 3490, reason: 'out_of_stock' },
    });
    // Both suppliers were asked once; out of stock is definitive, no retries.
    expect(outcomes(final, eft.id)).toEqual([
      'a:out_of_stock',
      'b:out_of_stock',
    ]);

    // Paid = delivered + refunded, on the order and in the books.
    expect(final.money).toEqual({
      paid: 6970,
      delivered: 3480,
      refunded: 3490,
      pending: 0,
    });
    expect(await pspRefunds()).toEqual({ count: 1, amount: 3490 });
    const report = (await t.api('GET', '/admin/reconciliation')).body;
    expect(report.healthy).toBe(true);
    expect(report.counts.moneyMismatches).toBe(0);
    expect(report.ledger).toMatchObject({
      cash: 3480,
      customerLiability: 0,
      revenue: 3480,
      refunded: 3490,
      total: 0,
      balanced: true,
    });
    await expectConsistent(t.app);
  });

  it('refunds everything when nothing can be issued', async () => {
    await ds.query('DELETE FROM supplier_keys WHERE request_id IS NULL');
    const order = await t.createOrder(['KEY-GTA5', 'SUB-YT-3M']);
    await pay(t, order);

    const final = await t.waitForStatus(order.id, 'refunded');
    expect(final.items.every((i: any) => i.status === 'refunded')).toBe(true);
    expect(final.money).toEqual({
      paid: 3480,
      delivered: 0,
      refunded: 3480,
      pending: 0,
    });
    expect(await pspRefunds()).toEqual({ count: 2, amount: 3480 });
    // A final order cannot be re-delivered.
    expect((await t.api('POST', `/orders/${order.id}/deliver`)).status).toBe(
      409,
    );
    await expectConsistent(t.app);
  });

  it('a worker that dies after the first item is picked up by recovery: no second code, no second posting', async () => {
    // A delivers the first item; B issues a code for the second but never answers.
    await setStub(t, 'b', { timeoutRate: 1 });
    const order = await t.createOrder(['KEY-GTA5', 'SUB-YT-3M']);
    await pay(t, order);

    const parked = await t.waitForStatus(order.id, 'delivery_failed');
    const [gta, yt] = parked.items;
    expect(gta.status).toBe('delivered');
    expect(yt.status).toBe('pending');
    expect(parked.money).toEqual({
      paid: 3480,
      delivered: 1990,
      refunded: 0,
      pending: 1490,
    });
    const held = (await issuedKeys(t.app, order.id)).find(
      (k) => k.supplier === 'b',
    )!;
    expect(held).toBeDefined();

    // Now fake the crash: the state a worker leaves behind when it dies right
    // here is `delivering` with one item done and one still open.
    await ds.query(
      `UPDATE orders SET status = 'delivering', updated_at = now() - interval '1 hour' WHERE id = $1`,
      [order.id],
    );
    await setStub(t, 'b', { timeoutRate: 0 });
    expect((await t.api('POST', '/admin/recovery')).body).toEqual({
      stale: [order.id],
      parked: [],
    });

    const final = await t.waitForStatus(order.id, 'delivered');
    // First item untouched: same code, not asked again.
    expect(final.items[0].delivery.code).toBe(gta.delivery.code);
    expect(outcomes(final, gta.id)).toEqual(['a:ok']);
    // Second item got the code B was holding all along.
    expect(final.items[1].delivery).toMatchObject({
      supplier: 'b',
      code: held.code,
    });
    expect(final.money).toEqual({
      paid: 3480,
      delivered: 3480,
      refunded: 0,
      pending: 0,
    });
    expect(await issuedKeys(t.app, order.id)).toHaveLength(2);
    await expectConsistent(t.app);
  });

  it('a refund the provider rejects is retried later and paid out exactly once', async () => {
    await setStub(t, 'a', { unavailableSkus: ['KEY-EFT'] });
    await setStub(t, 'b', { unavailableSkus: ['KEY-EFT'] });
    await setPsp(t, { errorRate: 1 });
    const order = await t.createOrder(['KEY-GTA5', 'KEY-EFT']);
    await pay(t, order);

    // The decision to refund is made and stored; only the payout is pending.
    const parked = await t.waitForStatus(order.id, 'delivery_failed');
    expect(parked.items[1]).toMatchObject({
      status: 'refunding',
      refund: null,
    });
    expect(parked.money).toEqual({
      paid: 5480,
      delivered: 1990,
      refunded: 0,
      pending: 3490,
    });
    expect(await pspRefunds()).toEqual({ count: 0, amount: 0 });

    await setPsp(t, { errorRate: 0 });
    expect((await t.api('POST', `/orders/${order.id}/deliver`)).status).toBe(
      200,
    );
    const final = await t.waitForStatus(order.id, 'partially_delivered');
    expect(final.items[1]).toMatchObject({
      status: 'refunded',
      refund: { amount: 3490, reason: 'out_of_stock' },
    });
    // The suppliers were not asked again for a line already decided.
    expect(outcomes(final, final.items[1].id)).toEqual([
      'a:out_of_stock',
      'b:out_of_stock',
    ]);
    expect(await pspRefunds()).toEqual({ count: 1, amount: 3490 });
    await expectConsistent(t.app);
  });

  it('chaos: flaky suppliers and partial stock across many orders, every rouble accounted for', async () => {
    await setStub(t, 'a', {
      errorRate: 0.3,
      timeoutRate: 0.2,
      hangMs: 400,
      unavailableSkus: ['KEY-EFT'],
    });
    await setStub(t, 'b', {
      errorRate: 0.3,
      timeoutRate: 0.2,
      hangMs: 400,
      unavailableSkus: ['KEY-EFT', 'SUB-SPOTIFY-1M'],
    });
    const skus = [
      'KEY-GTA5',
      'KEY-EFT',
      'SUB-YT-3M',
      'SUB-SPOTIFY-1M',
      'GIFT-PSN-1000',
    ];
    const orders = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        t.createOrder([skus[i % 5], skus[(i + 1) % 5], skus[(i + 2) % 5]]),
      ),
    );
    await Promise.all(orders.map((order) => pay(t, order)));

    const finals = ['delivered', 'partially_delivered', 'refunded'];
    await Promise.all(
      orders.map((order) =>
        t.waitForStatus(order.id, [...finals, 'delivery_failed'], 40_000),
      ),
    );

    // Heal the suppliers and give parked orders another pass; items that timed
    // out must go back to the supplier that holds their code.
    await setStub(t, 'a', { errorRate: 0, timeoutRate: 0 });
    await setStub(t, 'b', { errorRate: 0, timeoutRate: 0 });
    for (const order of orders) {
      const { body } = await t.api('GET', `/orders/${order.id}`);
      if (body.status === 'delivery_failed') {
        await t.api('POST', `/orders/${order.id}/deliver`);
      }
    }
    const settled = await Promise.all(
      orders.map((order) => t.waitForStatus(order.id, finals, 40_000)),
    );

    for (const order of settled) {
      const { paid, delivered, refunded, pending } = order.money;
      expect(pending).toBe(0);
      expect(paid).toBe(delivered + refunded);
      for (const item of order.items) {
        if (item.sku === 'KEY-EFT') {
          // Nowhere in stock: always refunded.
          expect(item).toMatchObject({ status: 'refunded', delivery: null });
        } else {
          // Delivered, or refunded because every supplier failed for good.
          expect(['delivered', 'refunded']).toContain(item.status);
        }
      }
    }
    const codes = settled.flatMap((o) =>
      o.items.filter((i: any) => i.delivery).map((i: any) => i.delivery.code),
    );
    expect(new Set(codes).size).toBe(codes.length);
    expect((await t.api('GET', '/admin/reconciliation')).body.healthy).toBe(
      true,
    );
    await expectConsistent(t.app);
  });
});
