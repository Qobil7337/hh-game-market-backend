import { Injectable, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { DeliveryWorker } from '../delivery/delivery.worker.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { transitionOrder } from '../orders/order-transition.js';
import { Order, OrderStatus } from '../orders/order.entity.js';
import { PaymentWebhookDto } from './dto/payment-webhook.dto.js';
import { PaymentEvent } from './payment-event.entity.js';

export type WebhookOutcome =
  | 'applied'
  | 'duplicate'
  | 'order_not_found'
  | 'amount_mismatch'
  | `ignored_${OrderStatus}`;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly worker: DeliveryWorker,
    private readonly ledger: LedgerService,
  ) {}

  // Everything happens in one short transaction so the response is fast and the
  // event is durably recorded before we answer 200.
  async handle(dto: PaymentWebhookDto): Promise<{ result: WebhookOutcome }> {
    const outcome = await this.dataSource.transaction(async (em) => {
      // 1. Record the event. The primary key turns a redelivered event_id into a no-op.
      const inserted = await em
        .createQueryBuilder()
        .insert()
        .into(PaymentEvent)
        .values({
          eventId: dto.event_id,
          orderId: dto.order_id,
          status: dto.status,
          amount: dto.amount,
          currency: dto.currency,
          createdAt: new Date(dto.created_at),
          outcome: 'received',
        })
        .orIgnore()
        .returning('event_id')
        .execute();

      if (inserted.raw.length === 0) {
        return 'duplicate';
      }

      // 2. Lock the order row so concurrent events for the same order are serialized
      //    and each one sees the status left by the previous one.
      const order = isUUID(dto.order_id)
        ? await em.findOne(Order, {
            where: { id: dto.order_id },
            lock: { mode: 'pessimistic_write' },
          })
        : null;

      const outcome = await this.apply(em, order, dto);
      await em.update(PaymentEvent, { eventId: dto.event_id }, { outcome });
      return outcome;
    });

    this.logger.log({
      event: 'payment.webhook',
      eventId: dto.event_id,
      orderId: dto.order_id,
      status: dto.status,
      amount: dto.amount,
      currency: dto.currency,
      outcome,
    });

    if (outcome === 'applied' && dto.status === 'paid') {
      this.worker.wake();
    }

    return { result: outcome };
  }

  private async apply(
    em: EntityManager,
    order: Order | null,
    dto: PaymentWebhookDto,
  ): Promise<WebhookOutcome> {
    if (!order) {
      return 'order_not_found';
    }
    // Only a fresh order reacts to payment events; anything later is final or in
    // flight, and a late/duplicate event must not touch it.
    if (order.status !== OrderStatus.Created) {
      return `ignored_${order.status}`;
    }
    if (dto.status === 'failed') {
      await transitionOrder(
        em,
        order.id,
        OrderStatus.Created,
        OrderStatus.PaymentFailed,
      );
      return 'applied';
    }
    if (dto.amount !== order.amount || dto.currency !== order.currency) {
      return 'amount_mismatch';
    }

    await transitionOrder(em, order.id, OrderStatus.Created, OrderStatus.Paid);
    await this.ledger.recordPayment(em, order, dto.event_id);
    return 'applied';
  }
}
