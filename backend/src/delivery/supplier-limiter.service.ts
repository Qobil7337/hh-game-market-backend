import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SupplierCall } from './supplier-call.entity.js';

export type Slot = { ok: true } | { ok: false; nextSlotAt: Date };

// Our window is slightly longer than the supplier's, so jitter on the wire
// cannot make two calls arrive closer together than they were sent.
const SAFETY_MS = 100;

// Sliding-window rate limit per supplier: never more than `limit` calls in any
// `window`, across every instance of the app, because the counter is the
// database. A call takes a slot before it is made; when none is free the
// caller learns when the oldest call leaves the window and defers instead of
// waiting, so a lane blocked on one supplier never holds up the others.
@Injectable()
export class SupplierLimiter {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  // 0 = unlimited. Per-supplier value first, then the common one.
  limit(supplier: string): number {
    return Number(
      this.config.get(
        `SUPPLIER_${supplier.toUpperCase()}_RATE_LIMIT`,
        this.config.get('SUPPLIER_RATE_LIMIT', 0),
      ),
    );
  }

  windowMs(): number {
    return Number(this.config.get('SUPPLIER_RATE_WINDOW_MS', 60_000));
  }

  // Takes `cost` slots at once or none: a caller that needs two calls to get
  // anything done (issue + book check) must not be left holding one while a
  // burst of other callers spends the rest of the window on their first calls.
  async tryAcquire(supplier: string, cost = 1): Promise<Slot> {
    const limit = this.limit(supplier);
    if (limit <= 0) return { ok: true };
    cost = Math.min(cost, limit);
    const windowMs = this.windowMs() + SAFETY_MS;

    return this.dataSource.transaction(async (em) => {
      // One acquisition at a time per supplier, across instances.
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `rate:${supplier}`,
      ]);
      await em.query(
        'DELETE FROM supplier_calls WHERE supplier = $1 AND at < now() - make_interval(secs => $2)',
        [supplier, windowMs / 1000],
      );
      const [row] = (await em.query(
        'SELECT count(*)::int AS used, min(at) AS oldest FROM supplier_calls WHERE supplier = $1',
        [supplier],
      )) as { used: number; oldest: Date | null }[];

      if (row.used + cost <= limit) {
        await em.insert(
          SupplierCall,
          Array.from({ length: cost }, () => ({ supplier })),
        );
        return { ok: true };
      }
      // Everything in the table is inside the window now, so the oldest row
      // is exactly the one whose expiry frees the next slot.
      return {
        ok: false,
        nextSlotAt: new Date(new Date(row.oldest!).getTime() + windowMs),
      };
    });
  }

  // For the progress view: how much of the window is spent right now.
  async usage(supplier: string) {
    const limit = this.limit(supplier);
    const windowMs = this.windowMs();
    const [row] = (await this.dataSource.query(
      `SELECT count(*)::int AS used, min(at) AS oldest
       FROM supplier_calls
       WHERE supplier = $1 AND at >= now() - make_interval(secs => $2)`,
      [supplier, (windowMs + SAFETY_MS) / 1000],
    )) as { used: number; oldest: Date | null }[];
    const nextSlotInMs =
      limit > 0 && row.used >= limit && row.oldest
        ? Math.max(
            0,
            new Date(row.oldest).getTime() + windowMs + SAFETY_MS - Date.now(),
          )
        : 0;
    return {
      limit,
      windowMs,
      used: row.used,
      available: limit > 0 ? Math.max(0, limit - row.used) : null,
      nextSlotInMs,
    };
  }
}
