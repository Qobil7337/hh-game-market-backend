import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  expectConsistent,
  pay,
  resetDatabase,
  setStub,
  startApp,
  type TestApp,
} from './helpers.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let t: TestApp;
let ds: DataSource;

beforeAll(async () => {
  process.env.SUPPLIER_TIMEOUT_MS = '250';
  process.env.SUPPLIER_RETRY_BASE_MS = '30';
  process.env.RECOVERY_INTERVAL_MS = '3600000';
  process.env.SUPPLIER_AUDIT_INTERVAL_MS = '3600000';
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
});

const iso = (at: string | Date, offsetMs = 0) =>
  new Date(new Date(at).getTime() + offsetMs).toISOString();

const stateAt = async (orderId: string, time: string) =>
  t.api('GET', `/orders/${orderId}/at?time=${encodeURIComponent(time)}`);

const money = async (query: string) =>
  (await t.api('GET', `/admin/money?${query}`)).body;

describe('history: any past moment can be reconstructed', () => {
  it('replays an order to what it was at each moment of its life', async () => {
    await setStub(t, 'a', { unavailableSkus: ['KEY-EFT'] });
    await setStub(t, 'b', { unavailableSkus: ['KEY-EFT'] });
    const order = await t.createOrder(['KEY-GTA5', 'KEY-EFT']);
    await sleep(20);
    await pay(t, order);
    const final = await t.waitForStatus(order.id, 'partially_delivered');

    const history = (await t.api('GET', `/orders/${order.id}/history`)).body;
    const types = history.map((e: any) => `${e.type}:${e.data.to ?? ''}`);
    expect(types).toEqual([
      'order.created:',
      'order.status:paid',
      'order.status:delivering',
      'item.status:delivered',
      'item.status:refunding',
      'item.status:refunded',
      'order.status:partially_delivered',
    ]);
    const at = (type: string) =>
      history.find((e: any) => types[history.indexOf(e)] === type).at;

    // Before it existed.
    expect(
      (await stateAt(order.id, iso(at('order.created:'), -1))).status,
    ).toBe(404);

    // Just created: nothing paid, nothing owed.
    const created = (await stateAt(order.id, at('order.created:'))).body;
    expect(created).toMatchObject({
      status: 'created',
      money: { paid: 0, delivered: 0, refunded: 0, pending: 0 },
    });
    expect(created.items.map((i: any) => i.status)).toEqual([
      'pending',
      'pending',
    ]);

    // Paid: the whole amount is owed to the customer.
    expect(
      (await stateAt(order.id, at('order.status:paid'))).body,
    ).toMatchObject({
      status: 'paid',
      money: { paid: 5480, delivered: 0, refunded: 0, pending: 5480 },
    });

    // First item delivered, second still open.
    const half = (await stateAt(order.id, at('item.status:delivered'))).body;
    expect(half.status).toBe('delivering');
    expect(half.items[0]).toMatchObject({
      status: 'delivered',
      delivery: { supplier: 'a', code: final.items[0].delivery.code },
    });
    expect(half.items[1]).toMatchObject({ status: 'pending', refund: null });
    expect(half.money).toEqual({
      paid: 5480,
      delivered: 1990,
      refunded: 0,
      pending: 3490,
    });

    // Now: the replay equals the live order.
    const now = (await stateAt(order.id, new Date().toISOString())).body;
    expect(now.status).toBe(final.status);
    expect(now.money).toEqual(final.money);
    expect(
      now.items.map((i: any) => [
        i.status,
        i.delivery?.code ?? null,
        i.refund?.reason ?? null,
      ]),
    ).toEqual(
      final.items.map((i: any) => [
        i.status,
        i.delivery?.code ?? null,
        i.refund?.reason ?? null,
      ]),
    );
    expect(now.eventsApplied).toBe(history.length);
  });

  it('history only grows: rewriting or deleting it is refused', async () => {
    const order = await t.createOrder();
    await pay(t, order);
    await t.waitForStatus(order.id, 'delivered');

    await expect(
      ds.query(`UPDATE order_events SET data = '{}' WHERE order_id = $1`, [
        order.id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      ds.query('DELETE FROM order_events WHERE order_id = $1', [order.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      ds.query('UPDATE ledger_entries SET amount = 0 WHERE order_id = $1', [
        order.id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      ds.query('DELETE FROM ledger_entries WHERE order_id = $1', [order.id]),
    ).rejects.toThrow(/append-only/);

    // Recovery and the operator's retry write history too, not only the pass.
    await setStub(t, 'a', { timeoutRate: 1 });
    const parked = await t.createOrder();
    await pay(t, parked);
    await t.waitForStatus(parked.id, 'delivery_failed');
    await setStub(t, 'a', { timeoutRate: 0 });
    await t.api('POST', `/orders/${parked.id}/deliver`);
    await t.waitForStatus(parked.id, 'delivered');
    const history = (await t.api('GET', `/orders/${parked.id}/history`)).body;
    expect(
      history
        .filter((e: any) => e.type === 'order.status')
        .map((e: any) => [e.data.to, e.data.reason ?? null]),
    ).toEqual([
      ['paid', null],
      ['delivering', null],
      ['delivery_failed', null],
      ['paid', 'operator'],
      ['delivering', null],
      ['delivered', null],
    ]);
  });

  it('money at a moment and over a period is read from the history and adds up', async () => {
    const start = new Date().toISOString();
    const sold = await t.createOrder('STEAM-TOPUP-500');
    await pay(t, sold);
    await t.waitForStatus(sold.id, 'delivered');

    await sleep(20);
    const mid = new Date().toISOString();
    await sleep(20);

    await setStub(t, 'a', { unavailableSkus: ['KEY-EFT'] });
    await setStub(t, 'b', { unavailableSkus: ['KEY-EFT'] });
    const partial = await t.createOrder(['KEY-GTA5', 'KEY-EFT']);
    await pay(t, partial);
    await t.waitForStatus(partial.id, 'partially_delivered');

    await setStub(t, 'a', { timeoutRate: 1 });
    const stuck = await t.createOrder('KEY-CS2-PRIME');
    await pay(t, stuck);
    await t.waitForStatus(stuck.id, 'delivery_failed');
    await setStub(t, 'a', { timeoutRate: 0 });
    await sleep(20);
    const end = new Date().toISOString();

    // At `mid` only the first sale existed.
    expect(await money(`at=${mid}`)).toMatchObject({
      cash: 500,
      customerLiability: 0,
      revenue: 500,
      refunded: 0,
      total: 0,
    });
    // At `end`: 500 + 5480 + 1290 paid, 500 + 1990 delivered, 3490 refunded,
    // 1290 still owed for the parked order.
    expect(await money(`at=${end}`)).toMatchObject({
      cash: 500 + 5480 + 1290 - 3490,
      customerLiability: 1290,
      revenue: 2490,
      refunded: 3490,
      total: 0,
    });
    // ...which is exactly what the live ledger says right now.
    const live = (await t.api('GET', '/admin/reconciliation')).body.ledger;
    expect(await money(`at=${new Date().toISOString()}`)).toMatchObject({
      cash: live.cash,
      customerLiability: live.customerLiability,
      revenue: live.revenue,
      refunded: live.refunded,
    });

    // Period totals: the two halves add up to the whole, every period
    // reconciles with its opening and closing balances, and the events
    // tell the same story as the ledger.
    const first = await money(`from=${start}&to=${mid}`);
    const second = await money(`from=${mid}&to=${end}`);
    const whole = await money(`from=${start}&to=${end}`);
    expect(first.moved).toMatchObject({
      paid: 500,
      delivered: 500,
      refunded: 0,
      payments: 1,
    });
    expect(second.moved).toMatchObject({
      paid: 5480 + 1290,
      delivered: 1990,
      refunded: 3490,
      payments: 2,
      deliveries: 1,
      refunds: 1,
    });
    for (const key of [
      'paid',
      'delivered',
      'refunded',
      'payments',
      'deliveries',
      'refunds',
    ]) {
      expect(whole.moved[key]).toBe(first.moved[key] + second.moved[key]);
    }
    for (const period of [first, second, whole]) {
      expect(period.balanced).toBe(true);
      expect(period.eventsAgree).toBe(true);
    }
    expect(first.closing).toEqual(second.opening);
    expect(whole.closing.customerLiability).toBe(1290);

    // Settle the parked order; the past does not change.
    await t.api('POST', `/orders/${stuck.id}/deliver`);
    await t.waitForStatus(stuck.id, 'delivered');
    expect(await money(`at=${end}`)).toMatchObject({ customerLiability: 1290 });
    expect(await money(`from=${start}&to=${end}`)).toMatchObject(whole);
    await expectConsistent(t.app);
  });
});
