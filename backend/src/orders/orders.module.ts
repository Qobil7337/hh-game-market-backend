import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogModule } from '../catalog/catalog.module.js';
import { DeliveryModule } from '../delivery/delivery.module.js';
import { HistoryModule } from '../history/history.module.js';
import { OrderItem } from './order-item.entity.js';
import { Order } from './order.entity.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem]),
    CatalogModule,
    DeliveryModule,
    HistoryModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
