import { Module } from '@nestjs/common';
import { SeedService } from './seed.service.js';

@Module({
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}
