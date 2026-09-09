import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { SupplierIssue } from './supplier-issue.entity.js';
import { SupplierKey } from './supplier-key.entity.js';

export const SUPPLIERS = ['a', 'b'] as const;

export interface StubConfig {
  // Probability (0..1) of answering 5xx *before* issuing anything.
  errorRate: number;
  // Probability (0..1) of hanging for hangMs *after* the work is done and
  // committed. Applies to every endpoint, the statement lookup included.
  timeoutRate: number;
  hangMs: number;
  // SKUs this supplier answers out_of_stock for, whatever its pool holds.
  unavailableSkus: string[];
  // Dishonest behaviour (0..1 each), see issue():
  // books a code that was already issued to another request_id;
  duplicateRate: number;
  // books one code but answers with somebody else's;
  foreignRate: number;
  // books the code, then answers 5xx anyway.
  errorAfterIssueRate: number;
  // Requests accepted per rateWindowMs across every endpoint; 0 = unlimited.
  // Anything beyond is answered 429 and counted as rejected.
  rateLimit: number;
  rateWindowMs: number;
}

// What the supplier saw: every request that arrived, how many it turned
// away, and the most it ever saw inside one window. The last number is the
// proof that the caller never exceeded the limit.
export interface CallStats {
  total: number;
  rejected: number;
  peakInWindow: number;
}

