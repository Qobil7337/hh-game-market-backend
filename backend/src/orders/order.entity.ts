import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum OrderStatus {
  Created = 'created',
  Paid = 'paid',
  Delivering = 'delivering',
  Delivered = 'delivered',
  PaymentFailed = 'payment_failed',
  OutOfStock = 'out_of_stock',
  DeliveryFailed = 'delivery_failed',
}

@Entity('orders')
// The delivery worker polls by status and takes the oldest first.
@Index(['status', 'updatedAt'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  sku: string;

  // Price snapshot taken at creation; the webhook amount is checked against it.
  @Column({ type: 'int' })
  amount: number;

  @Column({ length: 3 })
  currency: string;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.Created })
  status: OrderStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
