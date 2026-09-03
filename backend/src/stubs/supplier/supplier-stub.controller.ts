import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { SUPPLIERS, SupplierStubService } from './supplier-stub.service.js';

// Field names follow the supplier contract verbatim.
class IssueDto {
  @IsString()
  @IsNotEmpty()
  request_id: string;

  @IsString()
  @IsNotEmpty()
  sku: string;

  @IsString()
  @IsNotEmpty()
  order_id: string;
}

class StubConfigDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  errorRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  timeoutRate?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  hangMs?: number;
}

class RestockDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  codes: string[];
}

function known(supplier: string): string {
  if (!(SUPPLIERS as readonly string[]).includes(supplier)) {
    throw new NotFoundException(`Unknown supplier: ${supplier}`);
  }
  return supplier;
}

// Two suppliers, "a" and "b", each with its own key pool and its own fault settings.
@Controller('stubs/suppliers/:supplier')
export class SupplierStubController {
  constructor(private readonly stub: SupplierStubService) {}

  // The contract endpoint.
  @Post('issue')
  @HttpCode(200)
  async issue(@Param('supplier') supplier: string, @Body() dto: IssueDto) {
    const result = await this.stub.issue(
      known(supplier),
      dto.request_id,
      dto.order_id,
      dto.sku,
    );
    if (result.status === 'error') {
      throw result.reason === 'out_of_stock'
        ? new ConflictException(result)
        : new InternalServerErrorException(result);
    }
    return result;
  }

  // Everything below is test tooling, not part of the contract.
  @Get()
  status(@Param('supplier') supplier: string) {
    return this.stub.status(known(supplier));
  }

  @Put('config')
  configure(@Param('supplier') supplier: string, @Body() dto: StubConfigDto) {
    return this.stub.setConfig(known(supplier), dto);
  }

  @Post('keys')
  restock(@Param('supplier') supplier: string, @Body() dto: RestockDto) {
    return this.stub.restock(known(supplier), dto.codes);
  }
}
