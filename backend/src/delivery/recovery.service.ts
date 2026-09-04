import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Order, OrderStatus } from '../orders/order.entity.js';
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
    // Parked orders get another go once the cooldown has passed: stock may be
    // back, a supplier may be up again.
    const parked = await this.requeue(
      [OrderStatus.OutOfStock, OrderStatus.DeliveryFailed],
      retryMs,
    );

    if (stale.length > 0 || parked.length > 0) {
      this.logger.log({ event: 'recovery.sweep', stale, parked });
      this.worker.wake();
    }
    return { stale, parked };
  }

  private async requeue(
    from: OrderStatus[],
    olderThanMs: number,
  ): Promise<string[]> {
    const result = await this.dataSource
      .createQueryBuilder()
      .update(Order)
      .set({ status: OrderStatus.Paid })
      .where('status IN (:...from) AND updated_at < :before', {
        from,
        before: new Date(Date.now() - olderThanMs),
      })
      .returning('id')
      .execute();
    return (result.raw as { id: string }[]).map((row) => row.id);
  }
}
