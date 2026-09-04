import {
  Check,
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Product } from './product.entity.js';

// Stock counter kept apart from the product row: it changes on every delivery
// while the product itself almost never does, so the wide, cacheable product
// rows are not rewritten for each sale and the storefront never counts keys.
@Entity('product_stock')
@Check('"available" >= 0')
export class ProductStock {
  @PrimaryColumn()
  sku: string;

  @OneToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sku' })
  product: Product;

  @Column({ type: 'int', default: 0 })
  available: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
