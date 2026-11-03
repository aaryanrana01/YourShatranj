import { Chess, type Move } from 'chess.js';
import type { Color, EndReason, GameResult } from '@chess/shared';

/**
 * Thin wrapper over chess.js. The server never trusts a FEN from anyone:
 * it rebuilds the position by replaying the stored move list, which also
 * keeps the history chess.js needs to detect threefold repetition.
 */
export function replay(uciMoves: readonly string[]): Chess {
  const chess = new Chess();
  for (const uci of uciMoves) {
    const applied = tryMove(chess, uci);
    if (!applied) throw new Error(`Corrupt move list: ${uci} is illegal`);
  }
  return chess;
}

/** Applies a UCI move if legal; returns null for anything illegal or malformed. */
export function tryMove(chess: Chess, uci: string): Move | null {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length === 5 ? uci[4] : undefined;
  try {
    const move = chess.move({ from, to, promotion });
    // A promotion move must say which piece; chess.js would otherwise default to a queen.
    if (move.isPromotion() && !promotion) {
      chess.undo();
      return null;
    }
    // A non-promotion move must not carry a promotion letter.
    if (!move.isPromotion() && promotion) {
      chess.undo();
      return null;
    }
    return move;
  } catch {
    return null;
  }
}

export interface Ending {
  result: GameResult;
  reason: EndReason;
}

/**
 * Checks every rule that ends a game by itself. Like chess.com, threefold
 * repetition and the 50-move rule end the game automatically (no claim needed).
 */
export function detectEnd(chess: Chess): Ending | null {
  if (chess.isCheckmate()) {
    // The side to move is the one that's been mated.
    return { result: chess.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
  }
  if (chess.isStalemate()) return { result: '1/2-1/2', reason: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { result: '1/2-1/2', reason: 'insufficient_material' };
  if (chess.isThreefoldRepetition()) return { result: '1/2-1/2', reason: 'repetition' };
  if (chess.isDrawByFiftyMoves()) return { result: '1/2-1/2', reason: 'fifty_move' };
  return null;
}

/**
 * Whether `color` still has enough material to ever checkmate. Used when the
 * opponent runs out of time: per FIDE rules, if the side with time left can't
 * possibly mate, the game is a draw rather than a win.
 * Simplification (same as most sites): a lone king, or king plus a single
 * bishop or knight, can't mate.
 */
export function hasMatingMaterial(chess: Chess, color: Color): boolean {
  const pieces: string[] = [];
  for (const row of chess.board()) {
    for (const square of row) {
      if (square && square.color === color && square.type !== 'k') pieces.push(square.type);
    }
  }
  if (pieces.length === 0) return false;
  if (pieces.length === 1 && (pieces[0] === 'b' || pieces[0] === 'n')) return false;
  return true;
}

export function winnerResult(winner: Color): GameResult {
  return winner === 'w' ? '1-0' : '0-1';
}
