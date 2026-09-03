import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../orders/order.entity.js';
import { DeliveryAttempt } from './delivery-attempt.entity.js';
import { Delivery } from './delivery.entity.js';
import { DeliveryService } from './delivery.service.js';
import { DeliveryWorker } from './delivery.worker.js';
import { SupplierClient } from './supplier.client.js';

@Module({
  imports: [TypeOrmModule.forFeature([Delivery, DeliveryAttempt, Order])],
  providers: [DeliveryWorker, DeliveryService, SupplierClient],
  exports: [DeliveryWorker, TypeOrmModule],
})
export class DeliveryModule {}
