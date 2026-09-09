import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

// The supplier's book: what it says it issued, per request_id. This is what a
// real supplier bills against and exposes as a statement, and it is the only
// thing on the supplier side our code reads (over HTTP, never from the table).
// A dishonest supplier can book one code under two request_ids, or book one
// code and answer with another; the book is where that becomes visible.
@Entity('supplier_issues')
export class SupplierIssue {
  @PrimaryColumn({ name: 'request_id' })
  requestId: string;

  @Index()
  @Column()
  supplier: string;

  @Column()
  code: string;

  @Column({ name: 'order_id' })
  orderId: string;

  @Column()
  sku: string;

  @CreateDateColumn({ name: 'issued_at', type: 'timestamptz' })
  issuedAt: Date;
}
