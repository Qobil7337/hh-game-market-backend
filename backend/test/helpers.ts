import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { expect } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { SeedService } from '../src/seed/seed.service.js';

export interface OrderRef {
  id: string;
  amount: number;
  currency: string;
}

export interface ApiResponse {
  status: number;
  // Response bodies are asserted with toEqual/toMatchObject, so `any` is fine here.
  body: any;
}

export interface TestApp {
  app: NestFastifyApplication;
  baseUrl: string;
  api(method: string, path: string, body?: unknown): Promise<ApiResponse>;
  createOrder(sku?: string): Promise<OrderRef>;
  waitForStatus(
    orderId: string,
    expected: string | string[],
    timeoutMs?: number,
  ): Promise<any>;
}

// Boots the whole AppModule on a random port. Every call is an independent
// instance with its own delivery worker; two of them share nothing but the
// database, exactly like two replicas behind a load balancer.
export async function startApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');

  const { port } = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}/api`;
  // Point the delivery worker at the stubs served by this instance.
  process.env.SUPPLIER_A_URL = `${baseUrl}/stubs/suppliers/a`;
  process.env.SUPPLIER_B_URL = `${baseUrl}/stubs/suppliers/b`;

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      // Fastify rejects a JSON content-type with an empty body, so only send it
      // alongside one.
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const createOrder = async (sku = 'KEY-GTA5') => {
    const { status, body } = await api('POST', '/orders', { sku });
    expect(status).toBe(201);
    return body as OrderRef;
  };

  const waitForStatus = async (
    orderId: string,
    expected: string | string[],
    timeoutMs = 10_000,
  ) => {
    const accepted = Array.isArray(expected) ? expected : [expected];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { body } = await api('GET', `/orders/${orderId}`);
      if (accepted.includes(body.status)) return body;
      if (Date.now() > deadline) {
        throw new Error(
          `order ${orderId} is ${body.status}, expected ${accepted.join('|')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  return { app, baseUrl, api, createOrder, waitForStatus };
}

export async function resetDatabase(app: NestFastifyApplication) {
  await app
    .get(DataSource)
    .query(
      'TRUNCATE TABLE orders, payment_events, deliveries, delivery_attempts, supplier_keys RESTART IDENTITY CASCADE',
    );
  await app.get(SeedService).seed();
}

export function paymentEvent(
  order: OrderRef,
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

export async function pay(t: TestApp, order: OrderRef) {
  const { body } = await t.api(
    'POST',
    '/webhooks/payment',
    paymentEvent(order),
  );
  expect(body).toEqual({ result: 'applied' });
}

export async function setStub(
  t: TestApp,
  supplier: string,
  config: { errorRate?: number; timeoutRate?: number; hangMs?: number },
) {
  const { status } = await t.api(
    'PUT',
    `/stubs/suppliers/${supplier}/config`,
    config,
  );
  expect(status).toBe(200);
}

// Keys the stubs have handed out for this order, across both suppliers.
export function issuedKeys(
  app: NestFastifyApplication,
  orderId: string,
): Promise<{ supplier: string; code: string; requestId: string }[]> {
  return app
    .get(DataSource)
    .query(
      'SELECT supplier, code, request_id AS "requestId" FROM supplier_keys WHERE order_id = $1 ORDER BY issued_at',
      [orderId],
    );
}

// What "exactly once, nothing lost" boils down to, checked straight in the
// database once every order in the test has settled. Only valid while the
// supplier is healthy: every paid order must then end up delivered.
export async function expectConsistent(app: NestFastifyApplication) {
  const [counts] = await app.get(DataSource).query(`
    SELECT
      (SELECT count(*) FROM orders WHERE status = 'delivered')::int AS delivered,
      (SELECT count(*) FROM orders WHERE status IN ('paid', 'delivering'))::int AS in_flight,
      (SELECT count(*) FROM deliveries)::int AS deliveries,
      (SELECT count(DISTINCT code) FROM deliveries)::int AS distinct_codes,
      (SELECT count(*) FROM supplier_keys WHERE request_id IS NOT NULL)::int AS issued_keys,
      (SELECT count(*) FROM payment_events WHERE status = 'paid' AND outcome = 'applied')::int AS applied_paid
  `);

  expect(counts.in_flight).toBe(0);
  // One delivery row per delivered order, each with its own code.
  expect(counts.deliveries).toBe(counts.delivered);
  expect(counts.distinct_codes).toBe(counts.deliveries);
  // No key was consumed at the supplier without reaching an order.
  expect(counts.issued_keys).toBe(counts.deliveries);
  // Exactly one paid event was honoured per delivered order.
  expect(counts.applied_paid).toBe(counts.delivered);
}
