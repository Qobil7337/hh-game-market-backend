import { createServer, type AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  expectConsistent,
  issuedKeys,
  pay,
  resetDatabase,
  setStub,
  startApp,
  type TestApp,
} from './helpers.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let t: TestApp;

beforeAll(async () => {
  // Short client timeout and backoff so timeout scenarios take well under a second.
  process.env.SUPPLIER_TIMEOUT_MS = '250';
  process.env.SUPPLIER_RETRY_BASE_MS = '30';
  process.env.SUPPLIER_MAX_ATTEMPTS = '3';
  t = await startApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await resetDatabase(t.app);
  await setStub(t, 'a', { errorRate: 0, timeoutRate: 0, hangMs: 1000 });
  await setStub(t, 'b', { errorRate: 0, timeoutRate: 0, hangMs: 1000 });
});

// Resolves the moment the stub has committed a key for the order: from then on
// "issued, but the response never arrived" is the real state of the world.
async function waitForIssuedKey(orderId: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const keys = await issuedKeys(t.app, orderId);
    if (keys.length > 0) return keys;
    if (Date.now() > deadline) throw new Error('stub never issued a key');
    await sleep(20);
  }
}

const outcomes = (order: any) =>
  order.attempts.map((a: any) => `${a.supplier}:${a.outcome}`);

