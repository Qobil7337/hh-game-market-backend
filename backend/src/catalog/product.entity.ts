import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('products')
// Drives the storefront listing: type filter + sku order, only over active rows.
@Index('products_type_sku_active_idx', ['type', 'sku'], { where: 'active' })
export class Product {
  @PrimaryColumn()
  sku: string;

  @Column()
  name: string;

  @Column()
  type: string;

  // Base price in whole RUB, exactly as the catalog lists it.
  @Column({ type: 'int' })
  price: number;

  @Column({ length: 3 })
  currency: string;

  @Column()
  image: string;

  @Column({ default: true })
  active: boolean;
}
