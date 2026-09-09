import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type OrderEventType =
  // {amount, currency, items: [{id, position, sku, amount}]}
  | 'order.created'
  // {from, to, ...columns changed with it, ...detail}: every order status change
  | 'order.status'
  // {from, to, ...}: every item status change; delivered carries code and
  // supplier, refunding/refunded carry the reason and amount
  | 'item.status';

// Append-only history of everything that happened to an order. Every row is
// written in the same transaction as the change it describes, so the table
// is complete by construction, and a trigger refuses UPDATE and DELETE, so
// nothing is ever rewritten. Folding the rows up to a moment in time gives
// the order's state at that moment.
@Entity('order_events')
@Index(['orderId', 'id'])
@Index(['at'])
export class OrderEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ name: 'order_item_id', type: 'uuid', nullable: true })
  orderItemId: string | null;

  @Column({ type: 'varchar' })
  type: OrderEventType;

  @Column({ type: 'jsonb' })
  data: Record<string, unknown>;

  // Transaction time: everything committed together carries the same stamp.
  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;
}
