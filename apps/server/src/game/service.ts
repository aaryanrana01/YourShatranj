import { customAlphabet } from 'nanoid';
import {
  type Color,
  type EndReason,
  type GameMovedEvent,
  type GameResult,
  type PlayerInfo,
  type PublicGameState,
  type TimeControlKey,
  parseTimeControl,
} from '@chess/shared';
import type { Logger } from '../logger.js';
import type { GameArchive } from './archive.js';
import { abortDeadline, chargeMove, hasFlagged, lagCredit, nextDeadline, remainingAt } from './clock.js';
import { DISCONNECT_GRACE_MS, MAX_DRAW_OFFERS_PER_PLAYER } from './constants.js';
import { GameError } from './errors.js';
import { detectEnd, hasMatingMaterial, replay, tryMove, winnerResult } from './rules.js';
import type { GameStore } from './store.js';
import { GameTimers } from './timers.js';
import { START_FEN, type StoredGame, colorOf, opposite, turnAt } from './types.js';
import { toMovedEvent, toPublic } from './view.js';

/** 12 URL-safe characters: ~71 bits of randomness, so game ids can't be guessed. */
const newGameId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-', 12);

/** How the service talks to connected clients; the socket layer implements it. */
export interface GameEvents {
  state(state: PublicGameState): void;
  moved(event: GameMovedEvent): void;
  matchFound(userId: string, gameId: string): void;
}

interface Outcome<T> {
  value: T;
  changed: boolean;
}

const unchanged = <T>(value: T): Outcome<T> => ({ value, changed: false });
const changed = <T>(value: T): Outcome<T> => ({ value, changed: true });

/** Freezes the side-to-move's clock and marks the game finished. */
function endGame(game: StoredGame, result: GameResult, reason: EndReason, now: number): void {
  const turn = turnAt(game.moves.length);
  game.clocks[turn] = remainingAt(game, turn, now);
  game.status = reason === 'aborted' ? 'aborted' : 'ended';
  game.result = reason === 'aborted' ? '*' : result;
  game.endReason = reason;
  game.endedAt = now;
  game.drawOffer = null;
}

function endByTimeout(game: StoredGame, loser: Color, now: number): void {
  game.clocks[loser] = 0;
  const winner = opposite(loser);
  const chess = replay(game.moves.map((m) => m.uci));
  if (hasMatingMaterial(chess, winner)) endGame(game, winnerResult(winner), 'timeout', now);
  else endGame(game, '1/2-1/2', 'timeout_vs_insufficient', now);
}

function requireActive(game: StoredGame): void {
  if (game.status !== 'active') throw new GameError('GAME_OVER', 'This game has already ended');
}

function requirePlayer(game: StoredGame, userId: string): Color {
  const color = colorOf(game, userId);
  if (!color) throw new GameError('NOT_YOUR_GAME', 'You are not playing in this game');
  return color;
}

/**
 * The referee. Every rule about moves, clocks and results is enforced here,
 * on the server; clients only ask.
 */
