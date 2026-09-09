import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Order } from './order.entity.js';

export enum ItemStatus {
  // Waiting for a code. An ambiguous supplier answer leaves the item here:
  // nothing is decided yet.
  Pending = 'pending',
  Delivered = 'delivered',
  // Decided: no supplier can issue this line, the money goes back. Kept apart
  // from `refunded` so a refund call that fails, or a crash right after it,
  // is retried without asking the suppliers again.
  Refunding = 'refunding',
  Refunded = 'refunded',
}

export type RefundReason = 'out_of_stock' | 'supplier_failed';

// One unit of one SKU inside an order. Each item is delivered and, if need be,
// refunded on its own, which is what lets an order end "partly delivered" with
// the money still adding up.
@Entity('order_items')
@Index(['orderId', 'position'], { unique: true })
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  // Line number inside the order; items are delivered in this order.
  @Column({ type: 'int' })
  position: number;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column()
  sku: string;

  // Price snapshot for this unit; the delivery or the refund posts exactly this.
  @Column({ type: 'int' })
  amount: number;

  @Column({ length: 3 })
  currency: string;

  @Column({ type: 'enum', enum: ItemStatus, default: ItemStatus.Pending })
  status: ItemStatus;

  @Column({ name: 'refund_reason', type: 'varchar', nullable: true })
  refundReason: RefundReason | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
