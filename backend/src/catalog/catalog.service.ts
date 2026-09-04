import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { StorefrontQueryDto } from './dto/storefront-query.dto.js';
import { ProductStock } from './product-stock.entity.js';
import { Product } from './product.entity.js';

const TYPES = ['topup', 'key', 'subscription', 'giftcard'];

@Injectable()
export class CatalogService {
  constructor(private readonly dataSource: DataSource) {}

  // Storefront listing: active products that have stock, keyset-paginated by sku.
  // The cost is proportional to the page, not to the catalog: the planner walks
  // products_type_sku_active_idx in sku order and probes product_stock by primary
  // key for each candidate, stopping after `limit` hits.
  async storefront(query: StorefrontQueryDto) {
    const { sql, params } = this.storefrontQuery(query);
    const rows: { sku: string }[] = await this.dataSource.query(sql, params);

    const items = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit ? items.at(-1)!.sku : null;
    return { items, nextCursor };
  }

  async explain(query: StorefrontQueryDto) {
    const { sql, params } = this.storefrontQuery(query);
    const rows: { 'QUERY PLAN': string }[] = await this.dataSource.query(
      `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
      params,
    );
    return { sql, params, plan: rows.map((row) => row['QUERY PLAN']) };
  }

  private storefrontQuery({ type, cursor, limit }: StorefrontQueryDto) {
    // Clauses are added only when their parameter is present, so the planner
    // sees a plain equality/range on the indexed columns.
    const params: unknown[] = [];
    const where = ['p.active'];
    if (type) {
      params.push(type);
      where.push(`p.type = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor);
      where.push(`p.sku > $${params.length}`);
    }
    // One extra row tells us whether there is a next page.
    params.push(limit + 1);

    // The stock lookup is a LATERAL subquery so the planner probes product_stock
    // by primary key once per candidate product and stops at the LIMIT. Written
    // as a plain JOIN it prefers a merge join, which walks product_stock from
    // the first row until it catches up with the products side: O(position in
    // the catalog) per page instead of O(page). LIMIT 1 is a no-op on a primary
    // key lookup; it only keeps the subquery from being pulled up into a join.
    const sql = `
      SELECT p.sku, p.name, p.type, p.price, p.currency, p.image, s.available
      FROM products p
      JOIN LATERAL (
        SELECT available FROM product_stock s
        WHERE s.sku = p.sku AND s.available > 0
        LIMIT 1
      ) s ON true
      WHERE ${where.join(' AND ')}
      ORDER BY p.sku
      LIMIT $${params.length}`;
    return { sql, params };
  }

  // A sale consumes one unit. Never goes below zero: if the counter has drifted
  // the delivery still stands and reconciliation will show the difference.
  decrementStock(em: EntityManager, sku: string) {
    return em.query(
      'UPDATE product_stock SET available = available - 1, updated_at = now() WHERE sku = $1 AND available > 0',
      [sku],
    );
  }

  async setStock(sku: string, available: number) {
    const product = await this.dataSource.getRepository(Product).findOneBy({
      sku,
    });
    if (!product) {
      throw new NotFoundException(`Unknown SKU: ${sku}`);
    }
    await this.dataSource
      .getRepository(ProductStock)
      .upsert({ sku, available }, ['sku']);
    return { sku, available };
  }

  // Generates `count` synthetic products with random stock (some of it zero) in
  // a single statement, then refreshes planner statistics.
  async generate(count: number) {
    const inserted: unknown[] = await this.dataSource.query(
      `
      INSERT INTO products (sku, name, type, price, currency, image, active)
      SELECT 'GEN-' || upper(t.type) || '-' || lpad(g::text, 7, '0'),
             initcap(t.type) || ' item #' || g,
             t.type,
             100 + (g * 37) % 5000,
             'RUB',
             'assets/' || t.type || '.png',
             true
      FROM generate_series(1, $1) AS g
      CROSS JOIN LATERAL (SELECT ($2::text[])[1 + g % 4] AS type) AS t
      ON CONFLICT (sku) DO NOTHING
      RETURNING sku`,
      [count, TYPES],
    );
    await this.dataSource.query(`
      INSERT INTO product_stock (sku, available)
      SELECT sku, hashtext(sku) & 63
      FROM products
      WHERE sku LIKE 'GEN-%'
      ON CONFLICT (sku) DO NOTHING`);
    await this.dataSource.query('ANALYZE products, product_stock');

    const [{ total }] = await this.dataSource.query(
      'SELECT count(*)::int AS total FROM products',
    );
    return { added: inserted.length, total };
  }
}
