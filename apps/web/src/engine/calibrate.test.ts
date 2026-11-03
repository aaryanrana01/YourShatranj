import { describe, expect, it } from 'vitest';
import { type Sample, chooseModel, crossValidate, fit, foldOf, isHoldout, mae, pickGames } from './calibrate';
import { LICHESS_PARAMS, gameAccuracy } from './review';

/** Deterministic random numbers, so the test is the same every run. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

/** A plausible game: small drifts with occasional mistakes that swing the evaluation. */
function fakeGame(rand: () => number, plies = 60): number[] {
  const evals = [20];
  for (let i = 0; i < plies; i++) {
    const last = evals[evals.length - 1]!;
    const mover = i % 2 === 0 ? 1 : -1;
    const slip = rand() < 0.15 ? rand() * 250 : rand() * 25;
    evals.push(Math.round(last - mover * slip + (rand() - 0.5) * 10));
  }
  return evals;
}

describe('accuracy calibration', () => {
  it('recovers the constants that produced the targets', () => {
    const rand = rng(42);
    // A slope beyond the old search range, plus a stretch, like a real calibration run found.
    const truth = { winSlope: 0.0115, decay: 0.031, scale: 1.4 };
    const samples: Sample[] = [];
    for (let g = 0; g < 30; g++) {
      const evals = fakeGame(rand);
      const acc = gameAccuracy(evals, truth);
      samples.push({ evals, side: 'w', target: acc.w }, { evals, side: 'b', target: acc.b });
    }
    const result = fit(samples);
    expect(result.error).toBeLessThan(0.3);
    expect(result.atEdge).toBe(false);
    expect(result.params.scale).toBeCloseTo(1.4, 1);
    // Our formula gave higher numbers than the "truth" (chess.com-like) before fitting.
    expect(mae(samples, LICHESS_PARAMS)).toBeGreaterThan(3);
  });

  it('keeps a flawless game at 100 whatever the scale', () => {
    const flawless = Array.from({ length: 41 }, () => 30);
    const acc = gameAccuracy(flawless, { winSlope: 0.004, decay: 0.04, scale: 1.6 });
    expect(acc.w).toBeGreaterThan(99);
    // ...while an imperfect game is pulled down.
    const rand = rng(7);
    const flawed = fakeGame(rand);
    expect(gameAccuracy(flawed, { ...LICHESS_PARAMS, scale: 1.5 }).w).toBeLessThan(gameAccuracy(flawed, LICHESS_PARAMS).w);
  });

  it('prefers the simplest model unless a richer one is clearly better', () => {
    expect(chooseModel({ stretch: 4.3, 'stretch+decay': 4.1, full: 4.05 })).toBe('stretch');
    expect(chooseModel({ stretch: 5.2, 'stretch+decay': 4.1, full: 4.0 })).toBe('stretch+decay');
    expect(chooseModel({ stretch: 6, 'stretch+decay': 5, full: 4 })).toBe('full');
  });

  it('cross-validation picks the simple model when the data really is that simple', () => {
    const rand = rng(99);
    const truth = { ...LICHESS_PARAMS, scale: 1.35 };
    const samples: (Sample & { id: string })[] = [];
    for (let g = 0; g < 20; g++) {
      const evals = fakeGame(rand, 50);
      const acc = gameAccuracy(evals, truth);
      // Noise like real-world disagreement: the richer models will try to fit it.
      samples.push(
        { id: `g${g}`, evals, side: 'w', target: acc.w + (rand() - 0.5) * 8 },
        { id: `g${g}`, evals, side: 'b', target: acc.b + (rand() - 0.5) * 8 },
      );
    }
    const errors = {
      stretch: crossValidate(samples, 'stretch'),
      'stretch+decay': crossValidate(samples, 'stretch+decay'),
      full: crossValidate(samples, 'full'),
    };
    expect(chooseModel(errors)).toBe('stretch');
  }, 120_000);

  it('spreads games evenly over the cross-validation folds', () => {
    const counts = [0, 0, 0, 0, 0];
    for (let i = 0; i < 500; i++) counts[foldOf(`https://www.chess.com/game/live/${9000 + i * 13}`, 5)]!++;
    for (const c of counts) expect(c).toBeGreaterThan(70);
  });

  it('keeps the train/test split stable across runs', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `https://www.chess.com/game/live/${1000 + i}`);
    const held = ids.filter((id) => isHoldout(id));
    expect(held.length).toBeGreaterThan(60);
    expect(held.length).toBeLessThan(140);
    expect(ids.filter((id) => isHoldout(id))).toEqual(held);
  });

  it('only picks reviewed, standard, long-enough games from chess.com data', () => {
    const longPgn = `[Event "Live"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 11. c4 c6 1-0`;
    const data = {
      games: [
        { url: 'a', pgn: longPgn, rules: 'chess', accuracies: { white: 80, black: 70 } },
        { url: 'b', pgn: longPgn, rules: 'chess' }, // not reviewed
        { url: 'c', pgn: longPgn, rules: 'chess960', accuracies: { white: 1, black: 2 } }, // variant
        { url: 'd', pgn: '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0', rules: 'chess', accuracies: { white: 99, black: 20 } }, // too short
        { url: 'e', rules: 'chess', accuracies: { white: 1, black: 1 } }, // no pgn
      ],
    };
    expect(pickGames(data).map((g) => g.id)).toEqual(['a']);
    expect(pickGames(null)).toEqual([]);
  });
});
