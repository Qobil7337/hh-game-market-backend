import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bookOf,
  expectConsistent,
  issuedKeys,
  pay,
  resetDatabase,
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
  process.env.SUPPLIER_MAX_ROUNDS = '3';
  process.env.RECOVERY_INTERVAL_MS = '3600000';
  process.env.SUPPLIER_AUDIT_INTERVAL_MS = '3600000';
  t = await startApp();
  ds = t.app.get(DataSource);
});

afterAll(async () => {
  await t.app.close();
});

const HONEST = {
  errorRate: 0,
  timeoutRate: 0,
  hangMs: 1000,
  unavailableSkus: [],
  duplicateRate: 0,
  foreignRate: 0,
  errorAfterIssueRate: 0,
};

beforeEach(async () => {
  await resetDatabase(t.app);
  await setStub(t, 'a', HONEST);
  await setStub(t, 'b', HONEST);
});

const outcomes = (order: any) =>
  order.attempts.map((a: any) => `${a.supplier}:${a.outcome}`);

const kinds = (order: any) => order.discrepancies.map((d: any) => d.kind);

describe('a supplier that cannot be trusted', () => {
  it('a code already handed to another customer is rejected; the supplier is asked again, then abandoned', async () => {
    const first = await t.createOrder('KEY-GTA5');
    await pay(t, first);
    const honest = await t.waitForStatus(first.id, 'delivered');
    const taken = honest.items[0].delivery.code;

    // From now on A books and answers only codes it has already issued.
    await setStub(t, 'a', { duplicateRate: 1 });
    const second = await t.createOrder('KEY-GTA5');
    await pay(t, second);

    const delivered = await t.waitForStatus(second.id, 'delivered');
    expect(delivered.items[0].delivery.supplier).toBe('b');
    expect(delivered.items[0].delivery.code).not.toBe(taken);
    // Three rounds with three different request_ids, each rejected by the
    // unique constraint on delivered codes; then the fallback.
    expect(outcomes(delivered)).toEqual([
      'a:ok',
      'a:rejected',
      'a:ok',
      'a:rejected',
      'a:ok',
      'a:rejected',
      'b:ok',
    ]);
    const aRequests = new Set(
      delivered.attempts
        .filter((a: any) => a.supplier === 'a')
        .map((a: any) => a.requestId),
    );
    expect(aRequests.size).toBe(3);
    expect(kinds(delivered)).toEqual([
      'duplicate_code',
      'duplicate_code',
      'duplicate_code',
    ]);
    expect(
      delivered.discrepancies.every((d: any) => d.supplierCode === taken),
    ).toBe(true);
    // The first customer still holds their code, untouched.
    expect(
      (await t.api('GET', `/orders/${first.id}`)).body.items[0].delivery.code,
    ).toBe(taken);

    // The audit has nothing to add: every booked-but-unused entry is explained.
    expect((await t.api('POST', '/admin/supplier-audit')).body.found).toEqual(
      [],
    );
    await expectConsistent(t.app);
  });

  it('the answered code is not the booked one: the booked code is delivered, the other never leaves', async () => {
    await setStub(t, 'a', { foreignRate: 1 });
    const order = await t.createOrder('KEY-GTA5');
    await pay(t, order);

    const delivered = await t.waitForStatus(order.id, 'delivered');
    const [booked] = await bookOf(t.app, order.id);
    expect(booked.supplier).toBe('a');
    expect(delivered.items[0].delivery).toMatchObject({
      supplier: 'a',
      code: booked.code,
    });
    expect(kinds(delivered)).toEqual(['code_mismatch']);
    const [mismatch] = delivered.discrepancies;
    expect(mismatch.ourCode).toBe(booked.code);
    expect(mismatch.supplierCode).not.toBe(booked.code);
    // The foreign code is nowhere in our deliveries, and B's pool is untouched.
    const [{ count }] = await ds.query(
      'SELECT count(*)::int AS count FROM deliveries WHERE code = $1',
      [mismatch.supplierCode],
    );
    expect(count).toBe(0);
    expect((await issuedKeys(t.app, order.id)).map((k) => k.supplier)).toEqual([
      'a',
    ]);
    await expectConsistent(t.app);
  });

  it('5xx after booking: the book settles it, no second request and no fallback', async () => {
    await setStub(t, 'a', { errorAfterIssueRate: 1 });
    const order = await t.createOrder('KEY-GTA5');
    await pay(t, order);

    const delivered = await t.waitForStatus(order.id, 'delivered');
    const [booked] = await bookOf(t.app, order.id);
    expect(delivered.items[0].delivery).toMatchObject({
      supplier: 'a',
      code: booked.code,
    });
    expect(outcomes(delivered)).toEqual([
      'a:error',
      'a:error',
      'a:error',
      'a:ok', // taken from the book
    ]);
    expect(delivered.attempts.at(-1).detail).toMatch(/book lookup/);
    expect(kinds(delivered)).toEqual(['error_but_issued']);
    expect(await bookOf(t.app, order.id)).toHaveLength(1);
    await expectConsistent(t.app);
  });

  it('the audit finds what the delivery pass could not see, once', async () => {
    const sold = await t.createOrder('KEY-GTA5');
    await pay(t, sold);
    const delivered = await t.waitForStatus(sold.id, 'delivered');
    const [entry] = await bookOf(t.app, sold.id);

    await setStub(t, 'a', { unavailableSkus: ['KEY-EFT'] });
    await setStub(t, 'b', { unavailableSkus: ['KEY-EFT'] });
    const refunded = await t.createOrder('KEY-EFT');
    await pay(t, refunded);
    await t.waitForStatus(refunded.id, 'refunded');

    // Supplier-side facts appearing after the fact: a charge for a request we
    // never sent, a code booked late for a line we already refunded, and the
    // booked code of a delivered line changed under our feet.
    await ds.query(
      `INSERT INTO supplier_issues (request_id, supplier, code, order_id, sku)
       VALUES ('ghost-request', 'a', 'GHOST-0000-0001', 'ghost-order', 'KEY-GTA5'),
              ($1, 'a', 'LATE-0000-0001', $2, 'KEY-EFT')`,
      [
        `${(await t.api('GET', `/orders/${refunded.id}`)).body.items[0].id}:a`,
        refunded.id,
      ],
    );
    await ds.query(
      `UPDATE supplier_issues SET code = 'SWAP-0000-0001' WHERE request_id = $1`,
      [entry.requestId],
    );

    const audit = (await t.api('POST', '/admin/supplier-audit')).body;
    expect(audit.unreachable).toEqual([]);
    expect(audit.found.map((f: any) => f.kind).sort()).toEqual([
      'code_mismatch',
      'unknown_request',
      'unused_issue',
    ]);
    // Recorded once: a second run reports nothing new.
    expect((await t.api('POST', '/admin/supplier-audit')).body.found).toEqual(
      [],
    );

    const report = (await t.api('GET', '/admin/reconciliation')).body;
    expect(report.counts.supplierDiscrepancies).toBe(3);
    // The customer keeps the code they were given; the book now says
    // otherwise, which is the one supplier finding that makes the report
    // unhealthy until the dispute is settled.
    expect(report.counts.supplierCodeMismatches).toBe(1);
    expect(report.supplierCodeMismatches[0]).toMatchObject({
      bookedCode: 'SWAP-0000-0001',
      deliveredCode: delivered.items[0].delivery.code,
    });
    expect(report.healthy).toBe(false);
  });

  it('chaos: lying, failing and hanging suppliers — every delivered code is booked, none is delivered twice', async () => {
    const chaos = {
      errorRate: 0.2,
      timeoutRate: 0.1,
      hangMs: 400,
      duplicateRate: 0.25,
      foreignRate: 0.25,
      errorAfterIssueRate: 0.25,
    };
    await setStub(t, 'a', chaos);
    await setStub(t, 'b', chaos);
    const orders = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        t.createOrder(
          i % 2 === 0
            ? ['KEY-GTA5', 'SUB-YT-3M']
            : ['GIFT-PSN-1000', 'KEY-CS2-PRIME'],
        ),
      ),
    );
    await Promise.all(orders.map((order) => pay(t, order)));

    const finals = ['delivered', 'partially_delivered', 'refunded'];
    await Promise.all(
      orders.map((order) =>
        t.waitForStatus(order.id, [...finals, 'delivery_failed'], 90_000),
      ),
    );

    await setStub(t, 'a', HONEST);
    await setStub(t, 'b', HONEST);
    for (const order of orders) {
      const { body } = await t.api('GET', `/orders/${order.id}`);
      if (body.status === 'delivery_failed') {
        await t.api('POST', `/orders/${order.id}/deliver`);
      }
    }
    const settled = await Promise.all(
      orders.map((order) => t.waitForStatus(order.id, finals, 90_000)),
    );

    const codes: string[] = [];
    for (const order of settled) {
      expect(order.money.paid).toBe(
        order.money.delivered + order.money.refunded,
      );
      for (const item of order.items.filter((i: any) => i.delivery)) {
        codes.push(item.delivery.code);
        // The delivered code is exactly what that supplier booked for the
        // request_id it was delivered under.
        const [booked] = await ds.query(
          'SELECT code FROM supplier_issues WHERE supplier = $1 AND request_id = (SELECT request_id FROM deliveries WHERE order_item_id = $2)',
          [item.delivery.supplier, item.id],
        );
        expect(booked.code).toBe(item.delivery.code);
      }
    }
    expect(new Set(codes).size).toBe(codes.length);
    // Everything the suppliers got wrong was seen and written down as it happened.
    expect((await t.api('POST', '/admin/supplier-audit')).body.found).toEqual(
      [],
    );
    await expectConsistent(t.app);
  });
});
