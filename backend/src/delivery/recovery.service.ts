import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { OrderStatus } from '../orders/order.entity.js';
import { DeliveryWorker } from './delivery.worker.js';

// Periodically puts stuck and parked orders back in the queue. Safe to run at
// any time from any number of instances, because re-delivery is idempotent:
// the same request_ids are reused, and a supplier that timed out earlier is
// asked again before anyone else.
@Injectable()
export class RecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecoveryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly dataSource: DataSource,
    private readonly worker: DeliveryWorker,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const intervalMs = Number(this.config.get('RECOVERY_INTERVAL_MS', 30_000));
    this.timer = setInterval(() => {
      this.sweep().catch((error: unknown) =>
        this.logger.error(
          'recovery sweep failed',
          error instanceof Error ? error.stack : String(error),
        ),
      );
    }, intervalMs);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async sweep() {
    const staleMs = Number(this.config.get('DELIVERY_STALE_AFTER_MS', 60_000));
    const retryMs = Number(this.config.get('RECOVERY_RETRY_AFTER_MS', 60_000));

    // `delivering` for longer than any delivery can take means the worker died
    // mid-flight (or lost its database connection) before finishing.
    const stale = await this.requeue([OrderStatus.Delivering], staleMs);
    // Parked orders get another go once the cooldown has passed: the supplier
    // that timed out may answer now, the refund call may go through.
    const parked = await this.requeue([OrderStatus.DeliveryFailed], retryMs);

    if (stale.length > 0 || parked.length > 0) {
      this.logger.log({ event: 'recovery.sweep', stale, parked });
      this.worker.wake();
    }
    return { stale, parked };
  }

  // One statement: move the orders and write their history rows together.
  private async requeue(
    from: OrderStatus[],
    olderThanMs: number,
  ): Promise<string[]> {
    const rows: { order_id: string }[] = await this.dataSource.query(
      `WITH moved AS (
         UPDATE orders o SET status = 'paid', updated_at = now()
         FROM (SELECT id, status FROM orders
               WHERE status::text = ANY($1::text[]) AND updated_at < $2) s
         WHERE o.id = s.id
         RETURNING o.id, s.status AS previous
       )
       INSERT INTO order_events (order_id, type, data)
       SELECT id, 'order.status',
              jsonb_build_object('from', previous, 'to', 'paid', 'reason', 'recovery')
       FROM moved
       RETURNING order_id`,
      [from, new Date(Date.now() - olderThanMs)],
    );
    return rows.map((row) => row.order_id);
  }
}
