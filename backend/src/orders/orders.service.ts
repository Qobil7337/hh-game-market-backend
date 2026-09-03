import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { Repository } from 'typeorm';
import { Product } from '../catalog/product.entity.js';
import { DeliveryAttempt } from '../delivery/delivery-attempt.entity.js';
import { Delivery } from '../delivery/delivery.entity.js';
import { DeliveryWorker } from '../delivery/delivery.worker.js';
import { transitionOrder } from './order-transition.js';
import { Order, OrderStatus } from './order.entity.js';

const RETRYABLE = [OrderStatus.OutOfStock, OrderStatus.DeliveryFailed];

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(Delivery)
    private readonly deliveries: Repository<Delivery>,
    @InjectRepository(DeliveryAttempt)
    private readonly attempts: Repository<DeliveryAttempt>,
    private readonly worker: DeliveryWorker,
  ) {}

  async create(sku: string): Promise<Order> {
    const product = await this.products.findOneBy({ sku });
    if (!product) {
      throw new NotFoundException(`Unknown SKU: ${sku}`);
    }

    return this.orders.save(
      this.orders.create({
        sku,
        amount: product.price,
        currency: product.currency,
      }),
    );
  }

  async get(id: string) {
    const order = await this.find(id);

    const [delivery, attempts] = await Promise.all([
      this.deliveries.findOneBy({ orderId: id }),
      this.attempts.find({ where: { orderId: id }, order: { id: 'ASC' } }),
    ]);

    return {
      ...order,
      delivery: delivery
        ? {
            code: delivery.code,
            supplier: delivery.supplier,
            deliveredAt: delivery.createdAt,
          }
        : null,
      attempts: attempts.map((a) => ({
        supplier: a.supplier,
        requestId: a.requestId,
        attempt: a.attempt,
        outcome: a.outcome,
        detail: a.detail,
        latencyMs: a.latencyMs,
        at: a.createdAt,
      })),
    };
  }

  // Puts a parked order (out_of_stock / delivery_failed) back in the queue. The
  // delivery itself stays idempotent: same request_ids, same supplier order.
  async retryDelivery(id: string) {
    const order = await this.find(id);
    if (!RETRYABLE.includes(order.status)) {
      throw new ConflictException(
        `Order is ${order.status}; only ${RETRYABLE.join(' or ')} can be retried`,
      );
    }

    try {
      await transitionOrder(
        this.orders.manager,
        id,
        order.status,
        OrderStatus.Paid,
      );
    } catch {
      throw new ConflictException('Order changed status concurrently; retry');
    }
    this.worker.wake();

    return this.get(id);
  }

  private async find(id: string): Promise<Order> {
    const order = isUUID(id) ? await this.orders.findOneBy({ id }) : null;
    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return order;
  }
}
