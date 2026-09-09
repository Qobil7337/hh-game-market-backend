import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type RefundResult = { ok: true } | { ok: false; detail: string };

// HTTP client for the payment provider's refund call. `refund_id` is the
// idempotency key: sending the same one twice must not move money twice, so a
// failed or timed-out call is simply repeated with the same id.
@Injectable()
export class PspClient {
  constructor(private readonly config: ConfigService) {}

  async refund(
    refundId: string,
    orderId: string,
    amount: number,
    currency: string,
  ): Promise<RefundResult> {
    const baseUrl = this.config.get<string>(
      'PSP_URL',
      'http://localhost:3000/api/stubs/payments',
    );
    const timeoutMs = Number(this.config.get('PSP_TIMEOUT_MS', 3000));

    try {
      const response = await fetch(`${baseUrl}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          refund_id: refundId,
          order_id: orderId,
          amount,
          currency,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await response.json().catch(() => ({}))) as {
        status?: string;
        reason?: string;
      };
      if (response.ok && body.status === 'ok') {
        return { ok: true };
      }
      return {
        ok: false,
        detail: `http_${response.status}${body.reason ? ` ${body.reason}` : ''}`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
