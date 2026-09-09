import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { PspRefund } from './psp-refund.entity.js';

export interface PspStubConfig {
  // Probability (0..1) of answering 5xx without recording anything.
  errorRate: number;
}

@Injectable()
export class PaymentStubService {
  private config: PspStubConfig;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.config = { errorRate: Number(config.get('STUB_PSP_ERROR_RATE', 0)) };
  }

  setConfig(patch: Partial<PspStubConfig>): PspStubConfig {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) this.config[key as keyof PspStubConfig] = value;
    }
    return this.config;
  }

  async status() {
    const [refunds] = await this.dataSource.query(
      'SELECT count(*)::int AS count, coalesce(sum(amount), 0)::int AS amount FROM psp_refunds',
    );
    return { config: this.config, refunds };
  }

  async refund(
    refundId: string,
    orderId: string,
    amount: number,
    currency: string,
  ) {
    if (Math.random() < this.config.errorRate) {
      return { status: 'error', reason: 'internal_error' } as const;
    }
    // Idempotent on refund_id: a retry of the same refund is acknowledged, not
    // paid out again.
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(PspRefund)
      .values({ refundId, orderId, amount, currency })
      .orIgnore()
      .execute();
    return { status: 'ok', refund_id: refundId } as const;
  }
}
