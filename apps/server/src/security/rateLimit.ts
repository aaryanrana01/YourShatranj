import type { Redis } from 'ioredis';
import type { NextFunction, Request, Response } from 'express';

/**
 * Fixed-window counter in Redis: INCR a key named after the current window,
 * set it to expire with the window. Shared by every server instance, so an
 * attacker can't dodge the limit by hitting different instances.
 * Two Redis commands per request, which keeps free-tier usage low.
 */
export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  /** Returns true if this hit is allowed. */
  async hit(name: string, key: string, limit: number, windowSec: number): Promise<boolean> {
    const window = Math.floor(Date.now() / 1000 / windowSec);
    const redisKey = `rl:${name}:${key}:${window}`;
    const [[, count]] = (await this.redis.multi().incr(redisKey).expire(redisKey, windowSec).exec()) as [
      [Error | null, number],
      [Error | null, number],
    ];
    return count <= limit;
  }

  /** Express middleware limiting by client IP. */
  middleware(name: string, limit: number, windowSec: number) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const ok = await this.hit(name, req.ip ?? 'unknown', limit, windowSec);
      if (!ok) {
        res.setHeader('Retry-After', String(windowSec));
        res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests, slow down' });
        return;
      }
      next();
    };
  }
}

/**
 * In-memory token bucket for socket events. Lives with the socket (no Redis
 * cost): each event spends a token; tokens refill at `ratePerSec`.
 */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly ratePerSec: number,
  ) {
    this.tokens = capacity;
  }

  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
