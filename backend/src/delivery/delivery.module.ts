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
import { SupplierClient } from './supplier.client.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Delivery,
      DeliveryAttempt,
      Refund,
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
    SupplierClient,
    PspClient,
  ],
  exports: [DeliveryWorker, RecoveryService, TypeOrmModule],
})
export class DeliveryModule {}
