import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { OrdersService } from './orders.service.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@Body() dto: CreateOrderDto) {
    return this.orders.create(dto.sku);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.orders.get(id);
  }

  // Manual re-delivery for out_of_stock / delivery_failed orders.
  @Post(':id/deliver')
  @HttpCode(200)
  retry(@Param('id') id: string) {
    return this.orders.retryDelivery(id);
  }
}
