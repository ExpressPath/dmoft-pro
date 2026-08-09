import { sha256 } from "./encoding";
import { getEnv } from "./env";
import { HttpError } from "./errors";
import { query } from "./db";

export type RateLimitDecision = { allowed: boolean; remaining: number; resetAt: number };

export interface RateLimitStore {
  consume(bucketKey: string, limit: number, windowSeconds: number, now: Date): Promise<RateLimitDecision>;
}

export class PostgresRateLimitStore implements RateLimitStore {
  async consume(bucketKey: string, limit: number, windowSeconds: number, now: Date): Promise<RateLimitDecision> {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
    const resetAt = windowStart + windowSeconds;
    const result = await query<{ request_count: number }>(
      `INSERT INTO api_rate_limits (bucket_key, window_start, request_count, expires_at)
       VALUES ($1, $2, 1, to_timestamp($3))
       ON CONFLICT (bucket_key, window_start)
       DO UPDATE SET request_count = api_rate_limits.request_count + 1
       RETURNING request_count`,
      [bucketKey, windowStart, resetAt + windowSeconds],
    );
    const count = result.rows[0]?.request_count ?? limit + 1;
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt };
  }
}

let store: RateLimitStore = new PostgresRateLimitStore();

export function setRateLimitStore(nextStore: RateLimitStore): void {
  store = nextStore;
}

export function getRequestIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

export async function enforceRateLimit(
  request: Request,
  scope: string,
  discriminator: string,
  limit?: number,
): Promise<RateLimitDecision> {
  const env = getEnv();
  const opaqueKey = sha256(`${scope}\0${getRequestIp(request)}\0${discriminator}`).toString("hex");
  const decision = await store.consume(
    `${scope}:${opaqueKey}`,
    limit ?? env.RATE_LIMIT_DEFAULT_MAX,
    env.RATE_LIMIT_WINDOW_SECONDS,
    new Date(),
  );
  if (!decision.allowed) {
    throw new HttpError(429, "rate_limit_exceeded", "Too many requests. Try again after the current window.");
  }
  return decision;
}
