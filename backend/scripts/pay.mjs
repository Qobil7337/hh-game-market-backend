#!/usr/bin/env node
// Stand-in for the payment provider. Creates an order (or takes an existing one)
// and sends N "paid" webhooks for it at the same time, then reports how the API
// answered each one and where the order ended up.
//
//   node scripts/pay.mjs                        pay a fresh KEY-GTA5 order once
//   node scripts/pay.mjs --n 50                 50 redeliveries of one event_id
//   node scripts/pay.mjs --n 50 --distinct      50 different event_ids, same order
//   node scripts/pay.mjs --status failed        send a failed event instead
//   node scripts/pay.mjs --order <id>           target an existing order
//   node scripts/pay.mjs --base http://host:port/api
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:3000/api' },
    sku: { type: 'string', default: 'KEY-GTA5' },
    order: { type: 'string' },
    n: { type: 'string', default: '1' },
    status: { type: 'string', default: 'paid' },
    distinct: { type: 'boolean', default: false },
  },
});

async function api(method, path, body) {
  const response = await fetch(`${opts.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const order = opts.order
  ? (await api('GET', `/orders/${opts.order}`)).body
  : (await api('POST', '/orders', { sku: opts.sku })).body;

if (!order.id) {
  console.error('could not get an order:', order);
  process.exit(1);
}
console.log(
  `order ${order.id}  ${order.sku}  ${order.amount} ${order.currency}  status=${order.status}`,
);

const n = Number(opts.n);
const sharedEventId = `evt_${randomUUID()}`;
const events = Array.from({ length: n }, () => ({
  event_id: opts.distinct ? `evt_${randomUUID()}` : sharedEventId,
  order_id: order.id,
  status: opts.status,
  amount: order.amount,
  currency: order.currency,
  created_at: new Date().toISOString(),
}));

const started = performance.now();
const results = await Promise.all(
  events.map((event) => api('POST', '/webhooks/payment', event)),
);
const elapsed = Math.round(performance.now() - started);

const tally = {};
for (const { status, body } of results) {
  const key = status === 200 ? body.result : `http_${status}`;
  tally[key] = (tally[key] ?? 0) + 1;
}
console.log(`${n} webhook(s) in ${elapsed}ms:`, tally);

const finalStates = new Set([
  'delivered',
  'payment_failed',
  'out_of_stock',
  'delivery_failed',
]);
const deadline = Date.now() + 15_000;
let current = order;
while (!finalStates.has(current.status) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  current = (await api('GET', `/orders/${order.id}`)).body;
}

const delivery = current.delivery
  ? `  code=${current.delivery.code}  supplier=${current.delivery.supplier}`
  : '';
console.log(`final status=${current.status}${delivery}`);
