import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  paymentEvent,
  resetDatabase,
  startApp,
  type TestApp,
} from './helpers.js';

let t: TestApp;

beforeAll(async () => {
  t = await startApp();
  await resetDatabase(t.app);
});

afterAll(async () => {
  await t.app.close();
});

describe('order lifecycle', () => {
  it('creates an order with the catalog price snapshot', async () => {
    const order = await t.createOrder('STEAM-TOPUP-500');
    expect(order).toMatchObject({ amount: 500, currency: 'RUB' });
    expect((await t.api('GET', `/orders/${order.id}`)).body.status).toBe(
      'created',
    );
  });

  it('rejects an unknown sku', async () => {
    expect((await t.api('POST', '/orders', { sku: 'NOPE' })).status).toBe(404);
  });

  it('delivers a paid order: created -> paid -> delivering -> delivered', async () => {
    const order = await t.createOrder();

    const webhook = await t.api(
      'POST',
      '/webhooks/payment',
      paymentEvent(order),
    );
    expect(webhook).toEqual({ status: 200, body: { result: 'applied' } });

    const delivered = await t.waitForStatus(order.id, 'delivered');
    expect(delivered.delivery.supplier).toBe('a');
    expect(delivered.delivery.code).toMatch(
      /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
    );
  });

  it('marks the order payment_failed on a failed event', async () => {
    const order = await t.createOrder();
    const event = paymentEvent(order, { status: 'failed' });

    expect((await t.api('POST', '/webhooks/payment', event)).body).toEqual({
      result: 'applied',
    });
    expect((await t.api('GET', `/orders/${order.id}`)).body.status).toBe(
      'payment_failed',
    );
  });

  it('treats a redelivered event_id as a no-op', async () => {
    const order = await t.createOrder();
    const event = paymentEvent(order);

    expect((await t.api('POST', '/webhooks/payment', event)).body).toEqual({
      result: 'applied',
    });
    expect((await t.api('POST', '/webhooks/payment', event)).body).toEqual({
      result: 'duplicate',
    });

    const delivered = await t.waitForStatus(order.id, 'delivered');
    expect((await t.api('POST', '/webhooks/payment', event)).body).toEqual({
      result: 'duplicate',
    });
    expect((await t.api('GET', `/orders/${order.id}`)).body.delivery.code).toBe(
      delivered.delivery.code,
    );
  });

  it('ignores a second, distinct paid event for an order that already left created', async () => {
    const order = await t.createOrder();

    await t.api('POST', '/webhooks/payment', paymentEvent(order));
    await t.waitForStatus(order.id, 'delivered');

    const late = await t.api('POST', '/webhooks/payment', paymentEvent(order));
    expect(late.body).toEqual({ result: 'ignored_delivered' });
  });

  it('records an event for an unknown order without failing', async () => {
    const ghost = { id: randomUUID(), amount: 500, currency: 'RUB' };
    const unknown = await t.api(
      'POST',
      '/webhooks/payment',
      paymentEvent(ghost),
    );
    expect(unknown).toEqual({
      status: 200,
      body: { result: 'order_not_found' },
    });

    const garbage = await t.api(
      'POST',
      '/webhooks/payment',
      paymentEvent({ ...ghost, id: 'ord_00123' }),
    );
    expect(garbage).toEqual({
      status: 200,
      body: { result: 'order_not_found' },
    });
  });

  it('does not mark an order paid when the amount does not match', async () => {
    const order = await t.createOrder();
    const short = paymentEvent(order, { amount: order.amount - 1 });

    expect((await t.api('POST', '/webhooks/payment', short)).body).toEqual({
      result: 'amount_mismatch',
    });
    expect((await t.api('GET', `/orders/${order.id}`)).body.status).toBe(
      'created',
    );
  });
});
