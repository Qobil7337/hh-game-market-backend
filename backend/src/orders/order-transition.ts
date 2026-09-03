import { EntityManager } from 'typeorm';
import { Order, OrderStatus } from './order.entity.js';

// Compare-and-set on the status column. If a concurrent writer already moved the
// order on, the UPDATE matches zero rows and we refuse instead of overwriting —
// that is what makes every retry in the system safe.
export async function transitionOrder(
  em: EntityManager,
  id: string,
  from: OrderStatus,
  to: OrderStatus,
): Promise<void> {
  const result = await em
    .createQueryBuilder()
    .update(Order)
    .set({ status: to })
    .where('id = :id AND status = :from', { id, from })
    .execute();

  if (result.affected !== 1) {
    throw new Error(`Order ${id} is no longer ${from}; cannot move to ${to}`);
  }
}
