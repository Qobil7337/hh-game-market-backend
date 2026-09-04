import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LedgerService } from '../ledger/ledger.service.js';

const LIMIT = 100;

// Cross-checks the tables that must agree with each other. Lists are capped;
// counts are exact.
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
  ) {}

  async report() {
    const q = (sql: string) => this.dataSource.query(sql);

    const [
      paidNotDelivered,
      deliveredNotPaid,
      unmatchedEvents,
      paidAfterFailure,
      supplierKeysWithoutDelivery,
      supplierCodeMismatches,
      ledger,
    ] = await Promise.all([
      // Money in, nothing out yet. Expected to be transient; anything old is stuck.
      q(`
        SELECT id, sku, amount, currency, status, updated_at AS "updatedAt",
               extract(epoch FROM now() - updated_at)::int AS "ageSeconds"
        FROM orders
        WHERE status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
        ORDER BY updated_at
        LIMIT ${LIMIT}
      `),
      // Must be empty: a delivered order without a delivery row, or a delivery
      // for an order that never had a paid event applied.
      q(`
        SELECT o.id, o.status, d.code
        FROM orders o
        LEFT JOIN deliveries d ON d.order_id = o.id
        WHERE (o.status = 'delivered' AND d.id IS NULL)
           OR (d.id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM payment_events e
                 WHERE e.order_id = o.id::text AND e.status = 'paid' AND e.outcome = 'applied'))
        LIMIT ${LIMIT}
      `),
      // Events we could not apply: money possibly received for nothing we can deliver.
      q(`
        SELECT event_id AS "eventId", order_id AS "orderId", status, amount, currency,
               outcome, received_at AS "receivedAt"
        FROM payment_events
        WHERE outcome IN ('order_not_found', 'amount_mismatch')
        ORDER BY received_at DESC
        LIMIT ${LIMIT}
      `),
      // A paid event arriving after the order was already payment_failed: refund candidates.
      q(`
        SELECT event_id AS "eventId", order_id AS "orderId", amount, currency,
               received_at AS "receivedAt"
        FROM payment_events
        WHERE status = 'paid' AND outcome = 'ignored_payment_failed'
        ORDER BY received_at DESC
        LIMIT ${LIMIT}
      `),
      // Keys a supplier holds for an order that has no delivery yet: the trace
      // an ambiguous timeout leaves behind until recovery resolves it.
      q(`
        SELECT k.supplier, k.request_id AS "requestId", k.order_id AS "orderId",
               o.status, k.issued_at AS "issuedAt"
        FROM supplier_keys k
        LEFT JOIN orders o ON o.id::text = k.order_id
        LEFT JOIN deliveries d ON d.order_id = o.id
        WHERE k.request_id IS NOT NULL AND d.id IS NULL
        ORDER BY k.issued_at
        LIMIT ${LIMIT}
      `),
      // Must be empty: a supplier issued a code for an order that was delivered
      // with a different one, i.e. a second key was consumed.
      q(`
        SELECT k.supplier, k.request_id AS "requestId", k.order_id AS "orderId",
               d.supplier AS "deliveredBy"
        FROM supplier_keys k
        JOIN orders o ON o.id::text = k.order_id
        JOIN deliveries d ON d.order_id = o.id
        WHERE k.request_id IS NOT NULL AND d.code <> k.code
        LIMIT ${LIMIT}
      `),
      this.ledger.balances(),
    ]);

    return {
      generatedAt: new Date(),
      healthy:
        deliveredNotPaid.length === 0 &&
        supplierCodeMismatches.length === 0 &&
        ledger.balanced,
      counts: {
        paidNotDelivered: paidNotDelivered.length,
        deliveredNotPaid: deliveredNotPaid.length,
        unmatchedEvents: unmatchedEvents.length,
        paidAfterFailure: paidAfterFailure.length,
        supplierKeysWithoutDelivery: supplierKeysWithoutDelivery.length,
        supplierCodeMismatches: supplierCodeMismatches.length,
      },
      ledger,
      paidNotDelivered,
      deliveredNotPaid,
      unmatchedEvents,
      paidAfterFailure,
      supplierKeysWithoutDelivery,
      supplierCodeMismatches,
    };
  }
}
