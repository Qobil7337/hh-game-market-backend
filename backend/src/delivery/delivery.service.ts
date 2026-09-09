import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { CatalogService } from '../catalog/catalog.service.js';
import { Product } from '../catalog/product.entity.js';
import { LedgerService } from '../ledger/ledger.service.js';
import {
  ItemStatus,
  OrderItem,
  RefundReason,
} from '../orders/order-item.entity.js';
import { transitionItem, transitionOrder } from '../orders/order-transition.js';
import { Order, OrderStatus } from '../orders/order.entity.js';
import { DeliveryAttempt } from './delivery-attempt.entity.js';
import { Delivery } from './delivery.entity.js';
import { PspClient } from './psp.client.js';
import { Refund } from './refund.entity.js';
import { SupplierClient } from './supplier.client.js';

type SupplierOutcome =
  | { kind: 'ok'; requestId: string; code: string }
  // Definitive: the supplier told us nothing was issued.
  | { kind: 'out_of_stock' }
  // Definitive: only 5xx / network errors, all of which happen before a code exists.
  | { kind: 'failed' }
  // At least one timeout with no answer since: the supplier may hold a code for us.
  | { kind: 'ambiguous' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs the supplier chain for every item of one order. Timeouts are the whole
// difficulty here: a request that timed out may still have issued a code on the
// supplier side, so after a timeout the only safe move is to ask the *same*
// supplier again with the *same* request_id until it gives a definite answer.
// Falling back to another supplier — or refunding — at that point is how a
// customer ends up with two codes, or with a code and their money.
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly client: SupplierClient,
    private readonly psp: PspClient,
    private readonly config: ConfigService,
    private readonly ledger: LedgerService,
    private readonly catalog: CatalogService,
  ) {}

  // The order is already `delivering` when this is called. Every item is
  // handled on its own and the pass can be restarted at any point: items that
  // are already delivered or refunded are skipped, the rest pick up where they
  // stopped, with the same request_ids.
  async deliver(order: Order): Promise<void> {
    for (const item of await this.items(order.id)) {
      if (item.status === ItemStatus.Pending) {
        await this.deliverItem(order, item);
      } else if (item.status === ItemStatus.Refunding) {
        await this.refund(order, item);
      }
    }
    await this.finish(order);
  }

  private items(orderId: string) {
    return this.dataSource
      .getRepository(OrderItem)
      .find({ where: { orderId }, order: { position: 'ASC' } });
  }

  private async deliverItem(order: Order, item: OrderItem) {
    const chain = await this.supplierChain(item);
    const outcomes: SupplierOutcome[] = [];

    for (const { supplier, ambiguous } of chain) {
      const outcome = await this.trySupplier(order, item, supplier, ambiguous);
      outcomes.push(outcome);

      if (outcome.kind === 'ok') {
        await this.complete(item, supplier, outcome.requestId, outcome.code);
        return;
      }
      if (outcome.kind === 'ambiguous') {
        // The supplier may hold a code for this item: neither a fallback nor a
        // refund is safe. The item stays pending and the order parks for a retry.
        this.logger.warn({
          event: 'delivery.item_unresolved',
          orderId: order.id,
          itemId: item.id,
          supplier,
          reason: `${supplier} timed out and has not answered since; must not fall back`,
        });
        return;
      }
      // out_of_stock and definitive failures leave nothing behind: safe to move on.
    }

    // Every supplier gave a definite "no": this line's money goes back. The
    // decision is written down first, so a crash from here on resumes with the
    // refund and never asks the suppliers again.
    const reason: RefundReason = outcomes.every(
      (o) => o.kind === 'out_of_stock',
    )
      ? 'out_of_stock'
      : 'supplier_failed';
    await transitionItem(
      this.dataSource.manager,
      item.id,
      ItemStatus.Pending,
      ItemStatus.Refunding,
      { refundReason: reason },
    );
    item.status = ItemStatus.Refunding;
    item.refundReason = reason;
    await this.refund(order, item);
  }

  // Suppliers in the order they should be tried: the one that stocks the SKU
  // first, the others as fallbacks. Any supplier that timed out for this item
  // earlier and never gave a definite answer jumps the queue and is flagged, so
  // a retry resolves the open question before touching anyone else.
  private async supplierChain(
    item: OrderItem,
  ): Promise<{ supplier: string; ambiguous: boolean }[]> {
    const suppliers = this.config.get<string>('SUPPLIERS', 'a,b').split(',');
    const product = await this.dataSource
      .getRepository(Product)
      .findOneBy({ sku: item.sku });
    const preferred = product?.supplier ?? suppliers[0];
    const ordered = [
      ...suppliers.filter((supplier) => supplier === preferred),
      ...suppliers.filter((supplier) => supplier !== preferred),
    ];

    const attempts = await this.dataSource
      .getRepository(DeliveryAttempt)
      .find({ where: { orderItemId: item.id }, order: { id: 'ASC' } });

    const open = new Set<string>();
    for (const { supplier, outcome } of attempts) {
      if (outcome === 'timeout') open.add(supplier);
      if (outcome === 'ok' || outcome === 'out_of_stock') open.delete(supplier);
    }

    return [
      ...[...open].map((supplier) => ({ supplier, ambiguous: true })),
      ...ordered
        .filter((supplier) => !open.has(supplier))
        .map((supplier) => ({ supplier, ambiguous: false })),
    ];
  }

  private async trySupplier(
    order: Order,
    item: OrderItem,
    supplier: string,
    previouslyAmbiguous: boolean,
  ): Promise<SupplierOutcome> {
    const maxAttempts = Number(this.config.get('SUPPLIER_MAX_ATTEMPTS', 3));
    const baseDelayMs = Number(this.config.get('SUPPLIER_RETRY_BASE_MS', 500));
    // Stable per item and supplier, never per attempt: a retry after a timeout must
    // present the same id so the supplier hands back the same code instead of a new one.
    const requestId = `${item.id}:${supplier}`;
    let ambiguous = previouslyAmbiguous;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      const result = await this.client.issue(
        supplier,
        requestId,
        order.id,
        item.sku,
      );
      const outcome = result.ok ? 'ok' : result.reason;
      const detail = result.ok ? null : result.detail;
      const latencyMs = Date.now() - startedAt;

      await this.dataSource.getRepository(DeliveryAttempt).insert({
        orderId: order.id,
        orderItemId: item.id,
        supplier,
        requestId,
        attempt,
        outcome,
        detail,
        latencyMs,
      });
      this.logger.log({
        event: 'delivery.attempt',
        orderId: order.id,
        itemId: item.id,
        sku: item.sku,
        supplier,
        requestId,
        attempt,
        outcome,
        latencyMs,
        detail,
      });

      if (result.ok) {
        return { kind: 'ok', requestId, code: result.code };
      }
      // The supplier looks the request_id up before reserving, so "out of stock" on a
      // retry also proves the call that timed out issued nothing.
      if (result.reason === 'out_of_stock') {
        return { kind: 'out_of_stock' };
      }
      if (result.reason === 'timeout') {
        ambiguous = true;
      }
      if (attempt < maxAttempts) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }

    return { kind: ambiguous ? 'ambiguous' : 'failed' };
  }

  // Everything that makes one item's delivery final happens in one transaction:
  // the delivery row, the item status, the ledger postings and the stock counter.
  private async complete(
    item: OrderItem,
    supplier: string,
    requestId: string,
    code: string,
  ) {
    await this.dataSource.transaction(async (em) => {
      const existing = await em.findOneBy(Delivery, { orderItemId: item.id });
      if (!existing) {
        await em.insert(Delivery, {
          orderId: item.orderId,
          orderItemId: item.id,
          requestId,
          supplier,
          code,
        });
      } else if (existing.code !== code) {
        // Should be impossible; refusing keeps the order in `delivering` for a human.
        throw new Error(
          `item=${item.id} already holds a code from ${existing.supplier}, ${supplier} returned a different one`,
        );
      }
      await transitionItem(
        em,
        item.id,
        ItemStatus.Pending,
        ItemStatus.Delivered,
      );
      await this.ledger.recordDelivery(em, item);
      await this.catalog.decrementStock(em, item.sku);
    });

    this.logger.log({
      event: 'delivery.item_delivered',
      orderId: item.orderId,
      itemId: item.id,
      sku: item.sku,
      supplier,
      requestId,
    });
  }

  // The item is already `refunding`. Two steps, each safe to repeat: the
  // provider call carries the item id as its idempotency key, and the booking
  // is a primary-key insert plus a compare-and-set on the item.
  private async refund(order: Order, item: OrderItem) {
    const result = await this.psp.refund(
      item.id,
      order.id,
      item.amount,
      item.currency,
    );
    if (!result.ok) {
      // Still `refunding`: the order parks and the next pass tries again.
      this.logger.warn({
        event: 'refund.failed',
        orderId: order.id,
        itemId: item.id,
        detail: result.detail,
      });
      return;
    }

    await this.dataSource.transaction(async (em) => {
      await em
        .createQueryBuilder()
        .insert()
        .into(Refund)
        .values({
          orderItemId: item.id,
          orderId: order.id,
          amount: item.amount,
          currency: item.currency,
          reason: item.refundReason ?? 'supplier_failed',
        })
        .orIgnore()
        .execute();
      await transitionItem(
        em,
        item.id,
        ItemStatus.Refunding,
        ItemStatus.Refunded,
      );
      await this.ledger.recordRefund(em, item);
    });

    this.logger.log({
      event: 'refund.completed',
      orderId: order.id,
      itemId: item.id,
      sku: item.sku,
      amount: item.amount,
      reason: item.refundReason,
    });
  }

  // Derives the order's outcome from its items: final only when every item is
  // either delivered or refunded, parked for a retry otherwise.
  private async finish(order: Order) {
    const items = await this.items(order.id);
    const open = items.filter(
      (item) =>
        item.status === ItemStatus.Pending ||
        item.status === ItemStatus.Refunding,
    );
    if (open.length > 0) {
      await transitionOrder(
        this.dataSource.manager,
        order.id,
        OrderStatus.Delivering,
        OrderStatus.DeliveryFailed,
      );
      this.logger.warn({
        event: 'delivery.parked',
        orderId: order.id,
        status: OrderStatus.DeliveryFailed,
        reason: `${open.length} of ${items.length} item(s) still open`,
      });
      return;
    }

    const delivered = items.filter(
      (item) => item.status === ItemStatus.Delivered,
    ).length;
    const status =
      delivered === items.length
        ? OrderStatus.Delivered
        : delivered === 0
          ? OrderStatus.Refunded
          : OrderStatus.PartiallyDelivered;
    await transitionOrder(
      this.dataSource.manager,
      order.id,
      OrderStatus.Delivering,
      status,
    );
    this.logger.log({
      event: 'delivery.completed',
      orderId: order.id,
      status,
      delivered,
      refunded: items.length - delivered,
    });
  }
}
