import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { ProductStock } from './product-stock.entity.js';
import { Product } from './product.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([Product, ProductStock])],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService, TypeOrmModule],
})
export class CatalogModule {}
