import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from './admin/admin.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { DeliveryModule } from './delivery/delivery.module.js';
import { HealthModule } from './health/health.module.js';
import { LedgerModule } from './ledger/ledger.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { SeedModule } from './seed/seed.module.js';
import { SupplierStubModule } from './stubs/supplier/supplier-stub.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: Number(config.get('DB_PORT', 5432)),
        username: config.get<string>('DB_USERNAME'),
        password: config.get<string>('DB_PASSWORD'),
        database: config.get<string>('DB_DATABASE'),
        autoLoadEntities: true,
        synchronize: config.get('NODE_ENV') !== 'production',
      }),
    }),
    CatalogModule,
    OrdersModule,
    PaymentsModule,
    DeliveryModule,
    LedgerModule,
    SupplierStubModule,
    AdminModule,
    SeedModule,
    HealthModule,
  ],
})
export class AppModule {}
