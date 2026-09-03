import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { transitionOrder } from '../orders/order-transition.js';
import { Order, OrderStatus } from '../orders/order.entity.js';
import { DeliveryService } from './delivery.service.js';

// Background delivery. The orders table is the queue: paid orders are claimed with
// SKIP LOCKED, so any number of lanes, workers or app instances can drain it
// without ever picking the same order twice.
@Injectable()
export class DeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private wakeRequested = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly delivery: DeliveryService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const intervalMs = Number(
      this.config.get('DELIVERY_POLL_INTERVAL_MS', 2000),
    );
    this.timer = setInterval(() => void this.run(), intervalMs);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // Called right after a payment is applied so delivery starts without waiting for
  // the next poll.
  wake() {
    void this.run();
  }

  // Only one drain runs at a time; wake() calls that arrive meanwhile fold into one
  // extra pass instead of starting a second one.
  private async run() {
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.wakeRequested = false;
        await this.drain();
      } while (this.wakeRequested);
    } finally {
      this.running = false;
    }
  }

  // A few lanes in parallel so one supplier stuck in retries does not hold up
  // every other order.
  private async drain() {
    const lanes = Number(this.config.get('DELIVERY_CONCURRENCY', 4));
    await Promise.all(Array.from({ length: lanes }, () => this.lane()));
  }

  private async lane() {
    for (;;) {
      const order = await this.claim();
      if (!order) return;
      try {
        await this.delivery.deliver(order);
      } catch (error) {
        // Left in `delivering`; the recovery job picks it up later.
        this.logger.error(
          `order=${order.id} delivery crashed`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  // Atomically takes one paid order and marks it delivering.
  private claim(): Promise<Order | null> {
    return this.dataSource.transaction(async (em) => {
      const order = await em
        .createQueryBuilder(Order, 'o')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('o.status = :status', { status: OrderStatus.Paid })
        .orderBy('o.updatedAt', 'ASC')
        .limit(1)
        .getOne();

      if (!order) return null;
      await transitionOrder(
        em,
        order.id,
        OrderStatus.Paid,
        OrderStatus.Delivering,
      );
      return order;
    });
  }
}
