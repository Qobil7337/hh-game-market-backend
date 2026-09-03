#!/usr/bin/env node
// Drives the supplier stubs' fault injection from the command line.
//
//   node scripts/stub.mjs a                          show config and stock
//   node scripts/stub.mjs a --error-rate 1           A answers 5xx to everything
//   node scripts/stub.mjs a --timeout-rate 1         A issues a code, then hangs
//   node scripts/stub.mjs a --error-rate 0.5 --timeout-rate 0.3 --hang-ms 8000
//   node scripts/stub.mjs a --reset                  back to healthy
//   node scripts/stub.mjs b --restock KEY-1,KEY-2    add keys to B's pool
import { parseArgs } from 'node:util';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', default: 'http://localhost:3000/api' },
    'error-rate': { type: 'string' },
    'timeout-rate': { type: 'string' },
    'hang-ms': { type: 'string' },
    reset: { type: 'boolean', default: false },
    restock: { type: 'string' },
  },
});

const supplier = positionals[0];
if (!supplier) {
  console.error('usage: node scripts/stub.mjs <a|b> [options]');
  process.exit(1);
}

async function api(method, path, body) {
  const response = await fetch(`${opts.base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const patch = {};
if (opts.reset) Object.assign(patch, { errorRate: 0, timeoutRate: 0 });
if (opts['error-rate'] !== undefined) {
  patch.errorRate = Number(opts['error-rate']);
}
if (opts['timeout-rate'] !== undefined) {
  patch.timeoutRate = Number(opts['timeout-rate']);
}
if (opts['hang-ms'] !== undefined) patch.hangMs = Number(opts['hang-ms']);

if (Object.keys(patch).length > 0) {
  const { status, body } = await api(
    'PUT',
    `/stubs/suppliers/${supplier}/config`,
    patch,
  );
  if (status !== 200) {
    console.error(body);
    process.exit(1);
  }
}

if (opts.restock) {
  const { body } = await api('POST', `/stubs/suppliers/${supplier}/keys`, {
    codes: opts.restock.split(','),
  });
  console.log('restock:', body);
}

const { status, body } = await api('GET', `/stubs/suppliers/${supplier}`);
if (status !== 200) {
  console.error(body);
  process.exit(1);
}
console.log(JSON.stringify(body, null, 2));
