import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { OrderItem } from './order-item.entity.js';

export enum OrderStatus {
  Created = 'created',
  Paid = 'paid',
  Delivering = 'delivering',
  // Final: every item was issued.
  Delivered = 'delivered',
  // Final: some items were issued, the rest were refunded.
  PartiallyDelivered = 'partially_delivered',
  // Final: nothing could be issued, everything was refunded.
  Refunded = 'refunded',
  PaymentFailed = 'payment_failed',
  // Recoverable: at least one item is still open (a supplier that timed out may
  // hold a code for it, or a refund call failed) and must be retried.
  DeliveryFailed = 'delivery_failed',
}

export const FINAL_STATUSES = [
  OrderStatus.Delivered,
  OrderStatus.PartiallyDelivered,
  OrderStatus.Refunded,
  OrderStatus.PaymentFailed,
];

@Entity('orders')
// The delivery worker polls by status and takes the earliest paid first.
@Index(['status', 'paidAt'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Sum of the item prices, snapshotted at creation; the webhook amount is
  // checked against it.
  @Column({ type: 'int' })
  amount: number;

  @Column({ length: 3 })
  currency: string;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.Created })
  status: OrderStatus;

  @OneToMany(() => OrderItem, (item) => item.order)
  items: OrderItem[];

  // When the payment was applied. The delivery queue is served in this order,
  // and an order sent back to the queue keeps its place.
  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  // Set when a supplier's rate limit sent the order back to the queue: the
  // worker does not claim it again before this moment.
  @Column({ name: 'not_before', type: 'timestamptz', nullable: true })
  notBefore: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
