import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export type LedgerAccount = 'cash' | 'customer_liability' | 'revenue';
export type LedgerReason = 'payment' | 'delivery';

// Append-only double-entry journal. Every business event posts a balanced pair
// of rows inside the same transaction that changes the order, so the whole
// table always sums to zero and per-account balances can be checked against
// the orders table at any time.
@Entity('ledger_entries')
@Unique(['reason', 'reference', 'account'])
export class LedgerEntry {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ type: 'varchar' })
  account: LedgerAccount;

  // Signed: assets positive, liabilities and revenue negative.
  @Column({ type: 'int' })
  amount: number;

  @Column({ length: 3 })
  currency: string;

  @Column({ type: 'varchar' })
  reason: LedgerReason;

  // event_id for payments, order id for deliveries: posting the same fact twice
  // violates the unique constraint instead of doubling the books.
  @Column()
  reference: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