export type StubIssueResult =
  | { status: 'ok'; request_id: string; code: string }
  | {
      status: 'error';
      reason: 'out_of_stock' | 'internal_error' | 'rate_limited';
    };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class SupplierStubService {
  private readonly configs = new Map<string, StubConfig>();
  // Arrival times of every request, per supplier (test tooling, in memory).
  private readonly arrivals = new Map<string, number[]>();
  private readonly stats = new Map<string, CallStats>();

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    for (const supplier of SUPPLIERS) {
      const prefix = `STUB_${supplier.toUpperCase()}`;
      this.configs.set(supplier, {
        errorRate: Number(config.get(`${prefix}_ERROR_RATE`, 0)),
        timeoutRate: Number(config.get(`${prefix}_TIMEOUT_RATE`, 0)),
        hangMs: Number(config.get('STUB_HANG_MS', 10_000)),
        unavailableSkus: [],
        duplicateRate: 0,
        foreignRate: 0,
        errorAfterIssueRate: 0,
        rateLimit: Number(config.get(`${prefix}_RATE_LIMIT`, 0)),
        rateWindowMs: Number(config.get('STUB_RATE_WINDOW_MS', 60_000)),
      });
      this.resetStats(supplier);
    }
  }

  getConfig(supplier: string): StubConfig {
    return this.configs.get(supplier)!;
  }

  // Also starts the call statistics afresh, so a scenario measures only itself.
  setConfig(supplier: string, patch: Partial<StubConfig>): StubConfig {
    const next = { ...this.getConfig(supplier) };
    // A validated DTO carries every declared field, absent ones as undefined, so a
    // plain spread would wipe the settings the caller did not mention.
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (next as Record<string, unknown>)[key] = value;
    }
    this.configs.set(supplier, next);
    this.resetStats(supplier);
    return next;
  }

  private resetStats(supplier: string) {
    this.arrivals.set(supplier, []);
    this.stats.set(supplier, { total: 0, rejected: 0, peakInWindow: 0 });
  }

  // Counts one arriving request against the limit. False = turned away.
  admit(supplier: string): boolean {
    const { rateLimit, rateWindowMs } = this.getConfig(supplier);
    const now = Date.now();
    const arrivals = this.arrivals.get(supplier)!;
    const stats = this.stats.get(supplier)!;
    while (arrivals.length > 0 && arrivals[0] <= now - rateWindowMs) {
      arrivals.shift();
    }
    arrivals.push(now);
    stats.total++;
    stats.peakInWindow = Math.max(stats.peakInWindow, arrivals.length);
    if (rateLimit > 0 && arrivals.length > rateLimit) {
      stats.rejected++;
      return false;
    }
    return true;
  }

  async status(supplier: string) {
    const [stock] = await this.dataSource.query(
      `SELECT
         count(*) FILTER (WHERE request_id IS NULL)::int     AS available,
         count(*) FILTER (WHERE request_id IS NOT NULL)::int AS issued,
         (SELECT count(*) FROM supplier_issues WHERE supplier = $1)::int AS booked
       FROM supplier_keys WHERE supplier = $1`,
      [supplier],
    );
    return {
      supplier,
      config: this.getConfig(supplier),
      stock,
      calls: this.stats.get(supplier),
    };
  }

  async restock(supplier: string, codes: string[]) {
    const result = await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(SupplierKey)
      .values(codes.map((code) => ({ code, supplier })))
      .orIgnore()
      .returning('code')
      .execute();
    const { stock } = await this.status(supplier);
    return { added: result.raw.length, available: stock.available };
  }

  // The supplier's statement: one entry, or everything it has booked.
  async issued(supplier: string, requestId?: string) {
    const rows = await this.dataSource.getRepository(SupplierIssue).find({
      where: requestId ? { supplier, requestId } : { supplier },
      order: { issuedAt: 'ASC' },
      take: 1000,
    });
    await this.maybeHang(supplier);
    return rows.map((row) => ({
      request_id: row.requestId,
      code: row.code,
      order_id: row.orderId,
      sku: row.sku,
      issued_at: row.issuedAt,
    }));
  }

  async issue(
    supplier: string,
    requestId: string,
    orderId: string,
    sku: string,
  ): Promise<StubIssueResult> {
    const { errorRate, unavailableSkus, foreignRate, errorAfterIssueRate } =
      this.getConfig(supplier);

    if (!this.admit(supplier)) {
      return { status: 'error', reason: 'rate_limited' };
    }
    // A failure drawn here happens before anything is written: the definitive kind.
    if (Math.random() < errorRate) {
      return { status: 'error', reason: 'internal_error' };
    }
    if (unavailableSkus.includes(sku)) {
      return { status: 'error', reason: 'out_of_stock' };
    }

    const result = await this.reserve(supplier, requestId, orderId, sku);

    // Everything below happens after the book has been written, so the answer
    // no longer matches the book. This is the untrusted supplier of task 2.
    if (result.status === 'ok' && Math.random() < foreignRate) {
      result.code = await this.foreignCode(supplier);
    }
    if (result.status === 'ok' && Math.random() < errorAfterIssueRate) {
      return { status: 'error', reason: 'internal_error' };
    }
    // The trap from stage 1: the key is committed, only the response is late.
    await this.maybeHang(supplier);
    return result;
  }

  private async maybeHang(supplier: string) {
    const { timeoutRate, hangMs } = this.getConfig(supplier);
    if (Math.random() < timeoutRate) {
      await sleep(hangMs);
    }
  }

  private reserve(
    supplier: string,
    requestId: string,
    orderId: string,
    sku: string,
  ): Promise<StubIssueResult> {
    return this.dataSource.transaction(async (em) => {
      // Serialize calls that carry the same request_id, so a retry racing the
      // original call cannot reserve a second key.
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [requestId]);

      // Same request_id, same code: the contract's idempotency, kept honestly.
      const existing = await em.findOneBy(SupplierIssue, { requestId });
      if (existing) {
        return { status: 'ok', request_id: requestId, code: existing.code };
      }

      const code =
        (await this.duplicateCode(em, supplier)) ??
        (await this.reserveFreeKey(em, supplier, requestId, orderId, sku));
      if (!code) {
        return { status: 'error', reason: 'out_of_stock' };
      }
      await em.insert(SupplierIssue, {
        requestId,
        supplier,
        code,
        orderId,
        sku,
      });
      return { status: 'ok', request_id: requestId, code };
    });
  }

  // Reserve one free key of this supplier. SKIP LOCKED keeps concurrent issues
  // for different request_ids from fighting over the same row.
  private async reserveFreeKey(
    em: EntityManager,
    supplier: string,
    requestId: string,
    orderId: string,
    sku: string,
  ): Promise<string | undefined> {
    const reserved = await em
      .createQueryBuilder()
      .update(SupplierKey)
      .set({ requestId, orderId, sku, issuedAt: () => 'now()' })
      .where(
        `code = (
          SELECT code FROM supplier_keys
          WHERE supplier = :supplier AND request_id IS NULL
          LIMIT 1 FOR UPDATE SKIP LOCKED
        )`,
        { supplier },
      )
      .returning('code')
      .execute();
    return (reserved.raw as { code: string }[])[0]?.code;
  }

  // Dishonest: hands out a code this supplier already booked for somebody else.
  private async duplicateCode(
    em: EntityManager,
    supplier: string,
  ): Promise<string | undefined> {
    if (Math.random() >= this.getConfig(supplier).duplicateRate) {
      return undefined;
    }
    const [row] = (await em.query(
      'SELECT code FROM supplier_issues WHERE supplier = $1 ORDER BY random() LIMIT 1',
      [supplier],
    )) as { code: string }[];
    return row?.code;
  }

  // Dishonest: a code from another supplier's pool (or a made-up one).
  private async foreignCode(supplier: string): Promise<string> {
    const [row] = (await this.dataSource.query(
      'SELECT code FROM supplier_keys WHERE supplier <> $1 AND request_id IS NULL ORDER BY random() LIMIT 1',
      [supplier],
    )) as { code: string }[];
    return (
      row?.code ??
      `FAKE-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
    );
  }
}
