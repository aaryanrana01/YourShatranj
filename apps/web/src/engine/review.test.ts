import { describe, expect, it } from 'vitest';
import { classify, gameAccuracy, moveAccuracy, reviewGame, winPercent } from './review';
import { parseBestMove, parseInfo, scoreToCp, toWhitePov } from './uci';

describe('UCI parsing', () => {
  it('reads depth, score and principal variation', () => {
    const info = parseInfo('info depth 18 seldepth 25 multipv 1 score cp -34 nodes 12345 nps 99 pv e7e5 g1f3 b8c6');
    expect(info).toEqual({ depth: 18, multipv: 1, score: { type: 'cp', value: -34 }, pv: ['e7e5', 'g1f3', 'b8c6'] });
  });

  it('reads mate scores and bound markers', () => {
    expect(parseInfo('info depth 5 score mate -2 pv h7h8')?.score).toEqual({ type: 'mate', value: -2 });
    expect(parseInfo('info depth 9 score cp 12 lowerbound pv e2e4')?.score).toEqual({ type: 'cp', value: 12 });
  });

  it('ignores non-search info lines', () => {
    expect(parseInfo('info string NNUE evaluation using nn-xyz')).toBeNull();
  });

  it('reads bestmove, including positions with no legal move', () => {
    expect(parseBestMove('bestmove e2e4 ponder e7e5')).toBe('e2e4');
    expect(parseBestMove('bestmove (none)')).toBeNull();
    expect(parseBestMove('info depth 1')).toBeUndefined();
  });

  it("converts black-to-move scores to White's view", () => {
    expect(toWhitePov({ type: 'cp', value: 50 }, 'b')).toEqual({ type: 'cp', value: -50 });
    expect(scoreToCp({ type: 'mate', value: 3 })).toBeGreaterThan(9000);
  });
});

describe('review maths', () => {
  it('maps an equal position to 50% and is symmetric', () => {
    expect(winPercent(0)).toBeCloseTo(50);
    expect(winPercent(300) + winPercent(-300)).toBeCloseTo(100);
  });

  it('gives 100% accuracy for a move that keeps the evaluation', () => {
    expect(moveAccuracy(60, 60)).toBeCloseTo(100, 0);
    expect(moveAccuracy(60, 20)).toBeLessThan(30);
  });

  it('classifies by win-chance drop', () => {
    expect(classify(0, true)).toBe('best');
    expect(classify(1, false)).toBe('excellent');
    expect(classify(7, false)).toBe('inaccuracy');
    expect(classify(12, false)).toBe('mistake');
    expect(classify(40, false)).toBe('blunder');
  });

  it('gives a flawless game close to 100', () => {
    const evals = Array.from({ length: 41 }, () => 20);
    const acc = gameAccuracy(evals);
    expect(acc.w).toBeGreaterThan(99);
    expect(acc.b).toBeGreaterThan(99);
  });

  it('scores lower than a plain average when mistakes hide among easy moves', () => {
    // 40 quiet moves, then White drops a piece in a sharp moment, then quiet again.
    const evals = [
      ...Array.from({ length: 20 }, (_, i) => 20 + (i % 2) * 15),
      150, -60, -250, -260, -240,
      ...Array.from({ length: 16 }, () => -250),
    ];
    const plainMeanWhite = (() => {
      const accs: number[] = [];
      for (let i = 0; i + 1 < evals.length; i += 2) accs.push(moveAccuracy(winPercent(evals[i]!), winPercent(evals[i + 1]!)));
      return accs.reduce((a, b) => a + b, 0) / accs.length;
    })();
    expect(gameAccuracy(evals).w).toBeLessThan(plainMeanWhite);
  });

  it("judges each move from the mover's side", () => {
    // White plays the best move; Black then hangs a queen (eval swings to +900 for White).
    const review = reviewGame(
      [
        { uci: 'e2e4', san: 'e4' },
        { uci: 'd8h4', san: 'Qh4' },
      ],
      [20, 25, 900],
      ['e2e4', 'e7e5'],
    );
    expect(review.moves[0]!.classification).toBe('best');
    expect(review.moves[1]!.classification).toBe('blunder');
    expect(review.accuracy.w).toBeGreaterThan(review.accuracy.b);
    expect(review.counts.b.blunder).toBe(1);
  });

  it('calls any checkmate "best", even when the engine preferred a different mate', () => {
    // White has two mates in one (like Qg7# and Qxf8#); the engine named the other one.
    const review = reviewGame([{ uci: 'g6g7', san: 'Qg7#' }], [9_990, 10_000], ['g6f8']);
    expect(review.moves[0]!.classification).toBe('best');
  });

  it('calls a move "best" when it keeps the fastest forced mate', () => {
    // White has mate in 3 and plays a different move from the engine's that still leaves mate in 2.
    const review = reviewGame([{ uci: 'h5h7', san: 'Qh7+' }], [9_970, 9_980], ['d1d8']);
    expect(review.moves[0]!.classification).toBe('best');
  });

  it('does not call a slower mate "best"', () => {
    // Mate in 2 was available; the move played only keeps mate in 5.
    const review = reviewGame([{ uci: 'a1a2', san: 'Ra2' }], [9_980, 9_950], ['h5h7']);
    expect(review.moves[0]!.classification).not.toBe('best');
  });
});
