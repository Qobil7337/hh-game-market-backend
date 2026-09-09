import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ItemStatus } from '../orders/order-item.entity.js';
import {
  DiscrepancyKind,
  SupplierDiscrepancy,
} from './supplier-discrepancy.entity.js';
import { SupplierClient } from './supplier.client.js';

export interface Found {
  supplier: string;
  requestId: string;
  kind: DiscrepancyKind;
}

// Periodically reads every supplier's book and compares it with our
// deliveries. The delivery pass already catches what it can see at issue time;
// this catches the rest: codes booked for requests we settled without them,
// requests we never sent, a delivered code that no longer matches the book.
// Each finding is recorded once (unique per supplier, request_id and kind)
// with what it means for the dispute — no human step is involved.
@Injectable()
export class SupplierAuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SupplierAuditService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly dataSource: DataSource,
    private readonly client: SupplierClient,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const intervalMs = Number(
      this.config.get('SUPPLIER_AUDIT_INTERVAL_MS', 60_000),
    );
    this.timer = setInterval(() => {
      this.audit().catch((error: unknown) =>
        this.logger.error(
          'supplier audit failed',
          error instanceof Error ? error.stack : String(error),
        ),
      );
    }, intervalMs);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async audit() {
    const suppliers = this.config.get<string>('SUPPLIERS', 'a,b').split(',');
    const checked: Record<string, number> = {};
    const unreachable: string[] = [];
    const deferred: string[] = [];
    const found: (Found | undefined)[] = [];

    for (const supplier of suppliers) {
      let entries;
      try {
        entries = await this.client.statement(supplier);
      } catch {
        unreachable.push(supplier);
        continue;
      }
      if (entries === null) {
        // Rate limit spent on deliveries, which come first; next interval.
        deferred.push(supplier);
        continue;
      }
      checked[supplier] = entries.length;

      // Our side of the ledger for this supplier: what we delivered under each
      // request_id, and which item every request_id we ever sent belongs to.
      const deliveries = new Map<string, string>(
        (
          (await this.dataSource.query(
            'SELECT request_id AS "requestId", code FROM deliveries WHERE supplier = $1',
            [supplier],
          )) as { requestId: string; code: string }[]
        ).map((row) => [row.requestId, row.code]),
      );
      const requests = new Map<string, { itemId: string; status: ItemStatus }>(
        (
          (await this.dataSource.query(
            `SELECT DISTINCT a.request_id AS "requestId", i.id AS "itemId", i.status
             FROM delivery_attempts a JOIN order_items i ON i.id = a.order_item_id
             WHERE a.supplier = $1`,
            [supplier],
          )) as { requestId: string; itemId: string; status: ItemStatus }[]
        ).map((row) => [row.requestId, row]),
      );

      // Entries the delivery pass already explained (rejected rounds and the
      // like) are not findings again under another name.
      const explained = new Set<string>(
        (
          (await this.dataSource.query(
            'SELECT DISTINCT request_id AS "requestId" FROM supplier_discrepancies WHERE supplier = $1',
            [supplier],
          )) as { requestId: string }[]
        ).map((row) => row.requestId),
      );

      for (const entry of entries) {
        if (explained.has(entry.request_id)) continue;
        const delivered = deliveries.get(entry.request_id);
        const request = requests.get(entry.request_id);

        if (delivered !== undefined) {
          if (delivered !== entry.code) {
            found.push(
              await this.record(supplier, entry.request_id, 'code_mismatch', {
                orderItemId: request?.itemId ?? null,
                supplierCode: entry.code,
                ourCode: delivered,
                resolution:
                  'book changed after delivery; customer keeps the delivered code, dispute the booked one',
              }),
            );
          }
          continue;
        }
        if (!request) {
          found.push(
            await this.record(supplier, entry.request_id, 'unknown_request', {
              orderItemId: null,
              supplierCode: entry.code,
              ourCode: null,
              resolution: 'never requested by us; not used, dispute the charge',
            }),
          );
          continue;
        }
        if (
          request.status === ItemStatus.Delivered ||
          request.status === ItemStatus.Refunded
        ) {
          found.push(
            await this.record(supplier, entry.request_id, 'unused_issue', {
              orderItemId: request.itemId,
              supplierCode: entry.code,
              ourCode: null,
              resolution:
                'item settled without this code; not used, dispute the charge',
            }),
          );
        }
        // pending / refunding: still in flight, the delivery pass resolves it
        // through the same book lookup.
      }
    }

    const fresh = found.filter((f): f is Found => f !== undefined);
    if (fresh.length > 0 || unreachable.length > 0) {
      this.logger.warn({
        event: 'supplier.audit',
        checked,
        unreachable,
        deferred,
        found: fresh,
      });
    }
    return { checked, unreachable, deferred, found: fresh };
  }

  // Inserts once; returns the finding only when it is new.
  private async record(
    supplier: string,
    requestId: string,
    kind: DiscrepancyKind,
    fields: {
      orderItemId: string | null;
      supplierCode: string;
      ourCode: string | null;
      resolution: string;
    },
  ): Promise<Found | undefined> {
    const result = await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(SupplierDiscrepancy)
      .values({ supplier, requestId, kind, ...fields })
      .orIgnore()
      .returning('id')
      .execute();
    return result.raw.length > 0 ? { supplier, requestId, kind } : undefined;
  }
}
