import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pay, resetDatabase, startApp, type TestApp } from './helpers.js';

let t: TestApp;

beforeAll(async () => {
  t = await startApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(() => resetDatabase(t.app));

const skus = (page: any) => page.items.map((item: any) => item.sku);

describe('storefront', () => {
  it('lists active in-stock products, keyset-paginated by sku', async () => {
    const page1 = (await t.api('GET', '/products?limit=5')).body;
    expect(page1.items).toHaveLength(5);
    expect(page1.nextCursor).toBe(page1.items[4].sku);

    const page2 = (
      await t.api('GET', `/products?limit=5&cursor=${page1.nextCursor}`)
    ).body;
    const page3 = (
      await t.api('GET', `/products?limit=5&cursor=${page2.nextCursor}`)
    ).body;
    expect(page3.items).toHaveLength(2);
    expect(page3.nextCursor).toBeNull();

    const all = [...skus(page1), ...skus(page2), ...skus(page3)];
    expect(all).toEqual([...all].sort());
    expect(new Set(all).size).toBe(12);
    expect(page1.items[0]).toMatchObject({ available: 100, currency: 'RUB' });
  });

  it('filters by type', async () => {
    const { body } = await t.api('GET', '/products?type=key');
    expect(skus(body)).toEqual(['KEY-CS2-PRIME', 'KEY-EFT', 'KEY-GTA5']);
    expect(body.items.every((item: any) => item.type === 'key')).toBe(true);
  });

  it('rejects a bad page size', async () => {
    expect((await t.api('GET', '/products?limit=0')).status).toBe(400);
    expect((await t.api('GET', '/products?limit=101')).status).toBe(400);
  });

  it('decrements stock on delivery and hides a product once it runs out', async () => {
    const order = await t.createOrder('KEY-GTA5');
    await pay(t, order);
    await t.waitForStatus(order.id, 'delivered');

    const find = async () =>
      (await t.api('GET', '/products?type=key')).body.items.find(
        (item: any) => item.sku === 'KEY-GTA5',
      );
    expect((await find()).available).toBe(99);

    expect(
      (await t.api('PUT', '/admin/stock/KEY-GTA5', { available: 0 })).body,
    ).toEqual({ sku: 'KEY-GTA5', available: 0 });
    expect(await find()).toBeUndefined();

    await t.api('PUT', '/admin/stock/KEY-GTA5', { available: 3 });
    expect((await find()).available).toBe(3);
    expect(
      (await t.api('PUT', '/admin/stock/NOPE', { available: 3 })).status,
    ).toBe(404);
  });

  it('keeps walking the (type, sku) index with thousands of SKUs', async () => {
    const generated = (
      await t.api('POST', '/admin/catalog/generate', { count: 5000 })
    ).body;
    expect(generated).toEqual({ added: 5000, total: 5012 });

    const { body } = await t.api('GET', '/admin/explain?type=key&limit=50');
    const plan = body.plan.join('\n');
    expect(plan).toMatch(/Index Scan using products_type_sku_active_idx/);
    expect(plan).not.toMatch(/Seq Scan on products/);
    expect(plan).not.toMatch(/Seq Scan on product_stock/);

    const page = (await t.api('GET', '/products?type=key&limit=50')).body;
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
    expect(
      page.items.every(
        (item: any) => item.type === 'key' && item.available > 0,
      ),
    ).toBe(true);
    expect(skus(page)).toEqual([...skus(page)].sort());
  });
});
