/**
 * Captured pieces and material balance, worked out from the position alone
 * (so it's always right, whatever page or move you're looking at).
 *
 * "Captured by White" = Black pieces missing from the board compared with the
 * starting set. Promotions are handled the way chess.com and Lichess do it:
 * the material score counts what's actually on the board.
 */

export type PieceKind = 'p' | 'n' | 'b' | 'r' | 'q';

/** Standard piece values: pawn 1, knight 3, bishop 3, rook 5, queen 9. */
export const PIECE_VALUE: Record<PieceKind, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

const START_COUNT: Record<PieceKind, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
/** Display order, as on chess.com: pawns first, queen last. */
const ORDER: PieceKind[] = ['p', 'n', 'b', 'r', 'q'];

export interface MaterialBalance {
  /** Pieces each side has taken from the other (e.g. captured.w = Black pieces White took). */
  captured: { w: PieceKind[]; b: PieceKind[] };
  /** White's material minus Black's. Positive = White is ahead. */
  diff: number;
}

export function materialBalance(fen: string): MaterialBalance {
  const board = fen.split(' ')[0] ?? '';
  const count = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0 } as Record<PieceKind, number>,
    b: { p: 0, n: 0, b: 0, r: 0, q: 0 } as Record<PieceKind, number>,
  };
  for (const ch of board) {
    const kind = ch.toLowerCase() as PieceKind;
    if (!(kind in PIECE_VALUE)) continue; // digits, slashes, kings
    count[ch === kind ? 'b' : 'w'][kind] += 1;
  }

  const missing = (side: 'w' | 'b') =>
    ORDER.flatMap((k) => Array<PieceKind>(Math.max(0, START_COUNT[k] - count[side][k])).fill(k));
  const total = (side: 'w' | 'b') => ORDER.reduce((sum, k) => sum + count[side][k] * PIECE_VALUE[k], 0);

  return {
    captured: { w: missing('b'), b: missing('w') },
    diff: total('w') - total('b'),
  };
}
