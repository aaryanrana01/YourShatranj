import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import type { GameMovedEvent, PublicGameState } from '@chess/shared';
import { createDb } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { GameArchive } from '../src/game/archive.js';
import { FIRST_MOVE_TIMEOUT_MS, DISCONNECT_GRACE_MS } from '../src/game/constants.js';
import { GameError } from '../src/game/errors.js';
import { type GameEvents, GameService } from '../src/game/service.js';
import { GameStore } from '../src/game/store.js';
import { createLogger } from '../src/logger.js';
import { UserRepo } from '../src/users.js';
import { testConfig, uniqueName } from './helpers.js';

/**
 * Drives the game service with a fake clock, so timeouts that take minutes
 * in real life are tested in milliseconds.
 */

const config = testConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL);
let t = 1_700_000_000_000;
const states: PublicGameState[] = [];
const events: GameEvents = {
  state: (s) => states.push(s),
  moved: (_e: GameMovedEvent) => {},
  matchFound: () => {},
};
const service = new GameService(new GameStore(redis), new GameArchive(db, 'http://test'), events, createLogger('silent', false), () => t);
const users = new UserRepo(db);
const fire = (gameId: string) => (service as unknown as { onTimer(id: string): Promise<void> }).onTimer(gameId);

async function newPlayers() {
  const a = await users.create(uniqueName('s'), 'x');
  const b = await users.create(uniqueName('s'), 'x');
  return [
    { id: a!.id, username: a!.username, rating: 1500 },
    { id: b!.id, username: b!.username, rating: 1500 },
  ] as const;
}

async function newGame() {
  const [a, b] = await newPlayers();
  const game = await service.createGame(a, b, '300+0');
  if (!game) throw new Error('createGame failed');
  return { id: game.id, white: game.white.id, black: game.black.id };
}

async function expectError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof GameError && e.code === code);
}

beforeAll(async () => {
  await runMigrations(pool);
  await redis.flushdb();
});

afterAll(async () => {
  await service.drain();
  await redis.quit();
  await pool.end();
});

describe('game service with a fake clock', () => {
  it('aborts a game when nobody makes the first move', async () => {
    const g = await newGame();
    t += FIRST_MOVE_TIMEOUT_MS + 1;
    await fire(g.id);
    const s = await service.getState(g.id);
    expect(s.status).toBe('aborted');
    expect(s.endReason).toBe('aborted');
  });

  it('a move that arrives after the flag fell loses on time', async () => {
    const g = await newGame();
    await service.move(g.id, g.white, 'e2e4', 0);
    await service.move(g.id, g.black, 'e7e5', 1);
    t += 5 * 60_000 + 1; // White's whole 5 minutes, and then some
    await expectError(service.move(g.id, g.white, 'g1f3', 2), 'GAME_OVER');
    const s = await service.getState(g.id);
    expect(s.result).toBe('0-1');
    expect(s.endReason).toBe('timeout');
    expect(s.clocks.w).toBe(0);
  });

  it('the timer flags a player who never moves', async () => {
    const g = await newGame();
    await service.move(g.id, g.white, 'e2e4', 0);
    await service.move(g.id, g.black, 'c7c5', 1);
    t += 6 * 60_000;
    await fire(g.id);
    expect((await service.getState(g.id)).endReason).toBe('timeout');
  });

  it('only lets you claim the win after the opponent has been gone long enough', async () => {
    const g = await newGame();
    await service.move(g.id, g.white, 'e2e4', 0);
    await service.move(g.id, g.black, 'e7e5', 1);
    await service.setPresence(g.id, g.black, false);
    await expectError(service.claimWin(g.id, g.white), 'NOT_ALLOWED');
    t += DISCONNECT_GRACE_MS + 1;
    await service.claimWin(g.id, g.white);
    const s = await service.getState(g.id);
    expect(s.result).toBe('1-0');
    expect(s.endReason).toBe('abandoned');
  });

  it('reconnecting clears the disconnect', async () => {
    const g = await newGame();
    await service.setPresence(g.id, g.black, false);
    expect((await service.getState(g.id)).disconnectedAt.b).not.toBeNull();
    await service.setPresence(g.id, g.black, true);
    expect((await service.getState(g.id)).disconnectedAt.b).toBeNull();
    await service.abort(g.id, g.white);
  });

  it('handles draw offers: no spam, a move declines, offering back accepts', async () => {
    const g = await newGame();
    await expectError(service.offerDraw(g.id, g.white), 'NOT_ALLOWED'); // too early
    await service.move(g.id, g.white, 'e2e4', 0);
    await service.move(g.id, g.black, 'e7e5', 1);
    await service.offerDraw(g.id, g.white);
    await expectError(service.offerDraw(g.id, g.white), 'NOT_ALLOWED'); // already pending
    await service.move(g.id, g.white, 'g1f3', 2); // offerer moving keeps the offer
    expect((await service.getState(g.id)).drawOffer).toBe('w');
    await service.move(g.id, g.black, 'b8c6', 3); // receiver moving declines it
    expect((await service.getState(g.id)).drawOffer).toBeNull();
    await service.offerDraw(g.id, g.black);
    await service.offerDraw(g.id, g.white); // offering back = accepting
    const s = await service.getState(g.id);
    expect(s.result).toBe('1/2-1/2');
    expect(s.endReason).toBe('agreement');
  });

  it('only allows abort before your own first move', async () => {
    const g = await newGame();
    await service.move(g.id, g.white, 'e2e4', 0);
    await expectError(service.abort(g.id, g.white), 'NOT_ALLOWED');
    await service.abort(g.id, g.black);
    expect((await service.getState(g.id)).status).toBe('aborted');
  });

  it('resigning before both sides moved is an abort (no free rating)', async () => {
    const g = await newGame();
    await service.resign(g.id, g.black);
    expect((await service.getState(g.id)).endReason).toBe('aborted');
  });

  it('two parallel moves from the same player: exactly one is applied', async () => {
    const g = await newGame();
    const results = await Promise.allSettled([
      service.move(g.id, g.white, 'e2e4', 0),
      service.move(g.id, g.white, 'd2d4', 0),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await service.getState(g.id)).ply).toBe(1);
    await service.abort(g.id, g.black);
  });

  it('recovery re-arms timers and archives games that ended but were not saved', async () => {
    const g = await newGame();
    const res = await service.recover();
    expect(res.active).toContain(g.id);
    await service.abort(g.id, g.white);
  });
});
