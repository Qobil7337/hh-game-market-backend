import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupplierLimiter } from './supplier-limiter.service.js';

export type IssueResult =
  | { ok: true; code: string }
  | {
      ok: false;
      // out_of_stock: definitive. unreachable: the request never left (connection
      // refused, unknown host) — definitive too. error / timeout: the supplier
      // may have booked a code regardless of what it answered.
      reason: 'out_of_stock' | 'unreachable' | 'error' | 'timeout';
      detail: string;
    }
  // No call was made: the supplier's rate limit is spent until nextSlotAt.
  | { ok: false; reason: 'rate_limited'; detail: string; nextSlotAt: Date };

export type LookupResult =
  | { found: true; code: string }
  | { found: false }
  | { error: string }
  | { deferred: Date };

export interface StatementEntry {
  request_id: string;
  code: string;
  order_id: string;
  issued_at: string;
}

interface IssueResponse {
  status?: string;
  code?: string;
  reason?: string;
}

// Errors raised before anything was sent: the supplier cannot have acted on them.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

// HTTP client for the supplier contract (POST /issue) and its statement
// (GET /issued). Calls are paid for from the supplier's rate limit before
// they are made: an issue costs two slots — itself and the book lookup that
// always follows it (verification, or the check after a non-answer) — so the
// lookup itself is free, and a burst can never spend a whole window on issues
// whose verifications then starve. The audit's statement costs one. The stubs
// run in this same process, but the calls still go over the network so
// timeouts are real.
@Injectable()
export class SupplierClient {
  constructor(
    private readonly config: ConfigService,
    private readonly limiter: SupplierLimiter,
  ) {}

  async issue(
    supplier: string,
    requestId: string,
    orderId: string,
    sku: string,
  ): Promise<IssueResult> {
    const slot = await this.limiter.tryAcquire(supplier, 2);
    if (!slot.ok) {
      return {
        ok: false,
        reason: 'rate_limited',
        detail: `rate limit of ${supplier} spent; next slot at ${slot.nextSlotAt.toISOString()}`,
        nextSlotAt: slot.nextSlotAt,
      };
    }

    const timeoutMs = this.timeoutMs();
    try {
      const response = await fetch(`${this.baseUrl(supplier)}/issue`, {
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
      if (response.status === 429) {
        // Should not happen with the limiter in front; back off a full window.
        return {
          ok: false,
          reason: 'rate_limited',
          detail,
          nextSlotAt: this.fullWindowFromNow(),
        };
      }
      return { ok: false, reason: 'error', detail };
    } catch (error) {
      const failure = classify(error, timeoutMs);
      return { ok: false, ...failure };
    }
  }

  // What the supplier has booked under one request_id. Prepaid by the issue
  // call it follows, see above.
  async lookup(supplier: string, requestId: string): Promise<LookupResult> {
    const timeoutMs = this.timeoutMs();
    try {
      const url = `${this.baseUrl(supplier)}/issued?request_id=${encodeURIComponent(requestId)}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) {
        return { found: false };
      }
      if (response.status === 429) {
        return { deferred: this.fullWindowFromNow() };
      }
      const body = (await response.json().catch(() => ({}))) as IssueResponse;
      if (response.ok && typeof body.code === 'string') {
        return { found: true, code: body.code };
      }
      return { error: `http_${response.status}` };
    } catch (error) {
      return { error: classify(error, timeoutMs).detail };
    }
  }

  // The whole statement, for the periodic audit. Null when the rate limit
  // has nothing to spare: the audit is background work and simply waits.
  async statement(supplier: string): Promise<StatementEntry[] | null> {
    const slot = await this.limiter.tryAcquire(supplier);
    if (!slot.ok) return null;

    const response = await fetch(`${this.baseUrl(supplier)}/issued`, {
      signal: AbortSignal.timeout(this.timeoutMs()),
    });
    if (response.status === 429) return null;
    if (!response.ok) {
      throw new Error(`statement of ${supplier}: http_${response.status}`);
    }
    const body = (await response.json()) as { issued: StatementEntry[] };
    return body.issued;
  }

  private baseUrl(supplier: string) {
    return this.config.getOrThrow<string>(
      `SUPPLIER_${supplier.toUpperCase()}_URL`,
    );
  }

  private timeoutMs() {
    return Number(this.config.get('SUPPLIER_TIMEOUT_MS', 3000));
  }

  private fullWindowFromNow() {
    return new Date(Date.now() + this.limiter.windowMs());
  }
}

function classify(
  error: unknown,
  timeoutMs: number,
): { reason: 'unreachable' | 'error' | 'timeout'; detail: string } {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return { reason: 'timeout', detail: `no response within ${timeoutMs}ms` };
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
  return {
    reason: code && NOT_SENT.has(code) ? 'unreachable' : 'error',
    detail: code ?? message,
  };
}
