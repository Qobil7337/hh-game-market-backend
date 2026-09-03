import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  expectConsistent,
  paymentEvent,
  resetDatabase,
  startApp,
  type ApiResponse,
  type TestApp,
} from './helpers.js';

const tally = (results: ApiResponse[]) =>
  results.reduce<Record<string, number>>((acc, { status, body }) => {
    const key = status === 200 ? body.result : `http_${status}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

const shuffle = <T>(items: T[]) =>
  items
    .map((item) => [Math.random(), item] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item);

const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

describe('exactly-once under concurrent webhooks', () => {
  // Two independent app instances (two delivery workers) on one database.
  let a: TestApp;
  let b: TestApp;

  // Every request goes to one of the two instances, all at the same time.
  const fire = (events: unknown[]) =>
    Promise.all(
      events.map((event, i) =>
        (i % 2 === 0 ? a : b).api('POST', '/webhooks/payment', event),
      ),
    );

  beforeAll(async () => {
    a = await startApp();
    b = await startApp();
  });

  afterAll(async () => {
    await Promise.all([a.app.close(), b.app.close()]);
  });

  beforeEach(() => resetDatabase(a.app));

  it('50 redeliveries of the same event_id: one applied, 49 duplicates, one delivery', async () => {
    const order = await a.createOrder();
    const event = paymentEvent(order);

    const results = await fire(Array.from({ length: 50 }, () => event));

    expect(tally(results)).toEqual({ applied: 1, duplicate: 49 });
    const delivered = await a.waitForStatus(order.id, 'delivered');
    expect(delivered.delivery.code).toMatch(CODE);
    await expectConsistent(a.app);
  });

  it('50 distinct paid events for one order: one applied, the rest ignored, one delivery', async () => {
    const order = await a.createOrder();

    const results = await fire(
      Array.from({ length: 50 }, () => paymentEvent(order)),
    );

    const counts = tally(results);
    expect(counts.applied).toBe(1);
    const others = Object.keys(counts).filter((key) => key !== 'applied');
    expect(others.every((key) => key.startsWith('ignored_'))).toBe(true);
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(50);

    await a.waitForStatus(order.id, 'delivered');
    await expectConsistent(a.app);
  });

  it('paid and failed events racing: exactly one wins, the order settles in one world', async () => {
    const order = await a.createOrder();
    const events = shuffle([
      ...Array.from({ length: 25 }, () => paymentEvent(order)),
      ...Array.from({ length: 25 }, () =>
        paymentEvent(order, { status: 'failed' }),
      ),
    ]);

    const results = await fire(events);

    expect(tally(results).applied).toBe(1);
    const final = await a.waitForStatus(order.id, [
      'delivered',
      'payment_failed',
    ]);
    if (final.status === 'delivered') {
      expect(final.delivery.code).toMatch(CODE);
    } else {
      expect(final.delivery).toBeNull();
    }
    await expectConsistent(a.app);
  });

  it('out of order: failed after delivery changes nothing; paid after failure delivers nothing', async () => {
    const first = await a.createOrder();
    await a.api('POST', '/webhooks/payment', paymentEvent(first));
    const delivered = await a.waitForStatus(first.id, 'delivered');
    const lateFailure = await b.api(
      'POST',
      '/webhooks/payment',
      paymentEvent(first, { status: 'failed' }),
    );
    expect(lateFailure.body).toEqual({ result: 'ignored_delivered' });
    expect((await a.api('GET', `/orders/${first.id}`)).body).toMatchObject({
      status: 'delivered',
      delivery: { code: delivered.delivery.code },
    });

    const second = await a.createOrder();
    await a.api(
      'POST',
      '/webhooks/payment',
      paymentEvent(second, { status: 'failed' }),
    );
    const latePayment = await b.api(
      'POST',
      '/webhooks/payment',
      paymentEvent(second),
    );
    expect(latePayment.body).toEqual({ result: 'ignored_payment_failed' });
    expect((await a.api('GET', `/orders/${second.id}`)).body).toMatchObject({
      status: 'payment_failed',
      delivery: null,
    });

    await expectConsistent(a.app);
  });

  it('20 orders x 5 webhooks each, all at once across both instances: every order delivered once with its own code', async () => {
    const orders = await Promise.all(
      Array.from({ length: 20 }, () => a.createOrder()),
    );
    // Per order: one event redelivered three times plus two distinct events.
    const events = shuffle(
      orders.flatMap((order) => {
        const redelivered = paymentEvent(order);
        return [
          redelivered,
          redelivered,
          redelivered,
          paymentEvent(order),
          paymentEvent(order),
        ];
      }),
    );

    const results = await fire(events);

    expect(tally(results).applied).toBe(20);
    const finals = await Promise.all(
      orders.map((order) => a.waitForStatus(order.id, 'delivered')),
    );
    const codes = new Set(finals.map((final) => final.delivery.code));
    expect(codes.size).toBe(20);
    await expectConsistent(a.app);
  });
});
