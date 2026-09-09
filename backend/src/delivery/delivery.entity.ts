import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { OrderItem } from '../orders/order-item.entity.js';

@Entity('deliveries')
export class Delivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  // One delivery per item, enforced by the database rather than by application logic.
  @Column({ name: 'order_item_id', type: 'uuid', unique: true })
  orderItemId: string;

  @OneToOne(() => OrderItem)
  @JoinColumn({ name: 'order_item_id' })
  item: OrderItem;

  @Column({ name: 'request_id', unique: true })
  requestId: string;

  @Column()
  supplier: string;

  // A code can never be handed to two items, whatever the supplier says.
  @Column({ unique: true })
  code: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
