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
      moneyMismatches,
      unmatchedEvents,
      paidAfterFailure,
      supplierIssuesWithoutDelivery,
      supplierCodeMismatches,
      supplierDiscrepancies,
      ledger,
    ] = await Promise.all([
      // Money in, not every item settled yet. Expected to be transient; anything
      // old is stuck.
      q(`
        SELECT o.id, o.amount, o.currency, o.status, o.updated_at AS "updatedAt",
               extract(epoch FROM now() - o.updated_at)::int AS "ageSeconds",
               (SELECT count(*) FROM order_items i
                 WHERE i.order_id = o.id AND i.status IN ('pending', 'refunding'))::int AS "openItems"
        FROM orders o
        WHERE o.status IN ('paid', 'delivering', 'delivery_failed')
        ORDER BY o.updated_at
        LIMIT ${LIMIT}
      `),
      // Must be empty: a delivered item without a delivery row, or a delivery
      // for an order that never had a paid event applied.
      q(`
        SELECT i.order_id AS id, i.id AS "itemId", i.status, d.code
        FROM order_items i
        LEFT JOIN deliveries d ON d.order_item_id = i.id
        WHERE (i.status = 'delivered' AND d.id IS NULL)
           OR (d.id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM payment_events e
                 WHERE e.order_id = i.order_id::text AND e.status = 'paid' AND e.outcome = 'applied'))
        LIMIT ${LIMIT}
      `),
      // Must be empty: for every paid order, paid = delivered + refunded + still
      // open, both by item status and by ledger postings; a final order has
      // nothing open.
      q(`
        SELECT * FROM (
          SELECT o.id, o.status, o.amount AS paid,
                 coalesce(sum(i.amount) FILTER (WHERE i.status = 'delivered'), 0)::int               AS delivered,
                 coalesce(sum(i.amount) FILTER (WHERE i.status = 'refunded'), 0)::int                AS refunded,
                 coalesce(sum(i.amount) FILTER (WHERE i.status IN ('pending', 'refunding')), 0)::int AS pending,
                 (SELECT coalesce(sum(amount), 0) FROM ledger_entries l
                   WHERE l.order_id = o.id AND l.account = 'cash')::int                              AS "ledgerCash",
                 (SELECT coalesce(-sum(amount), 0) FROM ledger_entries l
                   WHERE l.order_id = o.id AND l.account = 'revenue')::int                           AS "ledgerRevenue"
          FROM orders o
          JOIN order_items i ON i.order_id = o.id
          WHERE o.status NOT IN ('created', 'payment_failed')
          GROUP BY o.id
        ) t
        WHERE paid <> delivered + refunded + pending
           OR "ledgerCash" <> paid - refunded
           OR "ledgerRevenue" <> delivered
           OR (status IN ('delivered', 'partially_delivered', 'refunded') AND pending > 0)
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
      // Entries in a supplier's book we have no delivery for and no recorded
      // discrepancy about: the trace an ambiguous timeout leaves behind until
      // the retry collects the code, or something the audit has not seen yet.
      q(`
        SELECT k.supplier, k.request_id AS "requestId", k.order_id AS "orderId",
               o.status, k.issued_at AS "issuedAt"
        FROM supplier_issues k
        LEFT JOIN orders o ON o.id::text = k.order_id
        LEFT JOIN deliveries d ON d.request_id = k.request_id
        WHERE d.id IS NULL AND NOT EXISTS (
          SELECT 1 FROM supplier_discrepancies x
          WHERE x.supplier = k.supplier AND x.request_id = k.request_id)
        ORDER BY k.issued_at
        LIMIT ${LIMIT}
      `),
      // Must be empty: a delivered code differs from what the supplier booked
      // under that request_id (we only ever deliver the booked code).
      q(`
        SELECT k.supplier, k.request_id AS "requestId", k.order_id AS "orderId",
               k.code AS "bookedCode", d.code AS "deliveredCode"
        FROM supplier_issues k
        JOIN deliveries d ON d.request_id = k.request_id
        WHERE d.code <> k.code
        LIMIT ${LIMIT}
      `),
      // Everything the supplier got wrong and what was done about it. Not a
      // health problem by itself: each row is already resolved.
      q(`
        SELECT supplier, request_id AS "requestId", order_item_id AS "itemId", kind,
               supplier_code AS "supplierCode", our_code AS "ourCode", resolution,
               created_at AS "createdAt"
        FROM supplier_discrepancies
        ORDER BY created_at DESC
        LIMIT ${LIMIT}
      `),
      this.ledger.balances(),
    ]);

    return {
      generatedAt: new Date(),
      healthy:
        deliveredNotPaid.length === 0 &&
        moneyMismatches.length === 0 &&
        supplierCodeMismatches.length === 0 &&
        ledger.balanced,
      counts: {
        paidNotDelivered: paidNotDelivered.length,
        deliveredNotPaid: deliveredNotPaid.length,
        moneyMismatches: moneyMismatches.length,
        unmatchedEvents: unmatchedEvents.length,
        paidAfterFailure: paidAfterFailure.length,
        supplierIssuesWithoutDelivery: supplierIssuesWithoutDelivery.length,
        supplierCodeMismatches: supplierCodeMismatches.length,
        supplierDiscrepancies: supplierDiscrepancies.length,
      },
      ledger,
      paidNotDelivered,
      deliveredNotPaid,
      moneyMismatches,
      unmatchedEvents,
      paidAfterFailure,
      supplierIssuesWithoutDelivery,
      supplierCodeMismatches,
      supplierDiscrepancies,
    };
  }
}
