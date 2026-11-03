import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import {
  type Ack,
  type ClientToServerEvents,
  type ServerToClientEvents,
  drawRespondSchema,
  gameRefSchema,
  moveSchema,
  parseTimeControl,
  queueJoinSchema,
} from '@chess/shared';
import type { TokenService } from './auth/tokens.js';
import type { Config } from './config.js';
import { GameError } from './game/errors.js';
import type { GameEvents, GameService } from './game/service.js';
import type { Logger } from './logger.js';
import type { Matchmaker } from './matchmaking.js';
import { TokenBucket } from './security/rateLimit.js';
import type { UserRepo } from './users.js';

interface SocketData {
  user: { id: string; username: string };
}

export type ChessServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type ChessSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const MAX_CONNECTIONS_PER_IP = 20;
const PING_INTERVAL_MS = 5000;

export function createIo(httpServer: HttpServer, config: Config, redis: Redis): ChessServer {
  const io: ChessServer = new Server(httpServer, {
    // WebSocket only: no long-polling fallback, so no sticky sessions are needed
    // when running several instances behind a load balancer.
    transports: ['websocket'],
    // Our largest message is a few hundred bytes; anything bigger is abuse.
    maxHttpBufferSize: 4 * 1024,
    cors: { origin: config.APP_ORIGIN, credentials: false },
    // Browsers always send Origin on WebSocket upgrades; reject other sites' pages.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, !origin || origin === config.APP_ORIGIN);
    },
  });
  if (config.REDIS_ADAPTER) {
    // Lets players connected to different instances share game rooms via Redis pub/sub.
    io.adapter(createAdapter(redis.duplicate(), redis.duplicate()));
  }
  return io;
}

/** The game service talks to clients only through this, via Socket.IO rooms. */
export function socketEvents(io: ChessServer): GameEvents {
  return {
    state: (state) => io.to(`game:${state.id}`).emit('game:state', state),
    moved: (event) => io.to(`game:${event.gameId}`).emit('game:moved', event),
    matchFound: (userId, gameId) => io.to(`user:${userId}`).emit('match:found', { gameId }),
  };
}

function clientIp(socket: ChessSocket, trustProxy: number): string {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (trustProxy > 0 && typeof forwarded === 'string') {
    // The proxy we trust appends the real client IP last.
    const parts = forwarded.split(',').map((p) => p.trim());
    return parts[Math.max(0, parts.length - trustProxy)] ?? socket.handshake.address;
  }
  return socket.handshake.address;
}

