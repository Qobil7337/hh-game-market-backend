import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { DataSource, In, Repository } from 'typeorm';
import { Product } from '../catalog/product.entity.js';
import { DeliveryAttempt } from '../delivery/delivery-attempt.entity.js';
import { Delivery } from '../delivery/delivery.entity.js';
import { DeliveryWorker } from '../delivery/delivery.worker.js';
import { Refund } from '../delivery/refund.entity.js';
import { SupplierDiscrepancy } from '../delivery/supplier-discrepancy.entity.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { ItemStatus, OrderItem } from './order-item.entity.js';
import { transitionOrder } from './order-transition.js';
import { Order, OrderStatus } from './order.entity.js';

const RETRYABLE = [OrderStatus.DeliveryFailed];

@Injectable()
export class OrdersService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(OrderItem) private readonly items: Repository<OrderItem>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(Delivery)
    private readonly deliveries: Repository<Delivery>,
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(DeliveryAttempt)
    private readonly attempts: Repository<DeliveryAttempt>,
    @InjectRepository(SupplierDiscrepancy)
    private readonly discrepancies: Repository<SupplierDiscrepancy>,
    private readonly worker: DeliveryWorker,
  ) {}

  async create(dto: CreateOrderDto) {
    const lines = dto.items ?? (dto.sku ? [{ sku: dto.sku }] : []);
    if (lines.length === 0) {
      throw new BadRequestException('Either sku or items is required');
    }

    const products = await this.products.findBy({
      sku: In(lines.map((line) => line.sku)),
    });
    const bySku = new Map(products.map((product) => [product.sku, product]));
    const unknown = lines.find((line) => !bySku.has(line.sku));
    if (unknown) {
      throw new NotFoundException(`Unknown SKU: ${unknown.sku}`);
    }

    // One item per unit: each unit gets its own code, its own delivery and,
    // if it comes to that, its own refund.
    const units = lines.flatMap((line) =>
      Array.from({ length: line.quantity ?? 1 }, () => bySku.get(line.sku)!),
    );
    const currency = units[0].currency;
    if (units.some((product) => product.currency !== currency)) {
      throw new BadRequestException('All items must share one currency');
    }

    const id = await this.dataSource.transaction(async (em) => {
      const order = await em.save(
        em.create(Order, {
          amount: units.reduce((sum, product) => sum + product.price, 0),
          currency,
        }),
      );
      await em.insert(
        OrderItem,
        units.map((product, position) => ({
          orderId: order.id,
          position,
          sku: product.sku,
          amount: product.price,
          currency,
        })),
      );
      return order.id;
    });
    return this.get(id);
  }

  async get(id: string) {
    const order = await this.find(id);

    const [items, deliveries, refunds, attempts] = await Promise.all([
      this.items.find({ where: { orderId: id }, order: { position: 'ASC' } }),
      this.deliveries.findBy({ orderId: id }),
      this.refunds.findBy({ orderId: id }),
      this.attempts.find({ where: { orderId: id }, order: { id: 'ASC' } }),
    ]);
    const discrepancies = await this.discrepancies.find({
      where: { orderItemId: In(items.map((item) => item.id)) },
      order: { id: 'ASC' },
    });
    const deliveryOf = new Map(deliveries.map((d) => [d.orderItemId, d]));
    const refundOf = new Map(refunds.map((r) => [r.orderItemId, r]));

    const sum = (status: ItemStatus[]) =>
      items
        .filter((item) => status.includes(item.status))
        .reduce((total, item) => total + item.amount, 0);
    const paid = [OrderStatus.Created, OrderStatus.PaymentFailed].includes(
      order.status,
    )
      ? 0
      : order.amount;

    return {
      ...order,
      items: items.map((item) => {
        const delivery = deliveryOf.get(item.id);
        const refund = refundOf.get(item.id);
        return {
          id: item.id,
          position: item.position,
          sku: item.sku,
          amount: item.amount,
          status: item.status,
          delivery: delivery
            ? {
                code: delivery.code,
                supplier: delivery.supplier,
                deliveredAt: delivery.createdAt,
              }
            : null,
          refund: refund
            ? {
                amount: refund.amount,
                reason: refund.reason,
                refundedAt: refund.createdAt,
              }
            : null,
        };
      }),
      // What the customer paid, and where every rouble of it is right now.
      money: {
        paid,
        delivered: sum([ItemStatus.Delivered]),
        refunded: sum([ItemStatus.Refunded]),
        pending:
          paid === 0 ? 0 : sum([ItemStatus.Pending, ItemStatus.Refunding]),
      },
      attempts: attempts.map((a) => ({
        itemId: a.orderItemId,
        supplier: a.supplier,
        requestId: a.requestId,
        attempt: a.attempt,
        outcome: a.outcome,
        detail: a.detail,
        latencyMs: a.latencyMs,
        at: a.createdAt,
      })),
      // Where a supplier's answer or book disagreed with us, and what was done.
      discrepancies: discrepancies.map((d) => ({
        itemId: d.orderItemId,
        supplier: d.supplier,
        requestId: d.requestId,
        kind: d.kind,
        supplierCode: d.supplierCode,
        ourCode: d.ourCode,
        resolution: d.resolution,
        at: d.createdAt,
      })),
    };
  }

  // Puts a parked order (delivery_failed) back in the queue. The delivery itself
  // stays idempotent: items already delivered or refunded are skipped, the rest
  // reuse their request_ids and supplier order.
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
