import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type IssueResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'out_of_stock' | 'error' | 'timeout' };

interface IssueResponse {
  status?: string;
  code?: string;
  reason?: string;
}

// HTTP client for the supplier contract (POST /issue). The stubs run in this same
// process, but the call still goes over the network so timeouts are real.
@Injectable()
export class SupplierClient {
  constructor(private readonly config: ConfigService) {}

  async issue(
    supplier: string,
    requestId: string,
    orderId: string,
    sku: string,
  ): Promise<IssueResult> {
    const baseUrl = this.config.getOrThrow<string>(
      `SUPPLIER_${supplier.toUpperCase()}_URL`,
    );
    const timeoutMs = Number(this.config.get('SUPPLIER_TIMEOUT_MS', 3000));

    try {
      const response = await fetch(`${baseUrl}/issue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: requestId,
          sku,
          order_id: orderId,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const body = (await response.json().catch(() => ({}))) as IssueResponse;

      if (
        response.ok &&
        body.status === 'ok' &&
        typeof body.code === 'string'
      ) {
        return { ok: true, code: body.code };
      }
      return {
        ok: false,
        reason: body.reason === 'out_of_stock' ? 'out_of_stock' : 'error',
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return { ok: false, reason: timedOut ? 'timeout' : 'error' };
    }
  }
}
