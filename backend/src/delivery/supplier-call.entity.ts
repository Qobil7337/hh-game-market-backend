import {
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Column,
} from 'typeorm';

// One row per call we are about to make to a supplier, for the sliding-window
// rate limit. Lives in the database so every app instance draws from the same
// budget; rows older than the window are swept on each acquisition.
@Entity('supplier_calls')
@Index(['supplier', 'at'])
export class SupplierCall {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  supplier: string;

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;
}
