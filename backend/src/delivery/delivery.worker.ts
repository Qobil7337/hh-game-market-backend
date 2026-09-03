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
import { Delivery } from './delivery.entity.js';
import { SupplierClient } from './supplier.client.js';

// Background delivery. The orders table is the queue: paid orders are claimed with
// SKIP LOCKED, so any number of workers or app instances can drain it without ever
// picking the same order twice.
@Injectable()
export class DeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private wakeRequested = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly supplier: SupplierClient,
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

  // Only one loop runs at a time; wake() calls that arrive meanwhile fold into one
  // extra pass instead of starting a second loop.
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
    } catch (error) {
      this.logger.error(
        'Delivery loop stopped on error',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }

  private async drain() {
    for (;;) {
      const order = await this.claim();
      if (!order) return;
      await this.deliver(order);
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

  private async deliver(order: Order) {
    const supplier = 'a';
    // Stable per order and supplier, never per attempt: a retry after a timeout must
    // present the same id so the supplier hands back the same code instead of a new one.
    const requestId = `${order.id}:${supplier}`;

    const result = await this.supplier.issue(
      supplier,
      requestId,
      order.id,
      order.sku,
    );

    if (!result.ok) {
      const next =
        result.reason === 'out_of_stock'
          ? OrderStatus.OutOfStock
          : OrderStatus.DeliveryFailed;
      await transitionOrder(
        this.dataSource.manager,
        order.id,
        OrderStatus.Delivering,
        next,
      );
      this.logger.warn(
        `order=${order.id} supplier=${supplier} reason=${result.reason} -> ${next}`,
      );
      return;
    }

    await this.dataSource.transaction(async (em) => {
      const existing = await em.findOneBy(Delivery, { orderId: order.id });
      if (!existing) {
        await em.insert(Delivery, {
          orderId: order.id,
          requestId,
          supplier,
          code: result.code,
        });
      } else if (existing.code !== result.code) {
        // Should be impossible; refusing keeps the order in `delivering` for a human.
        throw new Error(
          `order=${order.id} already holds a code from ${existing.supplier}, ${supplier} returned a different one`,
        );
      }
      await transitionOrder(
        em,
        order.id,
        OrderStatus.Delivering,
        OrderStatus.Delivered,
      );
    });

    this.logger.log(`order=${order.id} supplier=${supplier} -> delivered`);
  }
}
