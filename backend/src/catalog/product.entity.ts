import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('products')
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
}
