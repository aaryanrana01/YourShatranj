import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { ChessComGame } from '@chess/shared';
import { HttpError } from './http/errors.js';

/**
 * Client for chess.com's public, read-only Published-Data API.
 *  - Called from the server, not the browser, because chess.com wants a
 *    User-Agent naming the app and a contact, and browsers won't let
 *    JavaScript set that header.
 *  - Requests go out one at a time; parallel requests get HTTP 429.
 *  - Past months never change, so they're cached for a week; the current
 *    month for 5 minutes.
 *  - Their responses are validated like any other untrusted input.
 */

const BASE = 'https://api.chess.com/pub';

const archivesSchema = z.object({ archives: z.array(z.string().url()) });
const playerSchema = z.object({ username: z.string(), rating: z.number().optional(), result: z.string().optional() });
const gamesSchema = z.object({
  games: z.array(
    z
      .object({
        url: z.string(),
        pgn: z.string().optional(),
        time_class: z.string().optional(),
        time_control: z.string().optional(),
        rules: z.string().optional(),
        end_time: z.number().optional(),
        accuracies: z.object({ white: z.number(), black: z.number() }).optional(),
        white: playerSchema,
        black: playerSchema,
      })
      .passthrough(),
  ),
});

export class ChessComClient {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly redis: Redis,
    private readonly userAgent: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Runs outbound requests strictly one after another. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async getJson(url: string): Promise<unknown> {
    return this.serial(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await this.fetchImpl(url, {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404 || res.status === 410) throw new HttpError(404, 'NOT_FOUND', 'chess.com user not found');
        if (res.status === 429) {
          // Back off: 1 s, then 2 s.
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        if (!res.ok) throw new HttpError(502, 'UPSTREAM', `chess.com returned ${res.status}`);
        return res.json();
      }
      throw new HttpError(503, 'RATE_LIMITED', 'chess.com is rate limiting us, try again shortly');
    });
  }

  private async cached<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.redis.get(key);
    if (hit) return JSON.parse(hit) as T;
    const value = await load();
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSec);
    return value;
  }

  /** Months with games, newest first, as { year, month }. */
  async archives(username: string): Promise<{ year: number; month: number }[]> {
    const user = username.toLowerCase();
    return this.cached(`cc:arch:${user}`, 300, async () => {
      const data = archivesSchema.parse(await this.getJson(`${BASE}/player/${encodeURIComponent(user)}/games/archives`));
      return data.archives
        .map((url) => {
          const m = url.match(/\/(\d{4})\/(\d{2})$/);
          return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
        })
        .filter((x): x is { year: number; month: number } => x !== null)
        .reverse();
    });
  }

  async monthGames(username: string, year: number, month: number): Promise<ChessComGame[]> {
    const user = username.toLowerCase();
    const mm = String(month).padStart(2, '0');
    const now = new Date();
    const isCurrent = year === now.getUTCFullYear() && month === now.getUTCMonth() + 1;
    // "v2" in the key: older cache entries were saved before accuracies were included.
    // Past months rarely change, but chess.com adds accuracies whenever someone
    // reviews an old game, so don't cache them for long.
    return this.cached(`cc:games:v2:${user}:${year}-${mm}`, isCurrent ? 300 : 3600, async () => {
      const data = gamesSchema.parse(
        await this.getJson(`${BASE}/player/${encodeURIComponent(user)}/games/${year}/${mm}`),
      );
      return data.games
        .filter((g) => g.pgn)
        .map((g) => ({
          url: g.url,
          pgn: g.pgn ?? '',
          white: { username: g.white.username, rating: g.white.rating ?? 0, result: g.white.result ?? '' },
          black: { username: g.black.username, rating: g.black.rating ?? 0, result: g.black.result ?? '' },
          timeClass: g.time_class ?? 'unknown',
          timeControl: g.time_control ?? '',
          // "chess" is standard; anything else (chess960, bughouse, ...) can't be analysed by chess.js.
          rules: g.rules ?? 'chess',
          endTime: g.end_time ?? 0,
          accuracies: g.accuracies ?? null,
        }))
        .reverse();
    });
  }
}
