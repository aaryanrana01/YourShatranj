import { Chess } from 'chess.js';

/**
 * Evaluation of a finished position without asking the engine (White's view,
 * centipawns), or null if the game goes on. Shared by the in-browser review
 * and the calibration script, so both treat mates and draws identically.
 */
export function terminalEvalCp(fen: string): number | null {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return chess.turn() === 'w' ? -10_000 : 10_000;
  if (chess.isDraw()) return 0;
  return null;
}
