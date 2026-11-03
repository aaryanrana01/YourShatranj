import type { Redis } from 'ioredis';
import type { PlayerInfo, TimeControlKey } from '@chess/shared';
import { GameError } from './game/errors.js';
import type { GameService } from './game/service.js';
import type { Logger } from './logger.js';

/**
 * Redis layout
 *   mm:{timeControl}  sorted set: member = user id, score = rating
 *   mm:meta           hash: user id -> JSON { timeControl, joinedAt, username, rating, socketId }
 *
 * Pairing runs as one Lua script, so two server instances can never pair the
 * same player twice: the script removes both players in the same atomic step
 * that picks them.
 */

const PAIR_SCRIPT = `
local me = ARGV[1]
local myScore = redis.call('ZSCORE', KEYS[1], me)
if not myScore then return false end
myScore = tonumber(myScore)
local cands = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[2], ARGV[3], 'WITHSCORES', 'LIMIT', 0, 50)
local best = nil
local bestDiff = nil
for i = 1, #cands, 2 do
  local id = cands[i]
  if id ~= me then
    local diff = math.abs(tonumber(cands[i + 1]) - myScore)
    if not best or diff < bestDiff then best = id; bestDiff = diff end
  end
end
if not best then return false end
local opponentMeta = redis.call('HGET', KEYS[2], best)
redis.call('ZREM', KEYS[1], me, best)
redis.call('HDEL', KEYS[2], me, best)
return {best, opponentMeta or ''}
`;

const META = 'mm:meta';
const queueKey = (tc: TimeControlKey) => `mm:${tc}`;

interface QueueMeta {
  timeControl: TimeControlKey;
  joinedAt: number;
  username: string;
  rating: number;
  socketId: string;
}

/** Rating window grows the longer you wait: ±100 at first, everyone after ~2 minutes. */
export function ratingWindow(waitedMs: number): number {
  return Math.min(100 + Math.floor(waitedMs / 5000) * 40, 2000);
}

export class Matchmaker {
  /** Players queued through THIS instance; only these drive the sweep, so an idle server sends no Redis commands. */
  private readonly local = new Map<string, QueueMeta>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly redis: Redis,
    private readonly games: GameService,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.sweepTimer = setInterval(() => void this.sweep(), 2000);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  async join(player: PlayerInfo, timeControl: TimeControlKey, socketId: string): Promise<{ joinedAt: number }> {
    if (await this.games.activeGameOf(player.id)) {
      throw new GameError('ALREADY_IN_GAME', 'Finish your current game first');
    }
    // One queue entry per user: joining again (another tab, another time control) replaces the old one.
    await this.leave(player.id);
    const meta: QueueMeta = {
      timeControl,
      joinedAt: Date.now(),
      username: player.username,
      rating: player.rating,
      socketId,
    };
    await this.redis
      .multi()
      .zadd(queueKey(timeControl), player.rating, player.id)
      .hset(META, player.id, JSON.stringify(meta))
      .exec();
    this.local.set(player.id, meta);
    await this.tryPair(player.id, meta);
    return { joinedAt: meta.joinedAt };
  }

  async leave(userId: string): Promise<TimeControlKey | null> {
    this.local.delete(userId);
    const raw = await this.redis.hget(META, userId);
    if (!raw) return null;
    const meta = JSON.parse(raw) as QueueMeta;
    await this.redis.multi().zrem(queueKey(meta.timeControl), userId).hdel(META, userId).exec();
    return meta.timeControl;
  }

  /** Called when a socket disconnects: leave the queue only if that socket owned the entry. */
  async leaveIfSocket(userId: string, socketId: string): Promise<void> {
    const raw = await this.redis.hget(META, userId);
    if (!raw) return;
    const meta = JSON.parse(raw) as QueueMeta;
    if (meta.socketId === socketId) await this.leave(userId);
  }

  private async tryPair(userId: string, meta: QueueMeta): Promise<void> {
    const window = ratingWindow(Date.now() - meta.joinedAt);
    const res = (await this.redis.eval(
      PAIR_SCRIPT,
      2,
      queueKey(meta.timeControl),
      META,
      userId,
      String(meta.rating - window),
      String(meta.rating + window),
    )) as [string, string] | null;

    if (!res) {
      // Not in the queue any more (paired by another instance, or left): stop tracking.
      const stillQueued = await this.redis.zscore(queueKey(meta.timeControl), userId);
      if (stillQueued === null) this.local.delete(userId);
      return;
    }

    const [opponentId, opponentRaw] = res;
    this.local.delete(userId);
    this.local.delete(opponentId);
    const opponentMeta = opponentRaw ? (JSON.parse(opponentRaw) as QueueMeta) : null;
    const me: PlayerInfo = { id: userId, username: meta.username, rating: Math.round(meta.rating) };
    const them: PlayerInfo = {
      id: opponentId,
      username: opponentMeta?.username ?? 'unknown',
      rating: Math.round(opponentMeta?.rating ?? 1500),
    };

    try {
      const game = await this.games.createGame(me, them, meta.timeControl);
      if (!game) {
        // One of them started another game in the meantime: requeue whoever is still free.
        await this.requeueIfFree(me, meta);
        if (opponentMeta) await this.requeueIfFree(them, opponentMeta);
      }
    } catch (err) {
      this.log.error({ err }, 'failed to create game after pairing');
      await this.requeueIfFree(me, meta);
      if (opponentMeta) await this.requeueIfFree(them, opponentMeta);
    }
  }

  private async requeueIfFree(player: PlayerInfo, meta: QueueMeta): Promise<void> {
    if (await this.games.activeGameOf(player.id)) return;
    await this.redis
      .multi()
      .zadd(queueKey(meta.timeControl), meta.rating, player.id)
      .hset(META, player.id, JSON.stringify(meta))
      .exec();
    this.local.set(player.id, meta);
  }

  /** Every 2 s, retry pairing for players on this instance with their (now wider) rating window. */
  private async sweep(): Promise<void> {
    if (this.sweeping || this.local.size === 0) return;
    this.sweeping = true;
    try {
      for (const [userId, meta] of [...this.local]) {
        if (!this.local.has(userId)) continue;
        await this.tryPair(userId, meta);
      }
    } catch (err) {
      this.log.error({ err }, 'matchmaking sweep failed');
    } finally {
      this.sweeping = false;
    }
  }
}
