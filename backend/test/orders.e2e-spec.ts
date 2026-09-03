import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { SeedService } from '../src/seed/seed.service.js';

let app: NestFastifyApplication;
let baseUrl: string;

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function createOrder(sku = 'KEY-GTA5') {
  const { status, body } = await api('POST', '/orders', { sku });
  expect(status).toBe(201);
  return body as { id: string; amount: number; currency: string };
}

function paymentEvent(
  order: { id: string; amount: number; currency: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    event_id: `evt_${randomUUID()}`,
    order_id: order.id,
    status: 'paid',
    amount: order.amount,
    currency: order.currency,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

async function waitForStatus(orderId: string, expected: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api('GET', `/orders/${orderId}`);
    if (body.status === expected) return body;
    if (Date.now() > deadline) {
      throw new Error(`order ${orderId} is ${body.status}, expected ${expected}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');

  const { port } = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api`;
  // Point the worker at the stub inside this very test app.
  process.env.SUPPLIER_A_URL = `${baseUrl}/stubs/suppliers/a`;

  await app
    .get(DataSource)
    .query(
      'TRUNCATE TABLE orders, payment_events, deliveries, supplier_keys RESTART IDENTITY CASCADE',
    );
  await app.get(SeedService).seed();
});

afterAll(async () => {
  await app.close();
});

describe('order lifecycle', () => {
  it('creates an order with the catalog price snapshot', async () => {
    const order = await createOrder('STEAM-TOPUP-500');
    expect(order).toMatchObject({ amount: 500, currency: 'RUB' });
    expect((await api('GET', `/orders/${order.id}`)).body.status).toBe('created');
  });

  it('rejects an unknown sku', async () => {
    expect((await api('POST', '/orders', { sku: 'NOPE' })).status).toBe(404);
  });

  it('delivers a paid order: created -> paid -> delivering -> delivered', async () => {
    const order = await createOrder();

    const webhook = await api('POST', '/webhooks/payment', paymentEvent(order));
    expect(webhook).toEqual({ status: 200, body: { result: 'applied' } });

    const delivered = await waitForStatus(order.id, 'delivered');
    expect(delivered.delivery.supplier).toBe('a');
    expect(delivered.delivery.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('marks the order payment_failed on a failed event', async () => {
    const order = await createOrder();
    const event = paymentEvent(order, { status: 'failed' });

    expect((await api('POST', '/webhooks/payment', event)).body).toEqual({ result: 'applied' });
    expect((await api('GET', `/orders/${order.id}`)).body.status).toBe('payment_failed');
  });

  it('treats a redelivered event_id as a no-op', async () => {
    const order = await createOrder();
    const event = paymentEvent(order);

    expect((await api('POST', '/webhooks/payment', event)).body).toEqual({ result: 'applied' });
    expect((await api('POST', '/webhooks/payment', event)).body).toEqual({ result: 'duplicate' });

    const delivered = await waitForStatus(order.id, 'delivered');
    expect((await api('POST', '/webhooks/payment', event)).body).toEqual({ result: 'duplicate' });
    expect((await api('GET', `/orders/${order.id}`)).body.delivery.code).toBe(delivered.delivery.code);
  });

  it('ignores a second, distinct paid event for an order that already left created', async () => {
    const order = await createOrder();

    await api('POST', '/webhooks/payment', paymentEvent(order));
    await waitForStatus(order.id, 'delivered');

    const late = await api('POST', '/webhooks/payment', paymentEvent(order));
    expect(late.body).toEqual({ result: 'ignored_delivered' });
  });

  it('records an event for an unknown order without failing', async () => {
    const ghost = { id: randomUUID(), amount: 500, currency: 'RUB' };
    const unknown = await api('POST', '/webhooks/payment', paymentEvent(ghost));
    expect(unknown).toEqual({ status: 200, body: { result: 'order_not_found' } });

    const garbage = await api('POST', '/webhooks/payment', paymentEvent({ ...ghost, id: 'ord_00123' }));
    expect(garbage).toEqual({ status: 200, body: { result: 'order_not_found' } });
  });

  it('does not mark an order paid when the amount does not match', async () => {
    const order = await createOrder();
    const short = paymentEvent(order, { amount: order.amount - 1 });

    expect((await api('POST', '/webhooks/payment', short)).body).toEqual({ result: 'amount_mismatch' });
    expect((await api('GET', `/orders/${order.id}`)).body.status).toBe('created');
  });
});