// A port that was just released, so connecting to it is refused. (Low ports
// like 1 cannot be used: fetch refuses them as "bad port" without connecting.)
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe('supplier timeouts, retries and fallback', () => {
  it('timeout trap: the supplier issued a code but the answer was lost; the retry gets that same code', async () => {
    await setStub(t, 'a', { timeoutRate: 1 });
    const order = await t.createOrder();
    await pay(t, order);

    // A has committed a key while our side is still waiting on a socket that
    // will time out. Then A recovers.
    const [issued] = await waitForIssuedKey(order.id);
    await setStub(t, 'a', { timeoutRate: 0 });

    const delivered = await t.waitForStatus(order.id, 'delivered');
    expect(delivered.items[0].delivery).toMatchObject({
      supplier: 'a',
      code: issued.code,
    });
    expect(await issuedKeys(t.app, order.id)).toHaveLength(1);

    const attempts = delivered.attempts;
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.every((a: any) => a.supplier === 'a')).toBe(true);
    expect(new Set(attempts.map((a: any) => a.requestId)).size).toBe(1);
    expect(attempts[0].outcome).toBe('timeout');
    expect(attempts.at(-1).outcome).toBe('ok');
    await expectConsistent(t.app);
  });

  it('unresolved timeouts park the order instead of falling back; a later retry still gets the original code', async () => {
    await setStub(t, 'a', { timeoutRate: 1 });
    const order = await t.createOrder();
    await pay(t, order);

    const parked = await t.waitForStatus(order.id, 'delivery_failed');
    expect(outcomes(parked)).toEqual([
      'a:timeout',
      'a:timeout',
      'a:timeout',
      'a:timeout', // the book lookup hangs too
    ]);
    // A holds a code for this order; B was never asked.
    const keys = await issuedKeys(t.app, order.id);
    expect(keys).toHaveLength(1);
    expect(keys[0].supplier).toBe('a');

    await setStub(t, 'a', { timeoutRate: 0 });
    expect((await t.api('POST', `/orders/${order.id}/deliver`)).status).toBe(
      200,
    );

    const delivered = await t.waitForStatus(order.id, 'delivered');
    expect(delivered.items[0].delivery).toMatchObject({
      supplier: 'a',
      code: keys[0].code,
    });
    expect(await issuedKeys(t.app, order.id)).toHaveLength(1);
    await expectConsistent(t.app);
  });

  it('A answers 5xx: retried with backoff, then falls back to B; exactly one code issued', async () => {
    await setStub(t, 'a', { errorRate: 1 });
    const order = await t.createOrder();
    await pay(t, order);

    const delivered = await t.waitForStatus(order.id, 'delivered');
    expect(delivered.items[0].delivery.supplier).toBe('b');
    // Before leaving A its book is checked: a 5xx may have booked a code.
    expect(outcomes(delivered)).toEqual([
      'a:error',
      'a:error',
      'a:error',
      'a:none_issued',
      'b:ok',
    ]);
    expect(delivered.attempts[0].detail).toBe('http_500 internal_error');

    const keys = await issuedKeys(t.app, order.id);
    expect(keys).toHaveLength(1);
    expect(keys[0].supplier).toBe('b');
    await expectConsistent(t.app);
  });

  it('A unreachable (connection refused): falls back to B', async () => {
    const url = process.env.SUPPLIER_A_URL;
    process.env.SUPPLIER_A_URL = `http://127.0.0.1:${await closedPort()}/nowhere`;
    try {
      const order = await t.createOrder();
      await pay(t, order);

      const delivered = await t.waitForStatus(order.id, 'delivered');
      expect(delivered.items[0].delivery.supplier).toBe('b');
      const aAttempts = delivered.attempts.filter(
        (a: any) => a.supplier === 'a',
      );
      expect(aAttempts).toHaveLength(3);
      for (const attempt of aAttempts) {
        expect(attempt.outcome).toBe('unreachable');
        expect(attempt.detail).toMatch(/ECONNREFUSED/);
      }
    } finally {
      process.env.SUPPLIER_A_URL = url;
    }
    await expectConsistent(t.app);
  });

  it('no stock anywhere: the order is refunded after one attempt per supplier', async () => {
    await t.app
      .get(DataSource)
      .query('DELETE FROM supplier_keys WHERE request_id IS NULL');
    const order = await t.createOrder();
    await pay(t, order);

    const refunded = await t.waitForStatus(order.id, 'refunded');
    // Out of stock is definitive, so no retries: one attempt per supplier.
    expect(outcomes(refunded)).toEqual(['a:out_of_stock', 'b:out_of_stock']);
    expect(refunded.items[0]).toMatchObject({
      status: 'refunded',
      delivery: null,
      refund: { amount: 1990, reason: 'out_of_stock' },
    });
    expect(refunded.money).toEqual({
      paid: 1990,
      delivered: 0,
      refunded: 1990,
      pending: 0,
    });

    // A final order stays final: a restock does not reopen it.
    const restock = await t.api('POST', '/stubs/suppliers/b/keys', {
      codes: ['TEST-0000-0001'],
    });
    expect(restock.body).toEqual({ added: 1, available: 1 });
    expect((await t.api('POST', `/orders/${order.id}/deliver`)).status).toBe(
      409,
    );
    await expectConsistent(t.app);
  });

  it('random 5xx and timeouts on both suppliers never issue two codes for one order', async () => {
    await setStub(t, 'a', { errorRate: 0.4, timeoutRate: 0.3, hangMs: 400 });
    await setStub(t, 'b', { errorRate: 0.3, timeoutRate: 0.2, hangMs: 400 });
    const orders = await Promise.all(
      Array.from({ length: 15 }, () => t.createOrder()),
    );
    await Promise.all(orders.map((order) => pay(t, order)));

    // Definitive failures on both suppliers refund the order; that is rare at
    // these rates but legitimate, so it is an accepted end state here.
    const settled = await Promise.all(
      orders.map((order) =>
        t.waitForStatus(
          order.id,
          ['delivered', 'refunded', 'delivery_failed'],
          30_000,
        ),
      ),
    );
    for (const order of settled) {
      const keys = await issuedKeys(t.app, order.id);
      expect(keys.length).toBeLessThanOrEqual(1);
      if (order.status === 'delivered') {
        expect(keys).toHaveLength(1);
        expect(keys[0].code).toBe(order.items[0].delivery.code);
      } else {
        expect(order.items[0].delivery).toBeNull();
      }
    }

    // Heal both suppliers and retry whatever got parked. Orders that timed out
    // on one supplier must go back to that supplier and get the code it holds.
    await setStub(t, 'a', { errorRate: 0, timeoutRate: 0 });
    await setStub(t, 'b', { errorRate: 0, timeoutRate: 0 });
    for (const order of settled.filter((o) => o.status === 'delivery_failed')) {
      expect((await t.api('POST', `/orders/${order.id}/deliver`)).status).toBe(
        200,
      );
    }

    const finals = await Promise.all(
      orders.map((order) =>
        t.waitForStatus(order.id, ['delivered', 'refunded'], 30_000),
      ),
    );
    const delivered = finals.filter((f) => f.status === 'delivered');
    expect(new Set(delivered.map((f) => f.items[0].delivery.code)).size).toBe(
      delivered.length,
    );
    for (const order of finals) {
      expect(await issuedKeys(t.app, order.id)).toHaveLength(
        order.status === 'delivered' ? 1 : 0,
      );
    }
    await expectConsistent(t.app);
  });
});
