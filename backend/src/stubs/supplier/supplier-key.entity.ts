import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

// The supplier's own key pool. It shares our database only because both sides of
// this test project run in one process; a real supplier would keep this itself.
@Entity('supplier_keys')
export class SupplierKey {
  @PrimaryColumn()
  code: string;

  @Index()
  @Column()
  supplier: string;

  // Set once the key is issued. The same request_id always maps back to the same
  // code, which is what a retry after a timeout relies on.
  @Column({ name: 'request_id', type: 'varchar', nullable: true, unique: true })
  requestId: string | null;

  @Column({ name: 'order_id', type: 'varchar', nullable: true })
  orderId: string | null;

  @Column({ type: 'varchar', nullable: true })
  sku: string | null;

  @Column({ name: 'issued_at', type: 'timestamptz', nullable: true })
  issuedAt: Date | null;
}
