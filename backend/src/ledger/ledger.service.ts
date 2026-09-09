import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { OrderItem } from '../orders/order-item.entity.js';
import { Order } from '../orders/order.entity.js';
import {
  LedgerAccount,
  LedgerEntry,
  LedgerReason,
} from './ledger-entry.entity.js';

@Injectable()
export class LedgerService {
  constructor(private readonly dataSource: DataSource) {}

  // Cash came in; we now owe the customer their goods.
  recordPayment(em: EntityManager, order: Order, eventId: string) {
    return this.post(em, order.id, order.currency, 'payment', eventId, [
      ['cash', order.amount],
      ['customer_liability', -order.amount],
    ]);
  }

  // The obligation for one item is settled and becomes revenue.
  recordDelivery(em: EntityManager, item: OrderItem) {
    return this.post(em, item.orderId, item.currency, 'delivery', item.id, [
      ['customer_liability', item.amount],
      ['revenue', -item.amount],
    ]);
  }

  // The obligation for one item is settled by giving the money back.
  recordRefund(em: EntityManager, item: OrderItem) {
    return this.post(em, item.orderId, item.currency, 'refund', item.id, [
      ['customer_liability', item.amount],
      ['cash', -item.amount],
    ]);
  }

  private post(
    em: EntityManager,
    orderId: string,
    currency: string,
    reason: LedgerReason,
    reference: string,
    postings: [LedgerAccount, number][],
  ) {
    return em.insert(
      LedgerEntry,
      postings.map(([account, amount]) => ({
        orderId,
        account,
        amount,
        currency,
        reason,
        reference,
      })),
    );
  }

  // Account balances next to what the orders and items say they should be:
  // paid = delivered + refunded + still owed. All amounts are in the single
  // catalog currency.
  async balances() {
    const [actual] = await this.dataSource.query(`
      SELECT
        coalesce(sum(amount) FILTER (WHERE account = 'cash'), 0)::int                       AS cash,
        coalesce(-sum(amount) FILTER (WHERE account = 'customer_liability'), 0)::int        AS "customerLiability",
        coalesce(-sum(amount) FILTER (WHERE account = 'revenue'), 0)::int                   AS revenue,
        coalesce(-sum(amount) FILTER (WHERE account = 'cash' AND reason = 'refund'), 0)::int AS refunded,
        coalesce(sum(amount), 0)::int                                                      AS total
      FROM ledger_entries
    `);
    const [items] = await this.dataSource.query(`
      SELECT
        (SELECT coalesce(sum(amount), 0) FROM orders
          WHERE status NOT IN ('created', 'payment_failed'))::int                            AS paid,
        coalesce(sum(i.amount) FILTER (WHERE i.status = 'delivered'), 0)::int               AS delivered,
        coalesce(sum(i.amount) FILTER (WHERE i.status = 'refunded'), 0)::int                AS refunded,
        coalesce(sum(i.amount) FILTER (WHERE i.status IN ('pending', 'refunding')), 0)::int AS outstanding
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
      WHERE o.status NOT IN ('created', 'payment_failed')
    `);

    const expected = {
      cash: items.paid - items.refunded,
      customerLiability: items.outstanding,
      revenue: items.delivered,
      refunded: items.refunded,
    };
    const balanced =
      actual.total === 0 &&
      actual.cash === expected.cash &&
      actual.customerLiability === expected.customerLiability &&
      actual.revenue === expected.revenue &&
      actual.refunded === expected.refunded;

    return { ...actual, expected, balanced };
  }
}
