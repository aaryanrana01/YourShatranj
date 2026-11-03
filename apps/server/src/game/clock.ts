import type { Color } from '@chess/shared';
import { FIRST_MOVE_TIMEOUT_MS, MAX_LAG_CREDIT_MS } from './constants.js';
import { type StoredGame, turnAt } from './types.js';

/**
 * All clock maths in one place, as pure functions of (game, now).
 * Only the server's time counts; the browser's countdown is a display.
 */

/** Clocks start only after both sides have made their first move (ply 2). */
export function isClockRunning(game: Pick<StoredGame, 'status' | 'moves'>): boolean {
  return game.status === 'active' && game.moves.length >= 2;
}

/** Remaining time for `color` at time `now`. */
export function remainingAt(game: StoredGame, color: Color, now: number): number {
  const stored = game.clocks[color];
  if (!isClockRunning(game) || turnAt(game.moves.length) !== color) return stored;
  return Math.max(0, stored - (now - game.turnStartedAt));
}

export function clocksAt(game: StoredGame, now: number): { w: number; b: number } {
  return { w: remainingAt(game, 'w', now), b: remainingAt(game, 'b', now) };
}

/** Half of the measured round trip, capped so nobody can fake lag for extra time. */
export function lagCredit(rttMs: number | undefined): number {
  if (!rttMs || !Number.isFinite(rttMs) || rttMs <= 0) return 0;
  return Math.min(Math.round(rttMs / 2), MAX_LAG_CREDIT_MS);
}

export type MoveClockResult =
  | { flagged: true }
  | { flagged: false; remainingMs: number };

/**
 * Time accounting for a move by the side to move.
 * remaining = remaining - (now - turnStartedAt - lagCredit) + increment
 * First moves (ply 0 and 1) cost no time and earn no increment.
 */
export function chargeMove(game: StoredGame, now: number, creditMs: number): MoveClockResult {
  const mover = turnAt(game.moves.length);
  if (!isClockRunning(game)) return { flagged: false, remainingMs: game.clocks[mover] };
  const elapsed = Math.max(0, now - game.turnStartedAt - creditMs);
  const left = game.clocks[mover] - elapsed;
  if (left <= 0) return { flagged: true };
  return { flagged: false, remainingMs: left + game.incrementMs };
}

/**
 * True when the side to move has run out of time, even after the most lag
 * credit anyone could get. The timeout timer uses this, so a move that is
 * still in flight with legitimate lag credit is never cut off early.
 */
export function hasFlagged(game: StoredGame, now: number): boolean {
  if (!isClockRunning(game)) return false;
  const mover = turnAt(game.moves.length);
  return now - game.turnStartedAt >= game.clocks[mover] + MAX_LAG_CREDIT_MS;
}

/** When an unstarted game will be aborted, or null once both sides have moved. */
export function abortDeadline(game: Pick<StoredGame, 'status' | 'moves' | 'turnStartedAt'>): number | null {
  if (game.status !== 'active' || game.moves.length >= 2) return null;
  return game.turnStartedAt + FIRST_MOVE_TIMEOUT_MS;
}

/** The next moment the server must check this game on its own (flag fall or abort), or null. */
export function nextDeadline(game: StoredGame): number | null {
  if (game.status !== 'active') return null;
  const abortAt = abortDeadline(game);
  if (abortAt !== null) return abortAt;
  const mover = turnAt(game.moves.length);
  return game.turnStartedAt + game.clocks[mover] + MAX_LAG_CREDIT_MS;
}
