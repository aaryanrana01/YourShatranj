import { describe, expect, it } from 'vitest';
import { materialBalance } from './material';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('materialBalance', () => {
  it('starts level with nothing captured', () => {
    expect(materialBalance(START)).toEqual({ captured: { w: [], b: [] }, diff: 0 });
  });

  it('shows a pawn trade as level, with one pawn on each side', () => {
    // 1. e4 d5 2. exd5 Qxd5
    const m = materialBalance('rnb1kbnr/ppp1pppp/8/3q4/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3');
    expect(m.captured).toEqual({ w: ['p'], b: ['p'] });
    expect(m.diff).toBe(0);
  });

  it('counts a won knight as +3 for the side that took it', () => {
    // Black has lost the g8 knight.
    const m = materialBalance('rnbqkb1r/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(m.captured.w).toEqual(['n']);
    expect(m.captured.b).toEqual([]);
    expect(m.diff).toBe(3);
  });

  it('lists captures in chess.com order and adds them up', () => {
    // White has lost a rook and a pawn; Black has lost a bishop.
    const m = materialBalance('rn1qkbnr/pppppppp/8/8/8/8/1PPPPPPP/1NBQKBNR w Kkq - 0 1');
    expect(m.captured.b).toEqual(['p', 'r']);
    expect(m.captured.w).toEqual(['b']);
    expect(m.diff).toBe(-3); // White 39 - 6 = 33, Black 39 - 3 = 36
  });

  it('scores a promotion by what is on the board', () => {
    // White's h-pawn became a second queen (on a3). The pawn is gone (-1), a queen arrived (+9): White +8.
    const m = materialBalance('rnbqkbnr/pppppppp/8/8/8/Q7/PPPPPPP1/RNBQKBNR w KQkq - 0 1');
    expect(m.captured.w).toEqual([]);
    expect(m.diff).toBe(8);
  });
});
