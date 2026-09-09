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
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import { CatalogService } from '../catalog/catalog.service.js';
import { StorefrontQueryDto } from '../catalog/dto/storefront-query.dto.js';
import { RecoveryService } from '../delivery/recovery.service.js';
import { SupplierAuditService } from '../delivery/supplier-audit.service.js';
import { HistoryService } from '../history/history.service.js';
import { ProgressService } from './progress.service.js';
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

// ?at= for a moment, ?from=&to= for a period [from, to); nothing = now.
class MoneyQueryDto {
  @IsOptional()
  @IsISO8601()
  at?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

// Operator tooling. No auth here on purpose: the assignment does not ask for it,
// and it keeps every scenario reproducible with plain curl.
@Controller('admin')
export class AdminController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly recovery: RecoveryService,
    private readonly audit: SupplierAuditService,
    private readonly progress: ProgressService,
    private readonly history: HistoryService,
    private readonly catalog: CatalogService,
  ) {}

  // Money as it was at a moment, or what moved over a period, from the
  // append-only ledger, cross-checked against the order events.
  @Get('money')
  money(@Query() query: MoneyQueryDto) {
    if (query.from || query.to) {
      return this.history.moneyBetween(
        query.from ? new Date(query.from) : new Date(0),
        query.to ? new Date(query.to) : new Date(),
      );
    }
    return this.history.moneyAt(query.at ? new Date(query.at) : new Date());
  }

  @Get('reconciliation')
  reconcile() {
    return this.reconciliation.report();
  }

  // Queue progress: orders by stage, open items, rate-limit usage per supplier.
  @Get('queue')
  queue() {
    return this.progress.snapshot();
  }

  // Runs the recovery sweep now instead of waiting for the next interval.
  @Post('recovery')
  @HttpCode(200)
  recover() {
    return this.recovery.sweep();
  }

  // Compares every supplier's book with our deliveries now instead of waiting
  // for the next interval.
  @Post('supplier-audit')
  @HttpCode(200)
  auditSuppliers() {
    return this.audit.audit();
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
