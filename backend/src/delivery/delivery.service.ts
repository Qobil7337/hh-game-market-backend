import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, QueryFailedError } from 'typeorm';
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
import { AttemptOutcome, DeliveryAttempt } from './delivery-attempt.entity.js';
import { Delivery } from './delivery.entity.js';
import { PspClient } from './psp.client.js';
import { Refund } from './refund.entity.js';
import {
  DiscrepancyKind,
  SupplierDiscrepancy,
} from './supplier-discrepancy.entity.js';
import { SupplierClient } from './supplier.client.js';

// No call was made: the supplier's rate limit is spent until nextSlotAt. The
// item stays pending and the order goes back to the queue, keeping its place.
type Deferred = { kind: 'deferred'; nextSlotAt: Date };

type IssueOutcome =
  // The supplier answered with a code (or its book showed one after a
  // non-answer). Not yet trusted: `verified` says whether it came from the book.
  | { kind: 'issued'; code: string; verified: boolean }
  // Definitive: the supplier told us nothing was issued.
  | { kind: 'out_of_stock' }
  // Definitive: nothing is booked for us (never reached it, or the book is empty).
  | { kind: 'failed' }
  // Could not find out: answers and the book lookup both failed.
  | { kind: 'ambiguous' }
  | Deferred;

type SupplierOutcome =
  | { kind: 'delivered' }
  | { kind: 'out_of_stock' }
  | { kind: 'failed' }
  | { kind: 'ambiguous' }
  | Deferred;

