import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import type { RefundReason } from '../orders/order-item.entity.js';

// One refund per item, at most. The item id is the primary key and doubles as
// the idempotency key sent to the payment provider, so a repeated step can only
// collide here, never pay the customer twice.
@Entity('refunds')
export class Refund {
  @PrimaryColumn({ name: 'order_item_id', type: 'uuid' })
  orderItemId: string;

  @Index()
  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ type: 'int' })
  amount: number;

  @Column({ length: 3 })
  currency: string;

  @Column({ type: 'varchar' })
  reason: RefundReason;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
