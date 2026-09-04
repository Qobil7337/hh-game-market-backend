import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import { CatalogService } from '../catalog/catalog.service.js';
import { StorefrontQueryDto } from '../catalog/dto/storefront-query.dto.js';
import { RecoveryService } from '../delivery/recovery.service.js';
import { ReconciliationService } from './reconciliation.service.js';

class SetStockDto {
  @IsInt()
  @Min(0)
  available: number;
}

class GenerateCatalogDto {
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  count: number;
}

// Operator tooling. No auth here on purpose: the assignment does not ask for it,
// and it keeps every scenario reproducible with plain curl.
@Controller('admin')
export class AdminController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly recovery: RecoveryService,
    private readonly catalog: CatalogService,
  ) {}

  @Get('reconciliation')
  reconcile() {
    return this.reconciliation.report();
  }

  // Runs the recovery sweep now instead of waiting for the next interval.
  @Post('recovery')
  @HttpCode(200)
  recover() {
    return this.recovery.sweep();
  }

  @Put('stock/:sku')
  setStock(@Param('sku') sku: string, @Body() dto: SetStockDto) {
    return this.catalog.setStock(sku, dto.available);
  }

  // Fills the catalog with generated SKUs for load experiments.
  @Post('catalog/generate')
  @HttpCode(200)
  generate(@Body() dto: GenerateCatalogDto) {
    return this.catalog.generate(dto.count);
  }

  // EXPLAIN ANALYZE of the storefront query with the given parameters.
  @Get('explain')
  explain(@Query() query: StorefrontQueryDto) {
    return this.catalog.explain(query);
  }
}
