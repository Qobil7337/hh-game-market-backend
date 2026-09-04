import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProductStock } from '../catalog/product-stock.entity.js';
import { Product } from '../catalog/product.entity.js';
import { SupplierKey } from '../stubs/supplier/supplier-key.entity.js';
import { KEYS, PRODUCTS } from './data.js';

const INITIAL_STOCK = 100;

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  constructor(private readonly dataSource: DataSource) {}

  onApplicationBootstrap() {
    return this.seed();
  }

  // Idempotent: runs on every boot and from tests after a wipe.
  async seed() {
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(Product)
      .values(PRODUCTS)
      .orIgnore()
      .execute();

    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(ProductStock)
      .values(PRODUCTS.map(({ sku }) => ({ sku, available: INITIAL_STOCK })))
      .orIgnore()
      .execute();

    // Split the shared pool between the two suppliers so no code exists on both sides.
    const half = Math.ceil(KEYS.length / 2);
    const keys = KEYS.map((code, index) => ({
      code,
      supplier: index < half ? 'a' : 'b',
    }));

    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(SupplierKey)
      .values(keys)
      .orIgnore()
      .execute();
  }
}
