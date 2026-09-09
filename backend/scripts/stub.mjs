#!/usr/bin/env node
// Drives the supplier stubs' fault injection from the command line.
//
//   node scripts/stub.mjs a                          show config and stock
//   node scripts/stub.mjs a --error-rate 1           A answers 5xx to everything
//   node scripts/stub.mjs a --timeout-rate 1         A issues a code, then hangs
//   node scripts/stub.mjs a --error-rate 0.5 --timeout-rate 0.3 --hang-ms 8000
//   node scripts/stub.mjs a --unavailable KEY-EFT    A answers out_of_stock for KEY-EFT
//   node scripts/stub.mjs a --duplicate-rate 1       A hands out codes it already issued
//   node scripts/stub.mjs a --foreign-rate 1         A books one code, answers with another
//   node scripts/stub.mjs a --error-after-issue-rate 1   A books the code, then answers 5xx
//   node scripts/stub.mjs a --reset                  back to healthy
//   node scripts/stub.mjs b --restock KEY-1,KEY-2    add keys to B's pool
//   node scripts/stub.mjs psp --error-rate 1         payment provider rejects refunds
import { parseArgs } from 'node:util';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', default: 'http://localhost:3000/api' },
    'error-rate': { type: 'string' },
    'timeout-rate': { type: 'string' },
    'hang-ms': { type: 'string' },
    unavailable: { type: 'string' },
    'duplicate-rate': { type: 'string' },
    'foreign-rate': { type: 'string' },
    'error-after-issue-rate': { type: 'string' },
    reset: { type: 'boolean', default: false },
    restock: { type: 'string' },
  },
});

const supplier = positionals[0];
if (!supplier) {
  console.error('usage: node scripts/stub.mjs <a|b|psp> [options]');
  process.exit(1);
}
// The payment provider stub has one knob and lives under its own path.
const path =
  supplier === 'psp' ? '/stubs/payments' : `/stubs/suppliers/${supplier}`;

async function api(method, path, body) {
  const response = await fetch(`${opts.base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const patch = {};
if (opts.reset) {
  Object.assign(
    patch,
    supplier === 'psp'
      ? { errorRate: 0 }
      : {
          errorRate: 0,
          timeoutRate: 0,
          unavailableSkus: [],
          duplicateRate: 0,
          foreignRate: 0,
          errorAfterIssueRate: 0,
        },
  );
}
for (const [flag, key] of [
  ['duplicate-rate', 'duplicateRate'],
  ['foreign-rate', 'foreignRate'],
  ['error-after-issue-rate', 'errorAfterIssueRate'],
]) {
  if (opts[flag] !== undefined) patch[key] = Number(opts[flag]);
}
if (opts['error-rate'] !== undefined) {
  patch.errorRate = Number(opts['error-rate']);
}
if (opts['timeout-rate'] !== undefined) {
  patch.timeoutRate = Number(opts['timeout-rate']);
}
if (opts['hang-ms'] !== undefined) patch.hangMs = Number(opts['hang-ms']);
if (opts.unavailable !== undefined) {
  patch.unavailableSkus = opts.unavailable ? opts.unavailable.split(',') : [];
}

if (Object.keys(patch).length > 0) {
  const { status, body } = await api('PUT', `${path}/config`, patch);
  if (status !== 200) {
    console.error(body);
    process.exit(1);
  }
}

if (opts.restock) {
  const { body } = await api('POST', `${path}/keys`, {
    codes: opts.restock.split(','),
  });
  console.log('restock:', body);
}

const { status, body } = await api('GET', path);
if (status !== 200) {
  console.error(body);
  process.exit(1);
}
console.log(JSON.stringify(body, null, 2));
