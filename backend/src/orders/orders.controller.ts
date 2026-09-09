import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { IsISO8601 } from 'class-validator';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { OrdersService } from './orders.service.js';

class AtQueryDto {
  @IsISO8601()
  time: string;
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@Body() dto: CreateOrderDto) {
    return this.orders.create(dto);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.orders.get(id);
  }

  // Everything that ever happened to the order, oldest first.
  @Get(':id/history')
  history(@Param('id') id: string) {
    return this.orders.history(id);
  }

  // The order as it was at ?time=<ISO 8601>, replayed from its history.
  @Get(':id/at')
  at(@Param('id') id: string, @Query() query: AtQueryDto) {
    return this.orders.stateAt(id, new Date(query.time));
  }

  // Manual re-delivery for delivery_failed orders.
  @Post(':id/deliver')
  @HttpCode(200)
  retry(@Param('id') id: string) {
    return this.orders.retryDelivery(id);
  }
}
