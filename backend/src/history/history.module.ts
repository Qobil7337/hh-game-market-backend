import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HistoryService } from './history.service.js';
import { OrderEvent } from './order-event.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([OrderEvent])],
  providers: [HistoryService],
  exports: [HistoryService, TypeOrmModule],
})
export class HistoryModule {}
