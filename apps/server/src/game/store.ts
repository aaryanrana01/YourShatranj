import type { Redis } from 'ioredis';
import { ENDED_GAME_TTL_SEC } from './constants.js';
import type { StoredGame } from './types.js';

/**
 * Redis layout
 *   game:{id}         hash { v: version, d: JSON of StoredGame }
 *   games:live        set of game ids not yet written to Postgres (for crash recovery)
 *   user:{id}:game    id of the game the user is currently playing
 *
 * Every write is compare-and-set on `v`: a Lua script (atomic inside Redis)
 * writes only if nobody else changed the game since we read it. If two
 * requests race — two tabs moving, a move against a timeout, resign against
 * checkmate — exactly one wins and the other retries on fresh state.
 */

const CAS_SCRIPT = `
local v = redis.call('HGET', KEYS[1], 'v')
if not v or v ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'v', tostring(tonumber(v) + 1), 'd', ARGV[2])
return 1
`;

/** Claims both players for a new game only if neither is already in one. */
const CLAIM_PLAYERS_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
return 1
`;

/** Clears a user's active-game pointer only if it still points at this game. */
const RELEASE_PLAYER_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 1
`;

const gameKey = (id: string) => `game:${id}`;
const userGameKey = (userId: string) => `user:${userId}:game`;
const LIVE_SET = 'games:live';

export interface Versioned {
  version: string;
  game: StoredGame;
}

export class GameStore {
  constructor(private readonly redis: Redis) {}

  async claimPlayers(gameId: string, whiteId: string, blackId: string): Promise<boolean> {
    const ok = await this.redis.eval(CLAIM_PLAYERS_SCRIPT, 2, userGameKey(whiteId), userGameKey(blackId), gameId);
    return ok === 1;
  }

  async releasePlayer(userId: string, gameId: string): Promise<void> {
    await this.redis.eval(RELEASE_PLAYER_SCRIPT, 1, userGameKey(userId), gameId);
  }

  async create(game: StoredGame): Promise<void> {
    await this.redis
      .multi()
      .hset(gameKey(game.id), 'v', '1', 'd', JSON.stringify(game))
      .sadd(LIVE_SET, game.id)
      .exec();
  }

  async load(gameId: string): Promise<Versioned | null> {
    const [version, data] = await this.redis.hmget(gameKey(gameId), 'v', 'd');
    if (!version || !data) return null;
    return { version, game: JSON.parse(data) as StoredGame };
  }

  /** Writes `game` only if the stored version still equals `expectedVersion`. */
  async compareAndSet(expectedVersion: string, game: StoredGame): Promise<boolean> {
    const ok = await this.redis.eval(CAS_SCRIPT, 1, gameKey(game.id), expectedVersion, JSON.stringify(game));
    return ok === 1;
  }

  async activeGameOf(userId: string): Promise<string | null> {
    return this.redis.get(userGameKey(userId));
  }

  /** After a game is safely in Postgres, drop it from the recovery set and let Redis expire it. */
  async markArchived(gameId: string): Promise<void> {
    await this.redis.multi().srem(LIVE_SET, gameId).expire(gameKey(gameId), ENDED_GAME_TTL_SEC).exec();
  }

  async liveGameIds(): Promise<string[]> {
    return this.redis.smembers(LIVE_SET);
  }

  /** Removes a game whose creation failed half-way (e.g. Postgres insert failed). */
  async discard(game: StoredGame): Promise<void> {
    await this.redis.multi().del(gameKey(game.id)).srem(LIVE_SET, game.id).exec();
    await this.releasePlayer(game.white.id, game.id);
    await this.releasePlayer(game.black.id, game.id);
  }
}
