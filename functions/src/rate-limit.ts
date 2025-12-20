type RateLimitRecord = { count: number; resetAtMs: number };

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
  resetAfterSeconds: number;
  retryAfterSeconds?: number;
};

export type RateLimitOptions = {
  windowMs: number;
  maxKeys?: number;
};

type HeaderCapableResponse = {
  setHeader?: (name: string, value: string) => unknown;
  set?: (name: string, value: string) => unknown;
};

type RequestLike = {
  headers?: Record<string, unknown>;
  ip?: unknown;
  socket?: { remoteAddress?: unknown };
};

/**
 * Simple in-memory fixed-window rate limiter.
 *
 * Notes:
 * - Designed for Cloud Functions: low overhead, no external store.
 * - Limits are best-effort across instances (acceptable for a free product).
 */
export class FixedWindowRateLimiter {
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly map = new Map<string, RateLimitRecord>();

  constructor(options: RateLimitOptions) {
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  consume(key: string, limit: number, nowMs: number = Date.now()): RateLimitDecision {
    const now = nowMs;
    const existing = this.map.get(key);

    let record: RateLimitRecord;
    if (!existing || now > existing.resetAtMs) {
      record = { count: 1, resetAtMs: now + this.windowMs };
      this.map.set(key, record);
      this.enforceMaxKeys();
    } else {
      existing.count += 1;
      record = existing;
    }

    const allowed = record.count <= limit;
    const remaining = Math.max(0, limit - record.count);
    const resetAfterSeconds = Math.max(0, Math.ceil((record.resetAtMs - now) / 1000));

    return {
      allowed,
      limit,
      remaining,
      resetAtMs: record.resetAtMs,
      resetAfterSeconds,
      retryAfterSeconds: allowed ? undefined : resetAfterSeconds,
    };
  }

  resetForTests(): void {
    this.map.clear();
  }

  private enforceMaxKeys(): void {
    while (this.map.size > this.maxKeys) {
      const first = this.map.keys().next();
      if (first.done) {
        break;
      }
      this.map.delete(first.value);
    }
  }
}

function setHeaderCompat(res: HeaderCapableResponse, name: string, value: string): void {
  if (typeof res?.setHeader === 'function') {
    res.setHeader(name, value);
    return;
  }
  if (typeof res?.set === 'function') {
    res.set(name, value);
  }
}

export function applyRateLimitHeaders(
  res: HeaderCapableResponse,
  decision: RateLimitDecision
): void {
  // "Reset" is frequently expected as seconds-until-reset.
  const reset = String(decision.resetAfterSeconds);

  setHeaderCompat(res, 'RateLimit-Limit', String(decision.limit));
  setHeaderCompat(res, 'RateLimit-Remaining', String(decision.remaining));
  setHeaderCompat(res, 'RateLimit-Reset', reset);
  setHeaderCompat(
    res,
    'RateLimit',
    `limit=${decision.limit}, remaining=${decision.remaining}, reset=${reset}`
  );

  if (!decision.allowed && decision.retryAfterSeconds != null) {
    setHeaderCompat(res, 'Retry-After', String(decision.retryAfterSeconds));
  }
}

function getHeaderString(headers: Record<string, unknown> | undefined, name: string): string {
  if (!headers) {
    return '';
  }
  const v = headers[name];
  if (typeof v === 'string') {
    return v;
  }
  if (Array.isArray(v)) {
    const first = v[0];
    return typeof first === 'string' ? first : '';
  }
  return '';
}

export function getClientIp(req: RequestLike): string {
  const xf = getHeaderString(req.headers, 'x-forwarded-for') || getHeaderString(req.headers, 'X-Forwarded-For');

  if (typeof xf === 'string' && xf.trim()) {
    // XFF can be "client, proxy1, proxy2"
    const first = xf.split(',')[0]?.trim();
    if (first) {
      return first.slice(0, 64);
    }
  }

  const xr = getHeaderString(req.headers, 'x-real-ip') || getHeaderString(req.headers, 'X-Real-Ip');
  if (typeof xr === 'string' && xr.trim()) {
    return xr.trim().slice(0, 64);
  }

  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  return String(ip || 'unknown').slice(0, 64);
}


