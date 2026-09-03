import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsString,
  Length,
  Min,
} from 'class-validator';
import type { PaymentStatus } from '../payment-event.entity.js';

// Field names follow the PSP contract verbatim.
export class PaymentWebhookDto {
  @IsString()
  @IsNotEmpty()
  event_id: string;

  @IsString()
  @IsNotEmpty()
  order_id: string;

  @IsIn(['paid', 'failed'])
  status: PaymentStatus;

  @IsInt()
  @Min(0)
  amount: number;

  @IsString()
  @Length(3, 3)
  currency: string;

  @IsISO8601()
  created_at: string;
}
