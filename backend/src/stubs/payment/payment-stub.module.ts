import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentStubController } from './payment-stub.controller.js';
import { PaymentStubService } from './payment-stub.service.js';
import { PspRefund } from './psp-refund.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([PspRefund])],
  controllers: [PaymentStubController],
  providers: [PaymentStubService],
})
export class PaymentStubModule {}
