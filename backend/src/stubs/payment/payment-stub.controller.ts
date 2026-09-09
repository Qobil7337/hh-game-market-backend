import {
  Body,
  Controller,
  Get,
  HttpCode,
  InternalServerErrorException,
  Post,
  Put,
} from '@nestjs/common';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { PaymentStubService } from './payment-stub.service.js';

class RefundDto {
  @IsString()
  @IsNotEmpty()
  refund_id: string;

  @IsString()
  @IsNotEmpty()
  order_id: string;

  @IsInt()
  @Min(1)
  amount: number;

  @IsString()
  @Length(3, 3)
  currency: string;
}

class PspStubConfigDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  errorRate?: number;
}

// The payment provider's refund side. Incoming payments are still emulated by
// webhooks (scripts/pay.mjs); this is the call we make back to it.
@Controller('stubs/payments')
export class PaymentStubController {
  constructor(private readonly stub: PaymentStubService) {}

  @Post('refund')
  @HttpCode(200)
  async refund(@Body() dto: RefundDto) {
    const result = await this.stub.refund(
      dto.refund_id,
      dto.order_id,
      dto.amount,
      dto.currency,
    );
    if (result.status === 'error') {
      throw new InternalServerErrorException(result);
    }
    return result;
  }

  // Test tooling, not part of the contract.
  @Get()
  status() {
    return this.stub.status();
  }

  @Put('config')
  configure(@Body() dto: PspStubConfigDto) {
    return this.stub.setConfig(dto);
  }
}
