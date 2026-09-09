import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export type DiscrepancyKind =
  // The supplier answered with a code it had already handed to another item.
  | 'duplicate_code'
  // The supplier answered with one code but booked another under our request_id.
  | 'code_mismatch'
  // The supplier answered with a code it never booked.
  | 'unbooked_code'
  // The supplier answered 5xx but its book shows a code for our request_id.
  | 'error_but_issued'
  // The book holds a code for a request we no longer need (rejected round,
  // item settled elsewhere); we will not use it.
  | 'unused_issue'
  // The book holds a request_id we never sent.
  | 'unknown_request';

// Every point where the supplier's answer or book disagreed with what we
// know, and what was done about it. Detection and resolution are automatic;
// this table is the evidence for the dispute with the supplier afterwards.
@Entity('supplier_discrepancies')
@Unique(['supplier', 'requestId', 'kind'])
export class SupplierDiscrepancy {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  supplier: string;

  @Column({ name: 'request_id' })
  requestId: string;

  @Index()
  @Column({ name: 'order_item_id', type: 'uuid', nullable: true })
  orderItemId: string | null;

  @Column({ type: 'varchar' })
  kind: DiscrepancyKind;

  // What the supplier answered / booked.
  @Column({ name: 'supplier_code', type: 'varchar', nullable: true })
  supplierCode: string | null;

  // What we hold, if anything.
  @Column({ name: 'our_code', type: 'varchar', nullable: true })
  ourCode: string | null;

  @Column()
  resolution: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