export function registerSocketHandlers(
  io: ChessServer,
  deps: { config: Config; tokens: TokenService; users: UserRepo; games: GameService; matchmaker: Matchmaker; log: Logger },
): { sweepPresence: (gameIds: string[]) => Promise<void> } {
  const { config, tokens, users, games, matchmaker, log } = deps;
  const connectionsPerIp = new Map<string, number>();
  const rtt = new Map<string, number>();
  const gamesBySocket = new Map<string, Set<string>>();

  // ---- handshake: authenticate once, before any event can be sent
  io.use((socket, next) => {
    const ip = clientIp(socket, config.TRUST_PROXY);
    const count = connectionsPerIp.get(ip) ?? 0;
    if (count >= MAX_CONNECTIONS_PER_IP) return next(new Error('RATE_LIMITED'));
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    const claims = typeof token === 'string' ? tokens.verifyAccess(token) : null;
    if (!claims) return next(new Error('UNAUTHORIZED'));
    socket.data.user = { id: claims.sub, username: claims.name };
    connectionsPerIp.set(ip, count + 1);
    socket.once('disconnect', () => {
      const left = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (left <= 0) connectionsPerIp.delete(ip);
      else connectionsPerIp.set(ip, left);
    });
    next();
  });

  /** True if this user still has another socket in the game room (another tab). */
  const userStillInRoom = async (gameId: string, userId: string) => {
    const sockets = await io.in(`game:${gameId}`).fetchSockets();
    return sockets.some((s) => s.data.user?.id === userId);
  };

  io.on('connection', (socket) => {
    const user = socket.data.user;
    void socket.join(`user:${user.id}`);
    gamesBySocket.set(socket.id, new Set());

    // Separate budgets: moves are frequent in bullet, other actions shouldn't be.
    const moveBucket = new TokenBucket(10, 5);
    const actionBucket = new TokenBucket(10, 1);

    /**
     * Wraps every handler: requires an ack callback, spends a rate-limit token,
     * validates the payload with Zod, and turns errors into a typed Ack.
     * Unexpected errors are logged and reported as INTERNAL, never leaked.
     */
    const handle = <S extends z.ZodType, O>(
      event: keyof ClientToServerEvents,
      schema: S,
      bucket: TokenBucket,
      fn: (input: z.infer<S>) => Promise<O>,
    ) => {
      socket.on(event, (async (input: unknown, ack: unknown) => {
        if (typeof ack !== 'function') return;
        const reply = ack as (res: Ack<O>) => void;
        if (!bucket.take()) return reply({ ok: false, error: 'RATE_LIMITED', message: 'Slow down' });
        const parsed = schema.safeParse(input);
        if (!parsed.success) {
          return reply({ ok: false, error: 'VALIDATION', message: parsed.error.issues[0]?.message ?? 'Invalid input' });
        }
        try {
          reply({ ok: true, data: await fn(parsed.data) });
        } catch (err) {
          if (err instanceof GameError) return reply({ ok: false, error: err.code, message: err.message });
          log.error({ err, event, user: user.username }, 'socket handler failed');
          reply({ ok: false, error: 'INTERNAL', message: 'Something went wrong' });
        }
      }) as never);
    };

    handle('queue:join', queueJoinSchema, actionBucket, async ({ timeControl }) => {
      const rating = await users.ratingFor(user.id, parseTimeControl(timeControl).timeClass);
      return matchmaker.join({ id: user.id, username: user.username, rating }, timeControl, socket.id);
    });

    socket.on('queue:leave', async (ack) => {
      if (typeof ack !== 'function') return;
      if (!actionBucket.take()) return ack({ ok: false, error: 'RATE_LIMITED', message: 'Slow down' });
      try {
        const timeControl = await matchmaker.leave(user.id);
        io.to(`user:${user.id}`).emit('queue:left', { timeControl });
        ack({ ok: true, data: undefined });
      } catch (err) {
        log.error({ err }, 'queue leave failed');
        ack({ ok: false, error: 'INTERNAL', message: 'Something went wrong' });
      }
    });

    handle('game:join', gameRefSchema, actionBucket, async ({ gameId }) => {
      const state = await games.getState(gameId); // throws NOT_FOUND for unknown ids
      await socket.join(`game:${gameId}`);
      gamesBySocket.get(socket.id)?.add(gameId);
      if (state.white.id === user.id || state.black.id === user.id) {
        await games.setPresence(gameId, user.id, true);
        return games.getState(gameId);
      }
      return state; // spectators can watch but never act: every action checks the player list
    });

    handle('game:move', moveSchema, moveBucket, ({ gameId, uci, ply }) =>
      games.move(gameId, user.id, uci, ply, rtt.get(socket.id)),
    );
    handle('game:resign', gameRefSchema, actionBucket, ({ gameId }) => games.resign(gameId, user.id));
    handle('game:abort', gameRefSchema, actionBucket, ({ gameId }) => games.abort(gameId, user.id));
    handle('game:draw:offer', gameRefSchema, actionBucket, ({ gameId }) => games.offerDraw(gameId, user.id));
    handle('game:draw:respond', drawRespondSchema, actionBucket, ({ gameId, accept }) =>
      games.respondDraw(gameId, user.id, accept),
    );
    handle('game:claim-win', gameRefSchema, actionBucket, ({ gameId }) => games.claimWin(gameId, user.id));

    // ---- round-trip time, for fair lag compensation on the clock
    const pinger = setInterval(() => {
      const sent = Date.now();
      socket.timeout(PING_INTERVAL_MS).emit('srv:ping', sent, (err: Error | null) => {
        if (err) return;
        const sample = Date.now() - sent;
        const prev = rtt.get(socket.id);
        // Smoothed average so one slow packet doesn't swing the credit.
        rtt.set(socket.id, prev === undefined ? sample : prev * 0.7 + sample * 0.3);
      });
    }, PING_INTERVAL_MS);

    socket.on('disconnect', () => {
      clearInterval(pinger);
      rtt.delete(socket.id);
      const joined = gamesBySocket.get(socket.id) ?? new Set<string>();
      gamesBySocket.delete(socket.id);
      void matchmaker.leaveIfSocket(user.id, socket.id).catch((err) => log.error({ err }, 'queue cleanup failed'));
      for (const gameId of joined) {
        void (async () => {
          // Another tab still open? Then the player hasn't really left.
          if (await userStillInRoom(gameId, user.id)) return;
          await games.setPresence(gameId, user.id, false);
        })().catch((err) => {
          if (!(err instanceof GameError)) log.error({ err, gameId }, 'presence update failed');
        });
      }
    });
  });

  /**
   * After a restart nobody's disconnect was recorded (the old process died).
   * Give players time to reconnect, then mark anyone still missing as gone,
   * so their opponent can eventually claim the win.
   */
  const sweepPresence = async (gameIds: string[]) => {
    for (const gameId of gameIds) {
      try {
        const state = await games.getState(gameId);
        if (state.status !== 'active') continue;
        for (const player of [state.white, state.black]) {
          if (!(await userStillInRoom(gameId, player.id))) await games.setPresence(gameId, player.id, false);
        }
      } catch (err) {
        if (!(err instanceof GameError)) log.error({ err, gameId }, 'presence sweep failed');
      }
    }
  };

  return { sweepPresence };
}
