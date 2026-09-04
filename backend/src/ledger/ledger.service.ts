import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
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
    return this.post(em, order, 'payment', eventId, [
      ['cash', order.amount],
      ['customer_liability', -order.amount],
    ]);
  }

  // The obligation is settled and becomes revenue.
  recordDelivery(em: EntityManager, order: Order) {
    return this.post(em, order, 'delivery', order.id, [
      ['customer_liability', order.amount],
      ['revenue', -order.amount],
    ]);
  }

  private post(
    em: EntityManager,
    order: Order,
    reason: LedgerReason,
    reference: string,
    postings: [LedgerAccount, number][],
  ) {
    return em.insert(
      LedgerEntry,
      postings.map(([account, amount]) => ({
        orderId: order.id,
        account,
        amount,
        currency: order.currency,
        reason,
        reference,
      })),
    );
  }

  // Account balances next to what the orders table says they should be. All
  // amounts are in the single catalog currency.
  async balances() {
    const [actual] = await this.dataSource.query(`
      SELECT
        coalesce(sum(amount) FILTER (WHERE account = 'cash'), 0)::int                AS cash,
        coalesce(-sum(amount) FILTER (WHERE account = 'customer_liability'), 0)::int AS "customerLiability",
        coalesce(-sum(amount) FILTER (WHERE account = 'revenue'), 0)::int            AS revenue,
        coalesce(sum(amount), 0)::int                                               AS total
      FROM ledger_entries
    `);
    const [orders] = await this.dataSource.query(`
      SELECT
        coalesce(sum(amount) FILTER (WHERE status = 'delivered'), 0)::int AS delivered,
        coalesce(sum(amount) FILTER (WHERE status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')), 0)::int AS outstanding
      FROM orders
    `);

    const expected = {
      cash: orders.delivered + orders.outstanding,
      customerLiability: orders.outstanding,
      revenue: orders.delivered,
    };
    const balanced =
      actual.total === 0 &&
      actual.cash === expected.cash &&
      actual.customerLiability === expected.customerLiability &&
      actual.revenue === expected.revenue;

    return { ...actual, expected, balanced };
  }
}
