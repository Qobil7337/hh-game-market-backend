import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../orders/order.entity.js';
import { Delivery } from './delivery.entity.js';
import { DeliveryWorker } from './delivery.worker.js';
import { SupplierClient } from './supplier.client.js';

@Module({
  imports: [TypeOrmModule.forFeature([Delivery, Order])],
  providers: [DeliveryWorker, SupplierClient],
  exports: [DeliveryWorker, TypeOrmModule],
})
export class DeliveryModule {}
