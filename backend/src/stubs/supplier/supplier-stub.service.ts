import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SupplierKey } from './supplier-key.entity.js';

export const SUPPLIERS = ['a', 'b'] as const;

export interface StubConfig {
  // Probability (0..1) of answering 5xx *before* issuing anything.
  errorRate: number;
  // Probability (0..1) of hanging for hangMs *after* a key was issued and committed.
  timeoutRate: number;
  hangMs: number;
}

export type StubIssueResult =
  | { status: 'ok'; request_id: string; code: string }
  | { status: 'error'; reason: 'out_of_stock' | 'internal_error' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class SupplierStubService {
  private readonly configs = new Map<string, StubConfig>();

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
      });
    }
  }

  getConfig(supplier: string): StubConfig {
    return this.configs.get(supplier)!;
  }

  setConfig(supplier: string, patch: Partial<StubConfig>): StubConfig {
    const next = { ...this.getConfig(supplier) };
    // A validated DTO carries every declared field, absent ones as undefined, so a
    // plain spread would wipe the settings the caller did not mention.
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) next[key as keyof StubConfig] = value;
    }
    this.configs.set(supplier, next);
    return next;
  }

  async status(supplier: string) {
    const [stock] = await this.dataSource.query(
      `SELECT
         count(*) FILTER (WHERE request_id IS NULL)::int     AS available,
         count(*) FILTER (WHERE request_id IS NOT NULL)::int AS issued
       FROM supplier_keys WHERE supplier = $1`,
      [supplier],
    );
    return { supplier, config: this.getConfig(supplier), stock };
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

  async issue(
    supplier: string,
    requestId: string,
    orderId: string,
    sku: string,
  ): Promise<StubIssueResult> {
    const { errorRate, timeoutRate, hangMs } = this.getConfig(supplier);

    // A failure drawn here happens before anything is written: the definitive kind.
    if (Math.random() < errorRate) {
      return { status: 'error', reason: 'internal_error' };
    }

    const result = await this.reserve(supplier, requestId, orderId, sku);

    // The trap. The key above is already committed; from here the response merely
    // takes longer than the caller is willing to wait, which from the outside looks
    // exactly like a supplier that never issued anything.
    if (Math.random() < timeoutRate) {
      await sleep(hangMs);
    }
    return result;
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

      const existing = await em.findOneBy(SupplierKey, { requestId });
      if (existing) {
        return { status: 'ok', request_id: requestId, code: existing.code };
      }

      // Reserve one free key of this supplier. SKIP LOCKED keeps concurrent issues
      // for different request_ids from fighting over the same row.
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

      const code = (reserved.raw as { code: string }[])[0]?.code;
      if (!code) {
        return { status: 'error', reason: 'out_of_stock' };
      }
      return { status: 'ok', request_id: requestId, code };
    });
  }
}
