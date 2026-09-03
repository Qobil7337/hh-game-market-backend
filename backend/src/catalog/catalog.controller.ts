import { Controller, Get } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './product.entity.js';

@Controller('products')
export class CatalogController {
  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
  ) {}

  @Get()
  list() {
    return this.products.find({ order: { sku: 'ASC' } });
  }
}
