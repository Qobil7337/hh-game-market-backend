import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type IssueResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'out_of_stock' | 'timeout' | 'error'; detail: string };

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
      const detail = `http_${response.status}${body.reason ? ` ${body.reason}` : ''}`;
      if (body.reason === 'out_of_stock') {
        return { ok: false, reason: 'out_of_stock', detail };
      }
      return { ok: false, reason: 'error', detail };
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        return {
          ok: false,
          reason: 'timeout',
          detail: `no response within ${timeoutMs}ms`,
        };
      }
      // fetch wraps network failures as "fetch failed" with the real error in
      // `cause`, occasionally an AggregateError holding one error per address.
      const cause = (error as { cause?: unknown }).cause;
      const inner = cause instanceof AggregateError ? cause.errors[0] : cause;
      const code = (inner as { code?: string } | undefined)?.code;
      const message =
        inner instanceof Error
          ? inner.message
          : error instanceof Error
            ? error.message
            : String(error);
      return { ok: false, reason: 'error', detail: code ?? message };
    }
  }
}
