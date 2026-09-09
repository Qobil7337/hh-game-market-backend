import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource, LessThan } from 'typeorm';
import { OrderEvent } from './order-event.entity.js';

export interface ItemState {
  id: string;
  position: number;
  sku: string;
  amount: number;
  status: string;
  delivery: { code: string; supplier: string } | null;
  refund: { amount: number; reason: string } | null;
}

const NOT_PAID = ['created', 'payment_failed'];

@Injectable()
export class HistoryService implements OnApplicationBootstrap {
  constructor(private readonly dataSource: DataSource) {}

  // The two history tables can only grow. TRUNCATE (used by the tests to
  // wipe the database) is a different statement and stays allowed.
  async onApplicationBootstrap() {
    await this.dataSource.query(`
      CREATE OR REPLACE FUNCTION forbid_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
      END $$;
      CREATE OR REPLACE TRIGGER order_events_append_only
        BEFORE UPDATE OR DELETE ON order_events FOR EACH ROW EXECUTE FUNCTION forbid_rewrite();
      CREATE OR REPLACE TRIGGER ledger_entries_append_only
        BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_rewrite();
    `);
  }

  eventsOf(orderId: string) {
    return this.dataSource
      .getRepository(OrderEvent)
      .find({ where: { orderId }, order: { id: 'ASC' } });
  }

  // The order as it was at `at`, replayed from its events. Null when the
  // order did not exist yet.
  async stateAt(orderId: string, at: Date) {
    const events = await this.dataSource.getRepository(OrderEvent).find({
      // Stamps carry microseconds, callers pass milliseconds: include the
      // whole millisecond the caller named.
      where: { orderId, at: LessThan(new Date(at.getTime() + 1)) },
      order: { id: 'ASC' },
    });
    if (events.length === 0 || events[0].type !== 'order.created') {
      return null;
    }

    const created = events[0].data as {
      amount: number;
      currency: string;
      items: { id: string; position: number; sku: string; amount: number }[];
    };
    let status = 'created';
    const items = new Map<string, ItemState>(
      created.items.map((item) => [
        item.id,
        { ...item, status: 'pending', delivery: null, refund: null },
      ]),
    );

    for (const event of events.slice(1)) {
      const data = event.data as Record<string, string | number>;
      if (event.type === 'order.status') {
        status = String(data.to);
      } else if (event.type === 'item.status' && event.orderItemId) {
        const item = items.get(event.orderItemId);
        if (!item) continue;
        item.status = String(data.to);
        if (data.to === 'delivered') {
          item.delivery = {
            code: String(data.code),
            supplier: String(data.supplier),
          };
        } else if (data.to === 'refunded') {
          item.refund = {
            amount: Number(data.amount),
            reason: String(data.reason),
          };
        }
      }
    }

    const sum = (statuses: string[]) =>
      [...items.values()]
        .filter((item) => statuses.includes(item.status))
        .reduce((total, item) => total + item.amount, 0);
    const paid = NOT_PAID.includes(status) ? 0 : created.amount;
    return {
      at,
      id: orderId,
      status,
      amount: created.amount,
      currency: created.currency,
      items: [...items.values()],
      money: {
        paid,
        delivered: sum(['delivered']),
        refunded: sum(['refunded']),
        pending: paid === 0 ? 0 : sum(['pending', 'refunding']),
      },
      eventsApplied: events.length,
    };
  }

  // Ledger balances from all postings strictly before `before`.
  async moneyBefore(before: Date) {
    const [row] = await this.dataSource.query(
      `SELECT
         coalesce(sum(amount) FILTER (WHERE account = 'cash'), 0)::int                        AS cash,
         coalesce(-sum(amount) FILTER (WHERE account = 'customer_liability'), 0)::int         AS "customerLiability",
         coalesce(-sum(amount) FILTER (WHERE account = 'revenue'), 0)::int                    AS revenue,
         coalesce(-sum(amount) FILTER (WHERE account = 'cash' AND reason = 'refund'), 0)::int AS refunded,
         coalesce(sum(amount), 0)::int                                                       AS total
       FROM ledger_entries WHERE created_at < $1`,
      [before],
    );
    return row;
  }

  // Money at a moment: everything posted up to and including `at`.
  async moneyAt(at: Date) {
    const balances = await this.moneyBefore(new Date(at.getTime() + 1));
    return { at, ...balances };
  }

  // Money that moved in [from, to): what came in, what was recognised as
  // revenue, what went back. Reconciled two ways — the closing balances
  // must equal the opening ones plus the movements, and the same counts
  // and sums must come out of the order events.
  async moneyBetween(from: Date, to: Date) {
    const [moved] = await this.dataSource.query(
      `SELECT
         coalesce(sum(amount) FILTER (WHERE account = 'cash' AND reason = 'payment'), 0)::int AS paid,
         coalesce(-sum(amount) FILTER (WHERE account = 'revenue'), 0)::int                    AS delivered,
         coalesce(-sum(amount) FILTER (WHERE account = 'cash' AND reason = 'refund'), 0)::int AS refunded,
         count(*) FILTER (WHERE account = 'cash' AND reason = 'payment')::int                 AS payments,
         count(*) FILTER (WHERE account = 'revenue')::int                                     AS deliveries,
         count(*) FILTER (WHERE account = 'cash' AND reason = 'refund')::int                  AS refunds
       FROM ledger_entries WHERE created_at >= $1 AND created_at < $2`,
      [from, to],
    );
    const [events] = await this.dataSource.query(
      `SELECT
         count(*) FILTER (WHERE type = 'order.status' AND data->>'from' = 'created' AND data->>'to' = 'paid')::int AS payments,
         coalesce(sum((data->>'amount')::int) FILTER (WHERE type = 'order.status' AND data->>'from' = 'created' AND data->>'to' = 'paid'), 0)::int AS paid,
         count(*) FILTER (WHERE type = 'item.status' AND data->>'to' = 'delivered')::int AS deliveries,
         coalesce(sum((data->>'amount')::int) FILTER (WHERE type = 'item.status' AND data->>'to' = 'delivered'), 0)::int AS delivered,
         count(*) FILTER (WHERE type = 'item.status' AND data->>'to' = 'refunded')::int AS refunds,
         coalesce(sum((data->>'amount')::int) FILTER (WHERE type = 'item.status' AND data->>'to' = 'refunded'), 0)::int AS refunded
       FROM order_events WHERE at >= $1 AND at < $2`,
      [from, to],
    );
    const opening = await this.moneyBefore(from);
    const closing = await this.moneyBefore(to);

    const balanced =
      closing.cash === opening.cash + moved.paid - moved.refunded &&
      closing.customerLiability ===
        opening.customerLiability +
          moved.paid -
          moved.delivered -
          moved.refunded &&
      closing.revenue === opening.revenue + moved.delivered;
    const eventsAgree =
      events.payments === moved.payments &&
      events.paid === moved.paid &&
      events.deliveries === moved.deliveries &&
      events.delivered === moved.delivered &&
      events.refunds === moved.refunds &&
      events.refunded === moved.refunded;

    return {
      from,
      to,
      opening,
      moved,
      closing,
      events,
      balanced,
      eventsAgree,
    };
  }
}
