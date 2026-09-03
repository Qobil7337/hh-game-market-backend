import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { Repository } from 'typeorm';
import { Product } from '../catalog/product.entity.js';
import { Delivery } from '../delivery/delivery.entity.js';
import { Order } from './order.entity.js';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(Delivery)
    private readonly deliveries: Repository<Delivery>,
  ) {}

  async create(sku: string): Promise<Order> {
    const product = await this.products.findOneBy({ sku });
    if (!product) {
      throw new NotFoundException(`Unknown SKU: ${sku}`);
    }

    return this.orders.save(
      this.orders.create({
        sku,
        amount: product.price,
        currency: product.currency,
      }),
    );
  }

  async get(id: string) {
    const order = isUUID(id) ? await this.orders.findOneBy({ id }) : null;
    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }

    const delivery = await this.deliveries.findOneBy({ orderId: id });

    return {
      ...order,
      delivery: delivery
        ? {
            code: delivery.code,
            supplier: delivery.supplier,
            deliveredAt: delivery.createdAt,
          }
        : null,
    };
  }
}
