import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { PaymentWebhookDto } from './dto/payment-webhook.dto.js';
import { PaymentsService } from './payments.service.js';

@Controller('webhooks')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // Answers 200 for every event we managed to record, including duplicates and
  // events we chose to ignore. A 5xx only escapes on a real failure, which is the
  // signal for the PSP to redeliver.
  @Post('payment')
  @HttpCode(200)
  handle(@Body() dto: PaymentWebhookDto) {
    return this.payments.handle(dto);
  }
}
