import { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import { ItemStatus, OrderItem } from './order-item.entity.js';
import { Order, OrderStatus } from './order.entity.js';

// Compare-and-set on the status column. If a concurrent writer already moved the
// row on, the UPDATE matches zero rows and we refuse instead of overwriting —
// that is what makes every retry in the system safe.
async function transition(
  em: EntityManager,
  target: EntityTarget<ObjectLiteral>,
  id: string,
  from: string,
  to: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const result = await em
    .createQueryBuilder()
    .update(target)
    .set({ status: to, ...extra })
    .where('id = :id AND status = :from', { id, from })
    .execute();

  if (result.affected !== 1) {
    throw new Error(`Row ${id} is no longer ${from}; cannot move to ${to}`);
  }
}

export function transitionOrder(
  em: EntityManager,
  id: string,
  from: OrderStatus,
  to: OrderStatus,
) {
  return transition(em, Order, id, from, to);
}

export function transitionItem(
  em: EntityManager,
  id: string,
  from: ItemStatus,
  to: ItemStatus,
  extra: Partial<Pick<OrderItem, 'refundReason'>> = {},
) {
  return transition(em, OrderItem, id, from, to, extra);
}
