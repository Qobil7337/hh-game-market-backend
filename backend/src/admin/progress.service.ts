import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SupplierLimiter } from '../delivery/supplier-limiter.service.js';

// Where every order is right now, and how much of each supplier's rate limit
// is spent. The queue is the orders table, so this is a handful of counts.
@Injectable()
export class ProgressService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly limiter: SupplierLimiter,
    private readonly config: ConfigService,
  ) {}

  async snapshot() {
    const [orders] = await this.dataSource.query(`
      SELECT
        count(*) FILTER (WHERE status = 'created')::int                                              AS "awaitingPayment",
        count(*) FILTER (WHERE status = 'paid' AND (not_before IS NULL OR not_before <= now()))::int AS queued,
        count(*) FILTER (WHERE status = 'paid' AND not_before > now())::int                          AS "waitingForSlot",
        count(*) FILTER (WHERE status = 'delivering')::int                                           AS delivering,
        count(*) FILTER (WHERE status = 'delivery_failed')::int                                      AS parked,
        count(*) FILTER (WHERE status = 'delivered')::int                                            AS delivered,
        count(*) FILTER (WHERE status = 'partially_delivered')::int                                  AS "partiallyDelivered",
        count(*) FILTER (WHERE status = 'refunded')::int                                             AS refunded,
        count(*) FILTER (WHERE status = 'payment_failed')::int                                       AS "paymentFailed"
      FROM orders
    `);
    const [items] = await this.dataSource.query(`
      SELECT
        count(*) FILTER (WHERE i.status IN ('pending', 'refunding'))::int AS open,
        count(*) FILTER (WHERE i.status = 'delivered')::int               AS delivered,
        count(*) FILTER (WHERE i.status = 'refunded')::int                AS refunded
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
      WHERE o.status NOT IN ('created', 'payment_failed')
    `);

    const suppliers: Record<string, unknown> = {};
    for (const supplier of this.config
      .get<string>('SUPPLIERS', 'a,b')
      .split(',')) {
      suppliers[supplier] = await this.limiter.usage(supplier);
    }

    return { generatedAt: new Date(), orders, items, suppliers };
  }
}