// What one pass over an item leaves behind for the order's verdict.
interface ItemResult {
  // Still pending because of a supplier's rate limit; try again at this time.
  deferredUntil?: Date;
  // Still open for a reason only a later pass can settle (ambiguous supplier,
  // refund call failed).
  unresolved?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs the supplier chain for every item of one order. The supplier's answer
// is treated as a claim, not a fact: a timeout or a 5xx may still have booked
// a code, an "ok" may carry a code that was already handed to somebody else or
// one the supplier never booked. Two things settle every claim — the
// supplier's own book (GET /issued, what it will bill for) and our deliveries
// table (a code can be delivered once). Nothing reaches a customer before both
// agree, and every disagreement is written down as a discrepancy.
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
    let deferredUntil: Date | undefined;
    let unresolved = false;
    for (const item of await this.items(order.id)) {
      let result: ItemResult = {};
      if (item.status === ItemStatus.Pending) {
        result = await this.deliverItem(order, item);
      } else if (item.status === ItemStatus.Refunding) {
        result = { unresolved: !(await this.refund(order, item)) };
      }
      if (
        result.deferredUntil &&
        (!deferredUntil || result.deferredUntil > deferredUntil)
      ) {
        deferredUntil = result.deferredUntil;
      }
      unresolved ||= result.unresolved ?? false;
    }
    await this.finish(order, { deferredUntil, unresolved });
  }

  private items(orderId: string) {
    return this.dataSource
      .getRepository(OrderItem)
      .find({ where: { orderId }, order: { position: 'ASC' } });
  }

  private async deliverItem(
    order: Order,
    item: OrderItem,
  ): Promise<ItemResult> {
    const chain = await this.supplierChain(item);
    const outcomes: SupplierOutcome[] = [];

    for (const { supplier, ambiguous } of chain) {
      const outcome = await this.trySupplier(order, item, supplier, ambiguous);
      outcomes.push(outcome);

      if (outcome.kind === 'delivered') {
        return {};
      }
      if (outcome.kind === 'deferred') {
        // Not a failure: the supplier is simply busy. No fallback either — a
        // second supplier for a rate-limited one would double the load and
        // change who stocks the SKU; the item waits for its slot.
        return { deferredUntil: outcome.nextSlotAt };
      }
      if (outcome.kind === 'ambiguous') {
        // The supplier may hold a code for this item: neither a fallback nor a
        // refund is safe. The item stays pending and the order parks for a retry.
        this.logger.warn({
          event: 'delivery.item_unresolved',
          orderId: order.id,
          itemId: item.id,
          supplier,
          reason: `${supplier} gave no definite answer and its book is unreachable; must not fall back`,
        });
        return { unresolved: true };
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
    return { unresolved: !(await this.refund(order, item)) };
  }

  // Suppliers in the order they should be tried: the one that stocks the SKU
  // first, the others as fallbacks. Any supplier whose last word for this item
  // was a timeout or an error (it may have booked a code) jumps the queue and
  // is flagged, so a retry resolves the open question before touching anyone else.
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
      if (outcome === 'timeout' || outcome === 'error') open.add(supplier);
      if (['ok', 'out_of_stock', 'none_issued', 'rejected'].includes(outcome)) {
        open.delete(supplier);
      }
    }

    return [
      ...[...open].map((supplier) => ({ supplier, ambiguous: true })),
      ...ordered
        .filter((supplier) => !open.has(supplier))
        .map((supplier) => ({ supplier, ambiguous: false })),
    ];
  }

  // One supplier, up to SUPPLIER_MAX_ROUNDS request_ids. A round ends with a
  // delivery, a definitive "no", or a code we had to reject (already delivered
  // to someone else, or not in the supplier's book); after a rejection the next
  // round presents a fresh request_id, because the same id would only bring
  // the same bad code back.
  private async trySupplier(
    order: Order,
    item: OrderItem,
    supplier: string,
    previouslyAmbiguous: boolean,
  ): Promise<SupplierOutcome> {
    const maxRounds = Number(this.config.get('SUPPLIER_MAX_ROUNDS', 3));
    const firstRound = 1 + (await this.rejectedRounds(item, supplier));

    for (let round = firstRound; round <= maxRounds; round++) {
      // Stable per item, supplier and round, never per attempt: a retry after a
      // timeout must present the same id so the supplier hands back the same code.
      const requestId =
        round === 1
          ? `${item.id}:${supplier}`
          : `${item.id}:${supplier}:${round}`;
      const issued = await this.issue(
        order,
        item,
        supplier,
        requestId,
        previouslyAmbiguous,
      );
      if (issued.kind !== 'issued') {
        return issued;
      }
      const accepted = await this.accept(item, supplier, requestId, issued);
      if (accepted.kind !== 'rejected') {
        return accepted;
      }
    }
    // Rounds exhausted: this supplier keeps handing out codes we cannot use.
    return { kind: 'failed' };
  }

  private async rejectedRounds(item: OrderItem, supplier: string) {
    return this.dataSource.getRepository(SupplierDiscrepancy).countBy([
      { orderItemId: item.id, supplier, kind: 'duplicate_code' },
      { orderItemId: item.id, supplier, kind: 'unbooked_code' },
    ]);
  }

  // The attempt loop for one request_id, then — if the answers were not
  // definitive — the supplier's book, which is the only thing that can tell
  // whether a timeout or a 5xx booked a code.
  private async issue(
    order: Order,
    item: OrderItem,
    supplier: string,
    requestId: string,
    previouslyAmbiguous: boolean,
  ): Promise<IssueOutcome> {
    const maxAttempts = Number(this.config.get('SUPPLIER_MAX_ATTEMPTS', 3));
    const baseDelayMs = Number(this.config.get('SUPPLIER_RETRY_BASE_MS', 500));
    let unknown = previouslyAmbiguous;
    let sawError = false;
    let sawTimeout = false;
    let attempt = 0;

    for (attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      const result = await this.client.issue(
        supplier,
        requestId,
        order.id,
        item.sku,
      );
      if (!result.ok && result.reason === 'rate_limited') {
        // Nothing was sent, so nothing to record as an attempt.
        return { kind: 'deferred', nextSlotAt: result.nextSlotAt };
      }
      await this.recordAttempt(item, supplier, requestId, attempt, {
        outcome: result.ok ? 'ok' : result.reason,
        detail: result.ok ? null : result.detail,
        latencyMs: Date.now() - startedAt,
      });

      if (result.ok) {
        return { kind: 'issued', code: result.code, verified: false };
      }
      // The supplier looks the request_id up before reserving, so "out of stock" on a
      // retry also proves the call that timed out issued nothing.
      if (result.reason === 'out_of_stock') {
        return { kind: 'out_of_stock' };
      }
      if (result.reason === 'timeout' || result.reason === 'error') {
        unknown = true;
        sawError ||= result.reason === 'error';
        sawTimeout ||= result.reason === 'timeout';
      }
      if (attempt < maxAttempts) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }

    // Only "unreachable" answers: nothing was ever sent, nothing can be booked.
    if (!unknown) {
      return { kind: 'failed' };
    }

    // Timeouts or 5xx: ask the book before leaving this supplier. Falling
    // back or refunding while it holds a code for us is how a customer ends up
    // with two codes, or with a code and their money.
    const startedAt = Date.now();
    const booked = await this.client.lookup(supplier, requestId);
    const latencyMs = Date.now() - startedAt;
    if ('deferred' in booked) {
      return { kind: 'deferred', nextSlotAt: booked.deferred };
    }
    if ('error' in booked) {
      await this.recordAttempt(item, supplier, requestId, attempt, {
        outcome: booked.error.startsWith('no response') ? 'timeout' : 'error',
        detail: `book lookup: ${booked.error}`,
        latencyMs,
      });
      return { kind: 'ambiguous' };
    }
    if (!booked.found) {
      // After a 5xx the supplier has finished with the request, so an empty
      // book is final. After a timeout it is not: the request may still be
      // in flight on the supplier side, and a code booked a second from now
      // would become a second code once we move on. Park instead; the next
      // pass (after the recovery cooldown, or the operator's retry) reads
      // the book again and then trusts it.
      if (sawTimeout && !previouslyAmbiguous) {
        await this.recordAttempt(item, supplier, requestId, attempt, {
          outcome: 'timeout',
          detail:
            'book lookup: nothing booked yet, but the request may still be in flight; checked again on the next pass',
          latencyMs,
        });
        return { kind: 'ambiguous' };
      }
      await this.recordAttempt(item, supplier, requestId, attempt, {
        outcome: 'none_issued',
        detail: 'book lookup: nothing booked under this request_id',
        latencyMs,
      });
      return { kind: 'failed' };
    }
    await this.recordAttempt(item, supplier, requestId, attempt, {
      outcome: 'ok',
      detail: 'book lookup: code taken from the supplier book',
      latencyMs,
    });
    if (sawError) {
      await this.discrepancy(supplier, requestId, item.id, 'error_but_issued', {
        supplierCode: booked.code,
        resolution: 'delivered the booked code; no second request made',
      });
    }
    return { kind: 'issued', code: booked.code, verified: true };
  }

  // A code is delivered only once the supplier's book confirms it and our
  // deliveries table accepts it. Any disagreement is recorded and the
  // outcome is either a corrected delivery or a rejection (→ new round).
  private async accept(
    item: OrderItem,
    supplier: string,
    requestId: string,
    issued: { code: string; verified: boolean },
  ): Promise<
    | { kind: 'delivered' }
    | { kind: 'rejected' }
    | { kind: 'ambiguous' }
    | Deferred
  > {
    let code = issued.code;

    if (!issued.verified) {
      const booked = await this.client.lookup(supplier, requestId);
      if ('deferred' in booked) {
        // The next pass re-issues under the same request_id (same code, by
        // contract) and verifies then.
        return { kind: 'deferred', nextSlotAt: booked.deferred };
      }
      if ('error' in booked) {
        // Written down as an attempt on purpose: the supplier answered "ok",
        // so it holds a code for us, and the next pass must come back here
        // (supplierChain treats a trailing timeout/error as "still open")
        // instead of asking anyone else.
        await this.recordAttempt(item, supplier, requestId, 0, {
          outcome: booked.error.startsWith('no response') ? 'timeout' : 'error',
          detail: `book verify: ${booked.error}`,
          latencyMs: 0,
        });
        this.logger.warn({
          event: 'delivery.verify_failed',
          itemId: item.id,
          supplier,
          requestId,
          detail: booked.error,
        });
        return { kind: 'ambiguous' };
      }
      if (!booked.found) {
        await this.discrepancy(supplier, requestId, item.id, 'unbooked_code', {
          supplierCode: code,
          resolution: 'code not delivered; asked again under a new request_id',
        });
        await this.recordAttempt(item, supplier, requestId, 0, {
          outcome: 'rejected',
          detail: 'answered code is not in the supplier book',
          latencyMs: 0,
        });
        return { kind: 'rejected' };
      }
      if (booked.code !== code) {
        await this.discrepancy(supplier, requestId, item.id, 'code_mismatch', {
          supplierCode: code,
          ourCode: booked.code,
          resolution: 'delivered the booked code, ignored the answered one',
        });
        code = booked.code;
      }
    }

    try {
      await this.complete(item, supplier, requestId, code);
      return { kind: 'delivered' };
    } catch (error) {
      if (!isDuplicateCode(error)) {
        throw error;
      }
      const holder = await this.dataSource
        .getRepository(Delivery)
        .findOneBy({ code });
      await this.discrepancy(supplier, requestId, item.id, 'duplicate_code', {
        supplierCode: code,
        resolution: `code already delivered to item ${holder?.orderItemId ?? '?'}; asked again under a new request_id`,
      });
      await this.recordAttempt(item, supplier, requestId, 0, {
        outcome: 'rejected',
        detail: 'code already delivered to another item',
        latencyMs: 0,
      });
      return { kind: 'rejected' };
    }
  }

  private async recordAttempt(
    item: OrderItem,
    supplier: string,
    requestId: string,
    attempt: number,
    result: {
      outcome: AttemptOutcome;
      detail: string | null;
      latencyMs: number;
    },
  ) {
    await this.dataSource.getRepository(DeliveryAttempt).insert({
      orderId: item.orderId,
      orderItemId: item.id,
      supplier,
      requestId,
      attempt,
      ...result,
    });
    this.logger.log({
      event: 'delivery.attempt',
      orderId: item.orderId,
      itemId: item.id,
      sku: item.sku,
      supplier,
      requestId,
      attempt,
      ...result,
    });
  }

  private async discrepancy(
    supplier: string,
    requestId: string,
    orderItemId: string,
    kind: DiscrepancyKind,
    fields: { supplierCode: string; ourCode?: string; resolution: string },
  ) {
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(SupplierDiscrepancy)
      .values({
        supplier,
        requestId,
        orderItemId,
        kind,
        supplierCode: fields.supplierCode,
        ourCode: fields.ourCode ?? null,
        resolution: fields.resolution,
      })
      .orIgnore()
      .execute();
    this.logger.warn({
      event: 'supplier.discrepancy',
      supplier,
      requestId,
      itemId: orderItemId,
      kind,
      ...fields,
    });
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
  private async refund(order: Order, item: OrderItem): Promise<boolean> {
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
      return false;
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
    return true;
  }

  // Derives the order's outcome from its items: final only when every item is
  // either delivered or refunded; back in the queue when only a rate limit is
  // in the way; parked for a retry otherwise.
  private async finish(
    order: Order,
    pass: { deferredUntil?: Date; unresolved: boolean },
  ) {
    const items = await this.items(order.id);
    const open = items.filter(
      (item) =>
        item.status === ItemStatus.Pending ||
        item.status === ItemStatus.Refunding,
    );
    if (open.length > 0 && pass.deferredUntil && !pass.unresolved) {
      // Back to `paid` with its original paid_at, so it keeps its place in
      // the queue, and a not_before so the worker does not spin on it.
      await transitionOrder(
        this.dataSource.manager,
        order.id,
        OrderStatus.Delivering,
        OrderStatus.Paid,
        { notBefore: pass.deferredUntil },
      );
      this.logger.log({
        event: 'delivery.queued',
        orderId: order.id,
        notBefore: pass.deferredUntil,
        reason: `${open.length} of ${items.length} item(s) waiting for a supplier slot`,
      });
      return;
    }
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

// Postgres unique violation on deliveries.code: the last line of defence
// against one code reaching two customers.
function isDuplicateCode(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driver = error.driverError as { code?: string; detail?: string };
  return driver.code === '23505' && /\(code\)=/.test(driver.detail ?? '');
}
