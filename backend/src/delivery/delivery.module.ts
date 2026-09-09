import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogModule } from '../catalog/catalog.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { OrderItem } from '../orders/order-item.entity.js';
import { Order } from '../orders/order.entity.js';
import { DeliveryAttempt } from './delivery-attempt.entity.js';
import { Delivery } from './delivery.entity.js';
import { DeliveryService } from './delivery.service.js';
import { DeliveryWorker } from './delivery.worker.js';
import { PspClient } from './psp.client.js';
import { RecoveryService } from './recovery.service.js';
import { Refund } from './refund.entity.js';
import { SupplierAuditService } from './supplier-audit.service.js';
import { SupplierCall } from './supplier-call.entity.js';
import { SupplierDiscrepancy } from './supplier-discrepancy.entity.js';
import { SupplierLimiter } from './supplier-limiter.service.js';
import { SupplierClient } from './supplier.client.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Delivery,
      DeliveryAttempt,
      Refund,
      SupplierDiscrepancy,
      SupplierCall,
      Order,
      OrderItem,
    ]),
    CatalogModule,
    LedgerModule,
  ],
  providers: [
    DeliveryWorker,
    DeliveryService,
    RecoveryService,
    SupplierAuditService,
    SupplierLimiter,
    SupplierClient,
    PspClient,
  ],
  exports: [
    DeliveryWorker,
    RecoveryService,
    SupplierAuditService,
    SupplierLimiter,
    TypeOrmModule,
  ],
})
export class DeliveryModule {}
