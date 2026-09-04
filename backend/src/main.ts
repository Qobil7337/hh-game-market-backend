import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    // Hold startup logs until the logger below is in place.
    { bufferLogs: true },
  );

  // One JSON object per line (LOG_FORMAT=json) or the classic coloured output.
  const json = app.get(ConfigService).get('LOG_FORMAT', 'json') === 'json';
  app.useLogger(new ConsoleLogger({ json }));

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
