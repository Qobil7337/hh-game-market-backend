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
  // One sku, or a list of skus (repeats allowed) for a multi-item order.
  createOrder(skus?: string | string[]): Promise<OrderRef>;
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
  process.env.PSP_URL = `${baseUrl}/stubs/payments`;
  // Unlimited unless a test says otherwise, whatever backend/.env holds.
  process.env.SUPPLIER_RATE_LIMIT ??= '0';
  process.env.STUB_A_RATE_LIMIT ??= '0';
  process.env.STUB_B_RATE_LIMIT ??= '0';

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

  const createOrder = async (skus: string | string[] = 'KEY-GTA5') => {
    const payload = Array.isArray(skus)
      ? { items: skus.map((sku) => ({ sku })) }
      : { sku: skus };
    const { status, body } = await api('POST', '/orders', payload);
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
      'TRUNCATE TABLE orders, order_items, payment_events, deliveries, delivery_attempts, refunds, ledger_entries, supplier_discrepancies, supplier_calls, supplier_keys, supplier_issues, psp_refunds, products, product_stock RESTART IDENTITY CASCADE',
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
  config: {
    errorRate?: number;
    timeoutRate?: number;
    hangMs?: number;
    unavailableSkus?: string[];
    duplicateRate?: number;
    foreignRate?: number;
    errorAfterIssueRate?: number;
    rateLimit?: number;
    rateWindowMs?: number;
  },
) {
  const { status } = await t.api(
    'PUT',
    `/stubs/suppliers/${supplier}/config`,
    config,
  );
  expect(status).toBe(200);
}

export async function setPsp(t: TestApp, config: { errorRate?: number }) {
  const { status } = await t.api('PUT', '/stubs/payments/config', config);
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

// The suppliers' books for this order: what they say they issued, per request_id.
export function bookOf(
  app: NestFastifyApplication,
  orderId: string,
): Promise<{ supplier: string; code: string; requestId: string }[]> {
  return app
    .get(DataSource)
    .query(
      'SELECT supplier, code, request_id AS "requestId" FROM supplier_issues WHERE order_id = $1 ORDER BY issued_at',
      [orderId],
    );
}

// What "exactly once, nothing lost, money adds up" boils down to, checked
// straight in the database once every order in the test has settled.
export async function expectConsistent(app: NestFastifyApplication) {
  const [counts] = await app.get(DataSource).query(`
    SELECT
      (SELECT count(*) FROM orders WHERE status IN ('paid', 'delivering'))::int AS in_flight,
      (SELECT count(*) FROM orders WHERE status NOT IN ('created', 'payment_failed'))::int AS paid_orders,
      (SELECT count(*) FROM order_items WHERE status = 'delivered')::int AS delivered_items,
      (SELECT count(*) FROM order_items WHERE status = 'refunded')::int AS refunded_items,
      (SELECT count(*) FROM deliveries)::int AS deliveries,
      (SELECT count(DISTINCT code) FROM deliveries)::int AS distinct_codes,
      (SELECT count(*) FROM deliveries d WHERE NOT EXISTS (
         SELECT 1 FROM supplier_issues k
         WHERE k.supplier = d.supplier AND k.request_id = d.request_id AND k.code = d.code))::int AS deliveries_not_in_book,
      (SELECT count(*) FROM supplier_issues k WHERE NOT EXISTS (
         SELECT 1 FROM deliveries d WHERE d.request_id = k.request_id))::int AS book_without_delivery,
      (SELECT count(DISTINCT (supplier, request_id)) FROM supplier_discrepancies
         WHERE kind IN ('duplicate_code', 'unused_issue', 'unknown_request'))::int AS explained_issues,
      (SELECT count(*) FROM refunds)::int AS refunds,
      (SELECT count(*) FROM psp_refunds)::int AS psp_refunds,
      (SELECT count(*) FROM payment_events WHERE status = 'paid' AND outcome = 'applied')::int AS applied_paid,
      (SELECT coalesce(sum(amount), 0) FROM ledger_entries)::int AS ledger_total,
      (SELECT coalesce(-sum(amount) FILTER (WHERE account = 'revenue'), 0) FROM ledger_entries)::int AS revenue,
      (SELECT coalesce(-sum(amount) FILTER (WHERE account = 'cash' AND reason = 'refund'), 0) FROM ledger_entries)::int AS refunded,
      (SELECT coalesce(sum(amount), 0) FROM order_items WHERE status = 'delivered')::int AS delivered_amount,
      (SELECT coalesce(sum(amount), 0) FROM refunds)::int AS refunded_amount,
      (SELECT coalesce(sum(amount), 0) FROM psp_refunds)::int AS psp_refunded_amount,
      (SELECT count(*) FROM orders o WHERE o.status NOT IN ('created', 'payment_failed')
         AND o.amount <> (SELECT sum(i.amount) FROM order_items i
                          WHERE i.order_id = o.id AND i.status IN ('delivered', 'refunded', 'pending', 'refunding')))::int AS unbalanced_orders,
      (SELECT count(*) FROM orders o WHERE o.status IN ('delivered', 'partially_delivered', 'refunded')
         AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.status IN ('pending', 'refunding')))::int AS final_with_open_items
  `);

  expect(counts.in_flight).toBe(0);
  // One delivery row per delivered item, each with its own code.
  expect(counts.deliveries).toBe(counts.delivered_items);
  expect(counts.distinct_codes).toBe(counts.deliveries);
  // Every delivered code is what its supplier booked under our request_id, and
  // every booked code we did not deliver has a recorded discrepancy saying why.
  // Only valid once every order has settled: an ambiguous timeout leaves a
  // booked code behind until the retry collects it.
  expect(counts.deliveries_not_in_book).toBe(0);
  expect(counts.book_without_delivery).toBe(counts.explained_issues);
  // Exactly one paid event was honoured per paid order.
  expect(counts.applied_paid).toBe(counts.paid_orders);
  // One refund per refunded item, and the provider saw each of them once.
  expect(counts.refunds).toBe(counts.refunded_items);
  expect(counts.psp_refunds).toBe(counts.refunded_items);
  expect(counts.psp_refunded_amount).toBe(counts.refunded_amount);
  // The ledger sums to zero, recognised revenue equals what was delivered and
  // refunded cash equals what was refunded.
  expect(counts.ledger_total).toBe(0);
  expect(counts.revenue).toBe(counts.delivered_amount);
  expect(counts.refunded).toBe(counts.refunded_amount);
  // Per order: paid = delivered + refunded + still open, and nothing is open
  // once the order is final.
  expect(counts.unbalanced_orders).toBe(0);
  expect(counts.final_with_open_items).toBe(0);
}
