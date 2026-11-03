import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PublicGameState } from '@chess/shared';
import { createLogger } from '../src/logger.js';
import { buildServer } from '../src/server.js';
import { type Client, ORIGIN, connect, http, register, testConfig, uniqueName, waitFor } from './helpers.js';

type Server = Awaited<ReturnType<typeof buildServer>>;

let server: Server;
let base: string;
const sockets: Client[] = [];
const log = createLogger('silent', false);

async function resetLimits() {
  const keys = await server.redis.keys('rl:*');
  if (keys.length) await server.redis.del(...keys);
}

async function player(prefix: string) {
  await resetLimits();
  const account = await register(base, uniqueName(prefix));
  const socket = await connect(base, account.token);
  sockets.push(socket);
  return { ...account, socket };
}

/** Queues two players and returns the game with each player's socket by colour. */
async function startGame(timeControl: '300+0' | '600+0' | '180+2' = '300+0') {
  const a = await player('a');
  const b = await player('b');
  const foundA = waitFor(a.socket, 'match:found');
  const foundB = waitFor(b.socket, 'match:found');
  expect((await a.socket.emitWithAck('queue:join', { timeControl })).ok).toBe(true);
  expect((await b.socket.emitWithAck('queue:join', { timeControl })).ok).toBe(true);
  const [{ gameId }, { gameId: sameId }] = await Promise.all([foundA, foundB]);
  expect(sameId).toBe(gameId);
  const joined = await a.socket.emitWithAck('game:join', { gameId });
  await b.socket.emitWithAck('game:join', { gameId });
  if (!joined.ok) throw new Error('join failed');
  const state = joined.data;
  const white = state.white.id === a.user.id ? a : b;
  const black = white === a ? b : a;
  return { gameId, state, white, black };
}

async function move(socket: Client, gameId: string, uci: string, ply: number) {
  return socket.emitWithAck('game:move', { gameId, uci, ply });
}

beforeAll(async () => {
  const config = testConfig();
  server = await buildServer(config, log);
  await server.redis.flushdb();
  const port = await server.start(0);
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await server?.stop();
});

