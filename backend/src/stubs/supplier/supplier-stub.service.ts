import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SupplierKey } from './supplier-key.entity.js';

export type StubIssueResult =
  | { status: 'ok'; request_id: string; code: string }
  | { status: 'error'; reason: 'out_of_stock' };

@Injectable()
export class SupplierStubService {
  constructor(private readonly dataSource: DataSource) {}

  issue(
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
