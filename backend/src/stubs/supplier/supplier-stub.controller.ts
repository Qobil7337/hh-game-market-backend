import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { SupplierStubService } from './supplier-stub.service.js';

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

// Two suppliers, "a" and "b", each with its own key pool.
@Controller('stubs/suppliers/:supplier')
export class SupplierStubController {
  constructor(private readonly stub: SupplierStubService) {}

  @Post('issue')
  @HttpCode(200)
  async issue(@Param('supplier') supplier: string, @Body() dto: IssueDto) {
    const result = await this.stub.issue(
      supplier,
      dto.request_id,
      dto.order_id,
      dto.sku,
    );
    if (result.status === 'error') {
      throw new ConflictException(result);
    }
    return result;
  }
}
