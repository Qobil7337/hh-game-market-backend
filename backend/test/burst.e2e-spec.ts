import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bookOf,
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

// Supplier A accepts 4 requests per 2-second window; B is unlimited. One
// delivery costs two requests (issue + book check), so A hands out at most
// two codes per window.
const WINDOW_MS = 2000;
const LIMIT = 4;

beforeAll(async () => {
  process.env.SUPPLIER_TIMEOUT_MS = '1000';
  process.env.SUPPLIER_RETRY_BASE_MS = '30';
  process.env.SUPPLIER_RATE_WINDOW_MS = String(WINDOW_MS);
  process.env.SUPPLIER_A_RATE_LIMIT = String(LIMIT);
  process.env.SUPPLIER_B_RATE_LIMIT = '0';
  process.env.DELIVERY_POLL_INTERVAL_MS = '250';
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
  process.env.DELIVERY_CONCURRENCY = '4';
  // The stub enforces the same limit and counts what it saw.
  await setStub(t, 'a', { rateLimit: LIMIT, rateWindowMs: WINDOW_MS });
  await setStub(t, 'b', { rateLimit: 0 });
});

const stubCalls = async (supplier: string) =>
  (await t.api('GET', `/stubs/suppliers/${supplier}`)).body.calls;

const queue = async () => (await t.api('GET', '/admin/queue')).body;

describe('burst of orders against a rate-limited supplier', () => {
  it('queues what the limit cannot take, drains it, loses nothing and never exceeds the limit', async () => {
    const orders = await Promise.all(
      Array.from({ length: 12 }, () => t.createOrder('KEY-GTA5')),
    );
    await Promise.all(orders.map((order) => pay(t, order)));

    // Progress is visible while the burst drains.
    await sleep(WINDOW_MS / 2);
    const during = await queue();
    const { queued, waitingForSlot, delivering, delivered } = during.orders;
    expect(queued + waitingForSlot + delivering + delivered).toBe(12);
    expect(delivered).toBeLessThan(12);
    expect(waitingForSlot).toBeGreaterThan(0);
    expect(during.suppliers.a).toMatchObject({
      limit: LIMIT,
      windowMs: WINDOW_MS,
    });
    expect(during.suppliers.a.used).toBeLessThanOrEqual(LIMIT);

    await Promise.all(
      orders.map((order) => t.waitForStatus(order.id, 'delivered', 40_000)),
    );
    const after = await queue();
    expect(after.orders).toMatchObject({
      queued: 0,
      waitingForSlot: 0,
      delivering: 0,
      delivered: 12,
    });

    // The supplier's own count: nothing turned away, never more than the
    // limit inside one window.
    const calls = await stubCalls('a');
    expect(calls.rejected).toBe(0);
    expect(calls.peakInWindow).toBeLessThanOrEqual(LIMIT);
    expect(calls.total).toBeGreaterThanOrEqual(24);
    await expectConsistent(t.app);
  }, 60_000);

  it('serves paid orders in the order they were paid; unpaid ones never reach the supplier', async () => {
    // One lane, so the queue order is the delivery order.
    process.env.DELIVERY_CONCURRENCY = '1';
    const orders = await Promise.all(
      Array.from({ length: 6 }, () => t.createOrder('KEY-GTA5')),
    );
    const unpaid = orders.slice(0, 2);
    const paid = orders.slice(2).reverse();
    for (const order of paid) {
      await pay(t, order);
      await sleep(30);
    }

    expect((await queue()).orders.awaitingPayment).toBe(2);
    const settled = await Promise.all(
      paid.map((order) => t.waitForStatus(order.id, 'delivered', 40_000)),
    );

    const byDeliveryTime = [...settled].sort(
      (x, y) =>
        new Date(x.items[0].delivery.deliveredAt).getTime() -
        new Date(y.items[0].delivery.deliveredAt).getTime(),
    );
    expect(byDeliveryTime.map((o) => o.id)).toEqual(paid.map((o) => o.id));

    for (const order of unpaid) {
      expect((await t.api('GET', `/orders/${order.id}`)).body.status).toBe(
        'created',
      );
      expect(await bookOf(t.app, order.id)).toEqual([]);
    }
    expect((await stubCalls('a')).rejected).toBe(0);
    await expectConsistent(t.app);
  }, 60_000);

  it("one supplier's limit does not hold the other's orders back", async () => {
    await setStub(t, 'a', { rateLimit: 2, rateWindowMs: WINDOW_MS });
    process.env.SUPPLIER_A_RATE_LIMIT = '2';
    try {
      const forA = await Promise.all(
        Array.from({ length: 4 }, () => t.createOrder('KEY-GTA5')),
      );
      const forB = await Promise.all(
        Array.from({ length: 4 }, () => t.createOrder('SUB-YT-3M')),
      );
      await Promise.all([...forA, ...forB].map((order) => pay(t, order)));

      // B's orders are all out within a window; A's are still queuing.
      await Promise.all(
        forB.map((order) => t.waitForStatus(order.id, 'delivered', 5_000)),
      );
      const [{ count }] = await ds.query(
        `SELECT count(*)::int AS count FROM orders WHERE id = ANY($1) AND status = 'delivered'`,
        [forA.map((o) => o.id)],
      );
      expect(count).toBeLessThan(4);

      await Promise.all(
        forA.map((order) => t.waitForStatus(order.id, 'delivered', 40_000)),
      );
      expect((await stubCalls('a')).rejected).toBe(0);
      expect((await stubCalls('a')).peakInWindow).toBeLessThanOrEqual(2);
      await expectConsistent(t.app);
    } finally {
      process.env.SUPPLIER_A_RATE_LIMIT = String(LIMIT);
    }
  }, 60_000);

  it('a queued order survives a restart: the queue is the table', async () => {
    const orders = await Promise.all(
      Array.from({ length: 6 }, () => t.createOrder('KEY-GTA5')),
    );
    await Promise.all(orders.map((order) => pay(t, order)));
    await sleep(WINDOW_MS / 2);
    // Some are waiting for a slot: paid, with a not_before in the future.
    const [{ waiting }] = await ds.query(
      `SELECT count(*)::int AS waiting FROM orders WHERE status = 'paid' AND not_before > now()`,
    );
    expect(waiting).toBeGreaterThan(0);

    // A second instance sharing the database picks them up in its turn.
    const other = await startApp();
    try {
      await Promise.all(
        orders.map((order) =>
          other.waitForStatus(order.id, 'delivered', 40_000),
        ),
      );
    } finally {
      await other.app.close();
    }
    expect((await stubCalls('a')).rejected).toBe(0);
    expect((await stubCalls('a')).peakInWindow).toBeLessThanOrEqual(LIMIT);
    await expectConsistent(t.app);
  }, 60_000);
});
