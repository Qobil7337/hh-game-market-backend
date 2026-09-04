import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  expectConsistent,
  issuedKeys,
  pay,
  paymentEvent,
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
  process.env.SUPPLIER_MAX_ATTEMPTS = '3';
  process.env.DELIVERY_POLL_INTERVAL_MS = '500';
  // Sweeps are triggered by hand in here; thresholds are long so nothing is
  // re-queued unless a test backdates it.
  process.env.RECOVERY_INTERVAL_MS = '3600000';
  process.env.DELIVERY_STALE_AFTER_MS = '5000';
  process.env.RECOVERY_RETRY_AFTER_MS = '5000';
  t = await startApp();
  ds = t.app.get(DataSource);
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await resetDatabase(t.app);
  await setStub(t, 'a', { errorRate: 0, timeoutRate: 0, hangMs: 1000 });
  await setStub(t, 'b', { errorRate: 0, timeoutRate: 0, hangMs: 1000 });
  process.env.DELIVERY_CONCURRENCY = '2';
});

const backdate = (orderId: string) =>
  ds.query(
    `UPDATE orders SET updated_at = now() - interval '1 hour' WHERE id = $1`,
    [orderId],
  );

describe('recovery sweep', () => {
  it('re-queues an order a crashed worker left in delivering', async () => {
    // No lanes: the paid order sits in the queue untouched...
    process.env.DELIVERY_CONCURRENCY = '0';
    const order = await t.createOrder();
    await pay(t, order);
    await sleep(300);
    expect((await t.api('GET', `/orders/${order.id}`)).body.status).toBe(
      'paid',
    );
    // ...which lets us fake a worker that claimed it and died an hour ago.
    await ds.query(
      `UPDATE orders SET status = 'delivering', updated_at = now() - interval '1 hour' WHERE id = $1`,
      [order.id],
    );

    const sweep = await t.api('POST', '/admin/recovery');
    expect(sweep.body).toEqual({ stale: [order.id], parked: [] });

    process.env.DELIVERY_CONCURRENCY = '2';
    const delivered = await t.waitForStatus(order.id, 'delivered');
    expect(delivered.delivery.supplier).toBe('a');
    await expectConsistent(t.app);
  });

  it('retries a parked order after the cooldown and resolves the timed-out supplier first', async () => {
    await setStub(t, 'a', { timeoutRate: 1 });
    const order = await t.createOrder();
    await pay(t, order);
    await t.waitForStatus(order.id, 'delivery_failed');
    const [held] = await issuedKeys(t.app, order.id);
    expect(held.supplier).toBe('a');
    await setStub(t, 'a', { timeoutRate: 0 });

    // Still inside the cooldown: left alone.
    expect((await t.api('POST', '/admin/recovery')).body).toEqual({
      stale: [],
      parked: [],
    });

    await backdate(order.id);
    expect((await t.api('POST', '/admin/recovery')).body).toEqual({
      stale: [],
      parked: [order.id],
    });

    const delivered = await t.waitForStatus(order.id, 'delivered');
    expect(delivered.delivery).toMatchObject({
      supplier: 'a',
      code: held.code,
    });
    expect(await issuedKeys(t.app, order.id)).toHaveLength(1);
    await expectConsistent(t.app);
  });

  it('leaves healthy and final orders alone', async () => {
    const delivered = await t.createOrder();
    await pay(t, delivered);
    await t.waitForStatus(delivered.id, 'delivered');
    const failed = await t.createOrder();
    await t.api(
      'POST',
      '/webhooks/payment',
      paymentEvent(failed, { status: 'failed' }),
    );
    await backdate(delivered.id);
    await backdate(failed.id);

    expect((await t.api('POST', '/admin/recovery')).body).toEqual({
      stale: [],
      parked: [],
    });
  });
});

describe('reconciliation and ledger', () => {
  it('reports outstanding money, unmatched events and balanced books', async () => {
    // One clean sale.
    const sold = await t.createOrder('STEAM-TOPUP-500');
    await pay(t, sold);
    await t.waitForStatus(sold.id, 'delivered');

    // One order parked on an ambiguous supplier: paid, not delivered, key held by A.
    await setStub(t, 'a', { timeoutRate: 1 });
    const parked = await t.createOrder('KEY-GTA5');
    await pay(t, parked);
    await t.waitForStatus(parked.id, 'delivery_failed');
    await setStub(t, 'a', { timeoutRate: 0 });

    // One event for an order we do not have, and one paid event after a failure.
    const ghost = paymentEvent({
      id: randomUUID(),
      amount: 1,
      currency: 'RUB',
    });
    await t.api('POST', '/webhooks/payment', ghost);
    const failed = await t.createOrder();
    await t.api(
      'POST',
      '/webhooks/payment',
      paymentEvent(failed, { status: 'failed' }),
    );
    const late = paymentEvent(failed);
    await t.api('POST', '/webhooks/payment', late);

    const { status, body } = await t.api('GET', '/admin/reconciliation');
    expect(status).toBe(200);
    expect(body.healthy).toBe(true);
    expect(body.counts).toEqual({
      paidNotDelivered: 1,
      deliveredNotPaid: 0,
      unmatchedEvents: 1,
      paidAfterFailure: 1,
      supplierKeysWithoutDelivery: 1,
      supplierCodeMismatches: 0,
    });
    expect(body.paidNotDelivered[0]).toMatchObject({
      id: parked.id,
      status: 'delivery_failed',
      amount: 1990,
    });
    expect(body.unmatchedEvents[0]).toMatchObject({
      eventId: ghost.event_id,
      outcome: 'order_not_found',
    });
    expect(body.paidAfterFailure[0].eventId).toBe(late.event_id);
    expect(body.supplierKeysWithoutDelivery[0]).toMatchObject({
      supplier: 'a',
      orderId: parked.id,
      status: 'delivery_failed',
    });
    expect(body.ledger).toMatchObject({
      cash: 500 + 1990,
      customerLiability: 1990,
      revenue: 500,
      total: 0,
      balanced: true,
    });

    // Recovery clears the outstanding position without touching the sale.
    await backdate(parked.id);
    await t.api('POST', '/admin/recovery');
    await t.waitForStatus(parked.id, 'delivered');

    const after = (await t.api('GET', '/admin/reconciliation')).body;
    expect(after.counts.paidNotDelivered).toBe(0);
    expect(after.counts.supplierKeysWithoutDelivery).toBe(0);
    expect(after.ledger).toMatchObject({
      cash: 2490,
      customerLiability: 0,
      revenue: 2490,
      total: 0,
      balanced: true,
    });
    await expectConsistent(t.app);
  });

  it('flags a delivered order that has no delivery row', async () => {
    const order = await t.createOrder();
    await pay(t, order);
    await t.waitForStatus(order.id, 'delivered');
    await ds.query('DELETE FROM deliveries WHERE order_id = $1', [order.id]);

    const { body } = await t.api('GET', '/admin/reconciliation');
    expect(body.healthy).toBe(false);
    expect(body.deliveredNotPaid).toEqual([
      { id: order.id, status: 'delivered', code: null },
    ]);
  });
});
