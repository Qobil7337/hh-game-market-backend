import { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import { OrderEvent } from '../history/order-event.entity.js';
import { ItemStatus, OrderItem } from './order-item.entity.js';
import { Order, OrderStatus } from './order.entity.js';

// Compare-and-set on the status column. If a concurrent writer already moved the
// row on, the UPDATE matches zero rows and we refuse instead of overwriting —
// that is what makes every retry in the system safe. Every transition that
// goes through also leaves an event in the same transaction, which is what
// makes the history complete.
async function transition(
  em: EntityManager,
  target: EntityTarget<ObjectLiteral>,
  id: string,
  from: string,
  to: string,
  extra: Record<string, unknown>,
  detail: Record<string, unknown>,
): Promise<void> {
  const isOrder = target === Order;
  const result = await em
    .createQueryBuilder()
    .update(target)
    .set({ status: to, ...extra })
    .where('id = :id AND status = :from', { id, from })
    .returning(isOrder ? 'id' : 'order_id')
    .execute();

  if (result.affected !== 1) {
    throw new Error(`Row ${id} is no longer ${from}; cannot move to ${to}`);
  }

  await em.insert(OrderEvent, {
    orderId: isOrder ? id : (result.raw[0] as { order_id: string }).order_id,
    orderItemId: isOrder ? null : id,
    type: isOrder ? 'order.status' : 'item.status',
    data: { from, to, ...extra, ...detail },
  });
}

export function transitionOrder(
  em: EntityManager,
  id: string,
  from: OrderStatus,
  to: OrderStatus,
  extra: Partial<Pick<Order, 'paidAt' | 'notBefore'>> = {},
  // Goes into the event only, not into the row.
  detail: Record<string, unknown> = {},
) {
  return transition(em, Order, id, from, to, extra, detail);
}

export function transitionItem(
  em: EntityManager,
  id: string,
  from: ItemStatus,
  to: ItemStatus,
  extra: Partial<Pick<OrderItem, 'refundReason'>> = {},
  detail: Record<string, unknown> = {},
) {
  return transition(em, OrderItem, id, from, to, extra, detail);
}
