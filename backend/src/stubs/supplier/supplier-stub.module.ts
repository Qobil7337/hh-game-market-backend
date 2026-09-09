import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupplierIssue } from './supplier-issue.entity.js';
import { SupplierKey } from './supplier-key.entity.js';
import { SupplierStubController } from './supplier-stub.controller.js';
import { SupplierStubService } from './supplier-stub.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([SupplierKey, SupplierIssue])],
  controllers: [SupplierStubController],
  providers: [SupplierStubService],
})
export class SupplierStubModule {}
