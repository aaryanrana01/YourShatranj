import { type GameMovedEvent, type PublicGameState } from '@chess/shared';
import { abortDeadline, clocksAt, isClockRunning } from './clock.js';
import { DISCONNECT_GRACE_MS } from './constants.js';
import { type StoredGame, turnAt } from './types.js';

/** Builds what clients see. Clocks are computed at `now` so every client gets current values. */
export function toPublic(game: StoredGame, now: number): PublicGameState {
  const claimAt = (at: number | null) => (at === null ? null : at + DISCONNECT_GRACE_MS);
  return {
    id: game.id,
    white: game.white,
    black: game.black,
    timeControl: game.timeControl,
    timeClass: game.timeClass,
    rated: game.rated,
    status: game.status,
    fen: game.fen,
    moves: game.moves,
    ply: game.moves.length,
    turn: turnAt(game.moves.length),
    clocks: clocksAt(game, now),
    clockRunning: isClockRunning(game),
    serverNow: now,
    drawOffer: game.drawOffer,
    disconnectedAt: game.disconnectedAt,
    claimWinAt: { w: claimAt(game.disconnectedAt.w), b: claimAt(game.disconnectedAt.b) },
    abortAt: abortDeadline(game),
    result: game.result,
    endReason: game.endReason,
    ratingChanges: game.ratingChanges,
  };
}

export function toMovedEvent(game: StoredGame, now: number): GameMovedEvent {
  const last = game.moves[game.moves.length - 1];
  if (!last) throw new Error('toMovedEvent called with no moves');
  return {
    gameId: game.id,
    move: last,
    ply: game.moves.length,
    fen: game.fen,
    clocks: clocksAt(game, now),
    clockRunning: isClockRunning(game),
    serverNow: now,
    drawOffer: game.drawOffer,
    abortAt: abortDeadline(game),
  };
}