describe('HTTP basics and security', () => {
  it('sends security headers and hides the framework', async () => {
    const res = await http(base, '/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('hides "Continue with Google" when it is not configured', async () => {
    const res = await http(base, '/api/auth/providers');
    expect(res.body).toEqual({ google: false });
    expect((await http(base, '/api/auth/google')).status).toBe(404);
  });

  it('rejects bad registration input', async () => {
    await resetLimits();
    const res = await http(base, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: '<script>', password: 'short' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('rejects unknown fields (mass assignment)', async () => {
    await resetLimits();
    const res = await http(base, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: uniqueName('u'), password: 'long enough pass', isBanned: false }),
    });
    expect(res.status).toBe(400);
  });

  it('gives the same answer for unknown user and wrong password', async () => {
    await resetLimits();
    const { user } = await register(base, uniqueName('login'));
    const wrong = await http(base, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: user.username, password: 'not the password' }),
    });
    const missing = await http(base, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'nobody_here_x', password: 'not the password' }),
    });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body.message).toBe(missing.body.message);
  });

  it('rate limits login attempts per account', async () => {
    await resetLimits();
    const { user } = await register(base, uniqueName('brute'));
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await http(base, '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: user.username, password: `guess-${i}-xxxx` }),
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it('rotates refresh tokens and kills the session when an old one is replayed', async () => {
    await resetLimits();
    const { cookie } = await register(base, uniqueName('rt'));
    const rt1 = cookie.split(';')[0]!;
    const first = await http(base, '/api/auth/refresh', { method: 'POST', headers: { Cookie: rt1 } });
    expect(first.status).toBe(200);
    const rt2 = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(rt2).not.toBe(rt1);

    // Pretend rt1 was used long ago, then replay it: that's what a thief would do.
    await server.db.execute(sql`update refresh_tokens set revoked_at = now() - interval '1 minute' where revoked_at is not null`);
    const replay = await http(base, '/api/auth/refresh', { method: 'POST', headers: { Cookie: rt1 } });
    expect(replay.status).toBe(401);
    // The whole family is revoked, so even the newest token is dead now.
    const after = await http(base, '/api/auth/refresh', { method: 'POST', headers: { Cookie: rt2 } });
    expect(after.status).toBe(401);
  });

  it('blocks cookie endpoints called from another site', async () => {
    const res = await http(base, '/api/auth/refresh', { method: 'POST', headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('refuses sockets without a valid token', async () => {
    await expect(connect(base)).rejects.toThrow('UNAUTHORIZED');
    await expect(connect(base, 'not.a.jwt')).rejects.toThrow('UNAUTHORIZED');
  });
});

describe('a full game', () => {
  it('matches two players, enforces the rules, ends in mate and updates ratings', async () => {
    const { gameId, state, white, black } = await startGame('300+0');
    expect(state.status).toBe('active');
    expect(state.ply).toBe(0);

    // Black can't move first; a spectator can watch but not move.
    expect(await move(black.socket, gameId, 'e7e5', 0)).toMatchObject({ ok: false, error: 'NOT_YOUR_TURN' });
    const spectator = await player('spec');
    expect((await spectator.socket.emitWithAck('game:join', { gameId })).ok).toBe(true);
    expect(await move(spectator.socket, gameId, 'f2f3', 0)).toMatchObject({ ok: false, error: 'NOT_YOUR_GAME' });

    // Payload with an extra field is rejected before reaching game logic.
    const sneaky = await white.socket.emitWithAck('game:move', { gameId, uci: 'f2f3', ply: 0, userId: black.user.id } as never);
    expect(sneaky).toMatchObject({ ok: false, error: 'VALIDATION' });

    const blackSeesMove = waitFor(black.socket, 'game:moved', (e) => e.ply === 1);
    expect(await move(white.socket, gameId, 'f2f3', 0)).toEqual({ ok: true, data: { ply: 1 } });
    expect((await blackSeesMove).move.san).toBe('f3');

    // Double-click / retry of the same move.
    expect((await move(white.socket, gameId, 'f2f3', 0)).ok).toBe(false);
    expect(await move(black.socket, gameId, 'e7e5', 5)).toMatchObject({ ok: false, error: 'STALE_PLY' });
    expect(await move(black.socket, gameId, 'e7e4', 1)).toMatchObject({ ok: false, error: 'ILLEGAL_MOVE' });

    expect((await move(black.socket, gameId, 'e7e5', 1)).ok).toBe(true);
    expect((await move(white.socket, gameId, 'g2g4', 2)).ok).toBe(true);

    const ended = waitFor(white.socket, 'game:state', (s) => s.status === 'ended');
    const rated = waitFor(white.socket, 'game:state', (s) => s.ratingChanges !== null, 8000);
    expect((await move(black.socket, gameId, 'd8h4', 3)).ok).toBe(true);

    const end = (await ended) as PublicGameState;
    expect(end.result).toBe('0-1');
    expect(end.endReason).toBe('checkmate');
    const final = (await rated) as PublicGameState;
    expect(final.ratingChanges!.b).toBeGreaterThan(0);
    expect(final.ratingChanges!.w).toBeLessThan(0);

    // Moves after the end are refused.
    expect(await move(white.socket, gameId, 'a2a3', 4)).toMatchObject({ ok: false, error: 'GAME_OVER' });

    // The finished game is reviewable and in both players' history.
    const pgn = await http(base, `/api/games/${gameId}/pgn`);
    expect(pgn.status).toBe(200);
    expect(pgn.body.pgn).toContain('Qh4#');
    expect(pgn.body.pgn).toContain('0-1');
    const history = await http(base, `/api/users/${black.user.username}/games`);
    expect(history.body[0].id).toBe(gameId);

    // Both players are free to play again.
    const active = await http(base, '/api/me/active-game', { headers: { Authorization: `Bearer ${white.token}` } });
    expect(active.body.gameId).toBeNull();
  });

  it('blocks analysis of a game while it is being played', async () => {
    const { gameId, white } = await startGame('180+2');
    const res = await http(base, `/api/games/${gameId}/pgn`);
    expect(res.status).toBe(409);
    // Can't queue for a second game meanwhile.
    expect(await white.socket.emitWithAck('queue:join', { timeControl: '300+0' })).toMatchObject({
      ok: false,
      error: 'ALREADY_IN_GAME',
    });
    expect((await white.socket.emitWithAck('game:abort', { gameId })).ok).toBe(true);
  });

  it('when both players resign at the same instant, the game ends exactly once', async () => {
    const { gameId, white, black } = await startGame('600+0');
    await move(white.socket, gameId, 'e2e4', 0);
    await move(black.socket, gameId, 'e7e5', 1);
    const rated = waitFor(white.socket, 'game:state', (s) => s.ratingChanges !== null, 8000);
    const [r1, r2] = await Promise.all([
      white.socket.emitWithAck('game:resign', { gameId }),
      black.socket.emitWithAck('game:resign', { gameId }),
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect([r1, r2].find((r) => !r.ok)).toMatchObject({ error: 'GAME_OVER' });
    await rated;
    const rows = await server.db.execute(
      sql`select games_played from ratings where time_class = 'rapid' and user_id in (${white.user.id}, ${black.user.id})`,
    );
    expect(rows.rows.map((r) => r.games_played)).toEqual([1, 1]);
  });

  it('survives a server restart in the middle of a game', async () => {
    const { gameId, white, black } = await startGame('300+0');
    await move(white.socket, gameId, 'd2d4', 0);
    await move(black.socket, gameId, 'd7d5', 1);

    await server.stop();
    server = await buildServer(testConfig(), log);
    const port = await server.start(0);
    base = `http://127.0.0.1:${port}`;

    const w = await connect(base, white.token);
    const b = await connect(base, black.token);
    sockets.push(w, b);
    const rejoined = await w.emitWithAck('game:join', { gameId });
    await b.emitWithAck('game:join', { gameId });
    expect(rejoined.ok && rejoined.data.ply).toBe(2);
    expect(rejoined.ok && rejoined.data.status).toBe('active');
    expect((await move(w, gameId, 'c2c4', 2)).ok).toBe(true);
    expect((await w.emitWithAck('game:resign', { gameId })).ok).toBe(true);
  });
});
