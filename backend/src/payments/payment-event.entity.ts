import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

export type PaymentStatus = 'paid' | 'failed';

@Entity('payment_events')
export class PaymentEvent {
  // The PSP's event id is the primary key: a redelivery collides here and is dropped.
  @PrimaryColumn({ name: 'event_id' })
  eventId: string;

  // Plain text on purpose: an event for an unknown or malformed order id is still
  // recorded, so nothing the PSP sent is ever lost.
  @Index()
  @Column({ name: 'order_id' })
  orderId: string;

  @Column({ type: 'varchar' })
  status: PaymentStatus;

  @Column({ type: 'int' })
  amount: number;

  @Column({ length: 3 })
  currency: string;

  // Timestamp from the PSP payload.
  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt: Date;

  // What the handler did with the event: applied, order_not_found, amount_mismatch,
  // ignored_<current order status>.
  @Column()
  outcome: string;
}
