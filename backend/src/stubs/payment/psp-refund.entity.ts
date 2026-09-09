import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

// The payment provider's own record of refunds. Like the supplier key pool it
// lives in our database only because the stub runs in this process.
@Entity('psp_refunds')
export class PspRefund {
  // A repeated refund_id collides here and moves no money.
  @PrimaryColumn({ name: 'refund_id' })
  refundId: string;

  @Column({ name: 'order_id' })
  orderId: string;

  @Column({ type: 'int' })
  amount: number;

  @Column({ length: 3 })
  currency: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
