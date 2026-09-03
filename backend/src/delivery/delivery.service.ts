import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { transitionOrder } from '../orders/order-transition.js';
import { Order, OrderStatus } from '../orders/order.entity.js';
import { DeliveryAttempt } from './delivery-attempt.entity.js';
import { Delivery } from './delivery.entity.js';
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

// Runs the supplier chain for one order. Timeouts are the whole difficulty here:
// a request that timed out may still have issued a code on the supplier side, so
// after a timeout the only safe move is to ask the *same* supplier again with the
// *same* request_id until it gives a definite answer. Falling back to another
// supplier at that point is how a customer ends up with two codes.
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly client: SupplierClient,
    private readonly config: ConfigService,
  ) {}

  // The order is already `delivering` when this is called.
  async deliver(order: Order): Promise<void> {
    const chain = await this.supplierChain(order.id);
    const outcomes: SupplierOutcome[] = [];

    for (const { supplier, ambiguous } of chain) {
      const outcome = await this.trySupplier(order, supplier, ambiguous);
      outcomes.push(outcome);

      if (outcome.kind === 'ok') {
        await this.complete(order, supplier, outcome.requestId, outcome.code);
        return;
      }
      if (outcome.kind === 'ambiguous') {
        await this.park(
          order,
          OrderStatus.DeliveryFailed,
          `${supplier} timed out and has not answered since; must not fall back`,
        );
        return;
      }
      // out_of_stock and definitive failures leave nothing behind: safe to move on.
    }

    const allOutOfStock = outcomes.every((o) => o.kind === 'out_of_stock');
    await this.park(
      order,
      allOutOfStock ? OrderStatus.OutOfStock : OrderStatus.DeliveryFailed,
      allOutOfStock ? 'no supplier has stock' : 'every supplier failed',
    );
  }

  // Suppliers in the order they should be tried. Any supplier that timed out for
  // this order earlier and never gave a definite answer comes first and is flagged,
  // so a retry resolves the open question before touching anyone else.
  private async supplierChain(
    orderId: string,
  ): Promise<{ supplier: string; ambiguous: boolean }[]> {
    const suppliers = this.config.get<string>('SUPPLIERS', 'a,b').split(',');

    const attempts = await this.dataSource
      .getRepository(DeliveryAttempt)
      .find({ where: { orderId }, order: { id: 'ASC' } });

    const open = new Set<string>();
    for (const { supplier, outcome } of attempts) {
      if (outcome === 'timeout') open.add(supplier);
      if (outcome === 'ok' || outcome === 'out_of_stock') open.delete(supplier);
    }

    return [
      ...[...open].map((supplier) => ({ supplier, ambiguous: true })),
      ...suppliers
        .filter((supplier) => !open.has(supplier))
        .map((supplier) => ({ supplier, ambiguous: false })),
    ];
  }

  private async trySupplier(
    order: Order,
    supplier: string,
    previouslyAmbiguous: boolean,
  ): Promise<SupplierOutcome> {
    const maxAttempts = Number(this.config.get('SUPPLIER_MAX_ATTEMPTS', 3));
    const baseDelayMs = Number(this.config.get('SUPPLIER_RETRY_BASE_MS', 500));
    // Stable per order and supplier, never per attempt: a retry after a timeout must
    // present the same id so the supplier hands back the same code instead of a new one.
    const requestId = `${order.id}:${supplier}`;
    let ambiguous = previouslyAmbiguous;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      const result = await this.client.issue(
        supplier,
        requestId,
        order.id,
        order.sku,
      );
      const outcome = result.ok ? 'ok' : result.reason;
      const detail = result.ok ? null : result.detail;
      const latencyMs = Date.now() - startedAt;

      await this.dataSource.getRepository(DeliveryAttempt).insert({
        orderId: order.id,
        supplier,
        requestId,
        attempt,
        outcome,
        detail,
        latencyMs,
      });
      this.logger.log(
        `order=${order.id} supplier=${supplier} attempt=${attempt} outcome=${outcome} latency=${latencyMs}ms${detail ? ` (${detail})` : ''}`,
      );

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

  private async complete(
    order: Order,
    supplier: string,
    requestId: string,
    code: string,
  ) {
    await this.dataSource.transaction(async (em) => {
      const existing = await em.findOneBy(Delivery, { orderId: order.id });
      if (!existing) {
        await em.insert(Delivery, {
          orderId: order.id,
          requestId,
          supplier,
          code,
        });
      } else if (existing.code !== code) {
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

  private async park(order: Order, status: OrderStatus, why: string) {
    await transitionOrder(
      this.dataSource.manager,
      order.id,
      OrderStatus.Delivering,
      status,
    );
    this.logger.warn(`order=${order.id} -> ${status}: ${why}`);
  }
}