export class GameService {
  private readonly timers: GameTimers;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: GameStore,
    private readonly archive: GameArchive,
    private readonly events: GameEvents,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.timers = new GameTimers((gameId) => void this.onTimer(gameId));
  }

  // ---------------------------------------------------------------- core

  /**
   * Serialises work on one game inside this process. Redis compare-and-set
   * still protects against other server instances; this just avoids
   * pointless retries when two requests for one game hit the same instance.
   */
  private withLock<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(gameId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(gameId, tail);
    void tail.then(() => {
      if (this.locks.get(gameId) === tail) this.locks.delete(gameId);
    });
    return run;
  }

  /**
   * Read → change a copy → compare-and-set, retrying if another writer got in
   * first. `fn` must not have side effects, because it may run more than once.
   */
  private mutate<T>(
    gameId: string,
    fn: (game: StoredGame, now: number) => Outcome<T>,
  ): Promise<{ game: StoredGame; value: T; changed: boolean }> {
    return this.withLock(gameId, async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const loaded = await this.store.load(gameId);
        if (!loaded) throw new GameError('NOT_FOUND', 'Game not found');
        const draft = structuredClone(loaded.game);
        const out = fn(draft, this.now());
        if (!out.changed) return { game: loaded.game, value: out.value, changed: false };
        if (await this.store.compareAndSet(loaded.version, draft)) {
          return { game: draft, value: out.value, changed: true };
        }
      }
      throw new GameError('CONFLICT', 'The game was busy, please retry');
    });
  }

  /** Side effects after a committed change: timers, broadcasts, archiving. */
  private afterChange(game: StoredGame, opts: { moved?: boolean } = {}): void {
    const now = this.now();
    this.timers.schedule(game.id, nextDeadline(game), now);
    if (opts.moved && game.status === 'active') this.events.moved(toMovedEvent(game, now));
    else this.events.state(toPublic(game, now));

    if (game.status !== 'active') {
      // Free both players right away so they can queue again; then archive.
      void Promise.all([
        this.store.releasePlayer(game.white.id, game.id),
        this.store.releasePlayer(game.black.id, game.id),
      ]).catch((err) => this.log.error({ err, gameId: game.id }, 'failed to release players'));
      if (!game.persisted) void this.archiveGame(game.id);
    }
  }

  // ------------------------------------------------------------ creation

  async createGame(a: PlayerInfo, b: PlayerInfo, timeControl: TimeControlKey): Promise<StoredGame | null> {
    const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
    const tc = parseTimeControl(timeControl);
    const id = newGameId();
    if (!(await this.store.claimPlayers(id, white.id, black.id))) return null;

    const now = this.now();
    const game: StoredGame = {
      id,
      white,
      black,
      timeControl,
      timeClass: tc.timeClass,
      initialMs: tc.initialMs,
      incrementMs: tc.incrementMs,
      rated: true,
      status: 'active',
      fen: START_FEN,
      moves: [],
      clocks: { w: tc.initialMs, b: tc.initialMs },
      turnStartedAt: now,
      createdAt: now,
      drawOffer: null,
      drawOffersUsed: { w: 0, b: 0 },
      lastDrawOfferPly: { w: -1, b: -1 },
      disconnectedAt: { w: null, b: null },
      result: '*',
      endReason: null,
      endedAt: null,
      ratingChanges: null,
      persisted: false,
    };

    try {
      await this.archive.insertNewGame(game);
      await this.store.create(game);
    } catch (err) {
      await this.store.discard(game).catch(() => {});
      throw err;
    }
    this.timers.schedule(id, nextDeadline(game), now);
    this.events.matchFound(white.id, id);
    this.events.matchFound(black.id, id);
    this.log.info({ gameId: id, white: white.username, black: black.username, timeControl }, 'game created');
    return game;
  }

  // -------------------------------------------------------------- reads

  async getState(gameId: string): Promise<PublicGameState> {
    const loaded = await this.store.load(gameId);
    if (!loaded) throw new GameError('NOT_FOUND', 'Game not found');
    return toPublic(loaded.game, this.now());
  }

  async activeGameOf(userId: string): Promise<string | null> {
    return this.store.activeGameOf(userId);
  }

  // ------------------------------------------------------------- actions

  async move(gameId: string, userId: string, uci: string, ply: number, rttMs?: number): Promise<{ ply: number }> {
    const res = await this.mutate(gameId, (game, now) => {
      requireActive(game);
      const color = requirePlayer(game, userId);
      if (turnAt(game.moves.length) !== color) throw new GameError('NOT_YOUR_TURN', 'It is not your turn');
      // Duplicate (double click, network retry) or out-of-sync client.
      if (ply !== game.moves.length) throw new GameError('STALE_PLY', 'Your board is out of date');

      // Decide time BEFORE legality: if time ran out first, the flag wins.
      const clock = chargeMove(game, now, lagCredit(rttMs));
      if (clock.flagged) {
        endByTimeout(game, color, now);
        return changed('flagged' as const);
      }

      const chess = replay(game.moves.map((m) => m.uci));
      const applied = tryMove(chess, uci);
      if (!applied) throw new GameError('ILLEGAL_MOVE', 'Illegal move');

      game.moves.push({ uci, san: applied.san, clockMs: clock.remainingMs });
      game.clocks[color] = clock.remainingMs;
      game.fen = chess.fen();
      game.turnStartedAt = now;
      // Moving instead of answering a draw offer declines it.
      if (game.drawOffer && game.drawOffer !== color) game.drawOffer = null;

      const ending = detectEnd(chess);
      if (ending) endGame(game, ending.result, ending.reason, now);
      return changed('moved' as const);
    });

    if (res.value === 'flagged') {
      this.afterChange(res.game);
      throw new GameError('GAME_OVER', 'Your time ran out');
    }
    this.afterChange(res.game, { moved: true });
    return { ply: res.game.moves.length };
  }

  async resign(gameId: string, userId: string): Promise<void> {
    const res = await this.mutate(gameId, (game, now) => {
      requireActive(game);
      const color = requirePlayer(game, userId);
      // Resigning before both sides moved counts as an abort: no free rating points.
      if (game.moves.length < 2) endGame(game, '*', 'aborted', now);
      else endGame(game, winnerResult(opposite(color)), 'resign', now);
      return changed(undefined);
    });
    this.afterChange(res.game);
  }

  async abort(gameId: string, userId: string): Promise<void> {
    const res = await this.mutate(gameId, (game, now) => {
      requireActive(game);
      const color = requirePlayer(game, userId);
      const ply = game.moves.length;
      // You can abort only before you've made your own first move.
      const allowed = color === 'w' ? ply === 0 : ply < 2;
      if (!allowed) throw new GameError('NOT_ALLOWED', 'Too late to abort; you can resign instead');
      endGame(game, '*', 'aborted', now);
      return changed(undefined);
    });
    this.afterChange(res.game);
  }

  async offerDraw(gameId: string, userId: string): Promise<void> {
    const res = await this.mutate(gameId, (game, now) => {
      requireActive(game);
      const color = requirePlayer(game, userId);
      const ply = game.moves.length;
      if (ply < 2) throw new GameError('NOT_ALLOWED', 'Draw offers open after both sides have moved');
      // Offering when the opponent already offered = accepting.
      if (game.drawOffer === opposite(color)) {
        endGame(game, '1/2-1/2', 'agreement', now);
        return changed(undefined);
      }
      if (game.drawOffer === color) throw new GameError('NOT_ALLOWED', 'Your draw offer is already pending');
      if (game.drawOffersUsed[color] >= MAX_DRAW_OFFERS_PER_PLAYER) {
        throw new GameError('NOT_ALLOWED', 'You have used all your draw offers this game');
      }
      if (game.lastDrawOfferPly[color] === ply) {
        throw new GameError('NOT_ALLOWED', 'Wait for a move before offering again');
      }
      game.drawOffer = color;
      game.drawOffersUsed[color] += 1;
      game.lastDrawOfferPly[color] = ply;
      return changed(undefined);
    });
    this.afterChange(res.game);
  }

  async respondDraw(gameId: string, userId: string, accept: boolean): Promise<void> {
    const res = await this.mutate(gameId, (game, now) => {
      requireActive(game);
      const color = requirePlayer(game, userId);
      if (game.drawOffer !== opposite(color)) throw new GameError('NOT_ALLOWED', 'There is no draw offer to answer');
      if (accept) endGame(game, '1/2-1/2', 'agreement', now);
      else game.drawOffer = null;
      return changed(undefined);
    });
    this.afterChange(res.game);
  }

  async claimWin(gameId: string, userId: string): Promise<void> {
    const res = await this.mutate(gameId, (game, now) => {
      requireActive(game);
      const color = requirePlayer(game, userId);
      const goneSince = game.disconnectedAt[opposite(color)];
      if (goneSince === null || now < goneSince + DISCONNECT_GRACE_MS) {
        throw new GameError('NOT_ALLOWED', 'Your opponent has not been gone long enough');
      }
      endGame(game, winnerResult(color), 'abandoned', now);
      return changed(undefined);
    });
    this.afterChange(res.game);
  }

  /** Records a player connecting to or leaving a game. The clock keeps running either way. */
  async setPresence(gameId: string, userId: string, connected: boolean): Promise<void> {
    const res = await this.mutate(gameId, (game, now) => {
      if (game.status !== 'active') return unchanged(undefined);
      const color = colorOf(game, userId);
      if (!color) return unchanged(undefined);
      const current = game.disconnectedAt[color];
      if (connected && current === null) return unchanged(undefined);
      if (!connected && current !== null) return unchanged(undefined);
      game.disconnectedAt[color] = connected ? null : now;
      return changed(undefined);
    });
    if (res.changed) this.afterChange(res.game);
  }

  // -------------------------------------------------- timers and recovery

  private async onTimer(gameId: string): Promise<void> {
    try {
      const res = await this.mutate(gameId, (game, now) => {
        if (game.status !== 'active') return unchanged(undefined);
        const abortAt = abortDeadline(game);
        if (abortAt !== null) {
          if (now < abortAt) return unchanged(undefined);
          endGame(game, '*', 'aborted', now);
          return changed(undefined);
        }
        if (!hasFlagged(game, now)) return unchanged(undefined);
        endByTimeout(game, turnAt(game.moves.length), now);
        return changed(undefined);
      });
      if (res.changed) this.afterChange(res.game);
      else this.timers.schedule(gameId, nextDeadline(res.game));
    } catch (err) {
      if (err instanceof GameError && err.code === 'NOT_FOUND') return;
      this.log.error({ err, gameId }, 'timer check failed; retrying in 1s');
      this.timers.schedule(gameId, this.now() + 1000);
    }
  }

  /** Writes a finished game to Postgres (with retries), then marks it archived in Redis. */
  async archiveGame(gameId: string, attempt = 1): Promise<void> {
    try {
      const loaded = await this.store.load(gameId);
      if (!loaded || loaded.game.status === 'active' || loaded.game.persisted) return;
      const ratingChanges = await this.archive.finish(loaded.game);
      const res = await this.mutate(gameId, (game) => {
        if (game.persisted) return unchanged(undefined);
        game.persisted = true;
        game.ratingChanges = ratingChanges;
        return changed(undefined);
      });
      await this.store.markArchived(gameId);
      if (res.changed) this.events.state(toPublic(res.game, this.now()));
    } catch (err) {
      this.log.error({ err, gameId, attempt }, 'archiving game failed');
      // Back off and retry; if the process dies, startup recovery picks it up.
      if (attempt < 5) setTimeout(() => void this.archiveGame(gameId, attempt + 1), 1000 * 2 ** attempt).unref();
    }
  }

  /**
   * Runs at startup: re-arm timers for live games, archive games that ended
   * but weren't saved, and close out Postgres rows whose live state is gone.
   */
  async recover(): Promise<{ active: string[]; archived: number; orphans: number }> {
    const ids = await this.store.liveGameIds();
    const active: string[] = [];
    let archived = 0;
    for (const id of ids) {
      const loaded = await this.store.load(id);
      if (!loaded) continue;
      if (loaded.game.status === 'active') {
        active.push(id);
        this.timers.schedule(id, nextDeadline(loaded.game));
      } else if (!loaded.game.persisted) {
        archived++;
        await this.archiveGame(id);
      } else {
        await this.store.markArchived(id);
      }
    }
    const orphans = await this.archive.abortOrphans(ids);
    this.log.info({ active: active.length, archived, orphans }, 'recovery complete');
    return { active, archived, orphans };
  }

  /** Waits for in-flight game updates to finish, then stops all timers (graceful shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.locks.values()]);
    this.timers.clearAll();
  }
}
