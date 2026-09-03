import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type AttemptOutcome = 'ok' | 'timeout' | 'error' | 'out_of_stock';

// One row per call to a supplier. This is the evidence trail for "which supplier
// may still hold a code for this order" and for the reconciliation stage.
@Entity('delivery_attempts')
export class DeliveryAttempt {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column()
  supplier: string;

  @Column({ name: 'request_id' })
  requestId: string;

  @Column({ type: 'int' })
  attempt: number;

  @Column({ type: 'varchar' })
  outcome: AttemptOutcome;

  // e.g. "http_500 internal_error", "ECONNREFUSED", "no response within 3000ms".
  @Column({ type: 'varchar', nullable: true })
  detail: string | null;

  @Column({ name: 'latency_ms', type: 'int' })
  latencyMs: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
