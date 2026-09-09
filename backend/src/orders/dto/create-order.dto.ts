import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class OrderLineDto {
  @IsString()
  @IsNotEmpty()
  sku: string;

  // Every unit becomes its own order item with its own code.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  quantity?: number;
}

// Either a single `sku` (the stage-1 shape) or a list of `items`.
export class CreateOrderDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  sku?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  items?: OrderLineDto[];
}
