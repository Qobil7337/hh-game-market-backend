import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupplierKey } from './supplier-key.entity.js';
import { SupplierStubController } from './supplier-stub.controller.js';
import { SupplierStubService } from './supplier-stub.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([SupplierKey])],
  controllers: [SupplierStubController],
  providers: [SupplierStubService],
})
export class SupplierStubModule {}
