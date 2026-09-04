import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerEntry } from './ledger-entry.entity.js';
import { LedgerService } from './ledger.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([LedgerEntry])],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
