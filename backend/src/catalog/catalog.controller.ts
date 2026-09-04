import { Controller, Get, Query } from '@nestjs/common';
import { CatalogService } from './catalog.service.js';
import { StorefrontQueryDto } from './dto/storefront-query.dto.js';

@Controller('products')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // GET /products?type=key&limit=50&cursor=<last sku of the previous page>
  @Get()
  list(@Query() query: StorefrontQueryDto) {
    return this.catalog.storefront(query);
  }
}
