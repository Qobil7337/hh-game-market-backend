import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DeliveryModule } from '../delivery/delivery.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { AdminController } from './admin.controller.js';
import { ReconciliationService } from './reconciliation.service.js';

@Module({
  imports: [DeliveryModule, LedgerModule, CatalogModule],
  controllers: [AdminController],
  providers: [ReconciliationService],
})
export class AdminModule {}
