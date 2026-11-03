/**
 * Game review maths. Pure functions over engine evaluations.
 *
 * Win% turns a centipawn score into the chance of winning, using the curve
 * Lichess fitted to millions of games. Judging moves by win% instead of raw
 * centipawns means dropping 3 pawns when you're already up a queen barely
 * matters, while dropping 1 pawn in an equal position does.
 *
 * chess.com's exact accuracy formula isn't public. The SHAPE here is Lichess's
 * published method; its two constants (how fast an advantage turns into
 * winning chances, and how hard a lost chance is punished) come from
 * accuracy-params.json. Out of the box those are Lichess's values; run
 * `pnpm --filter @chess/web calibrate <chess.com username>` to fit them to
 * chess.com's accuracies on real games (see scripts/calibrate-accuracy.ts).
 */
import params from './accuracy-params.json';

export interface AccuracyParams {
  /** Logistic slope turning centipawns into win%. Lichess: 0.00368208. */
  winSlope: number;
  /** How quickly a move's accuracy falls as win% is lost. Lichess: 0.04354. */
  decay: number;
  /**
   * Stretches each player's distance below 100: final = 100 - scale * (100 - accuracy).
   * A perfect game stays 100 whatever the scale. Lichess: 1.
   */
  scale: number;
  /** Older calibrations shifted every score by a constant instead; kept so those files still load. */
  offset?: number;
}

export const LICHESS_PARAMS: AccuracyParams = { winSlope: 0.00368208, decay: 0.04354415386753951, scale: 1 };
export const DEFAULT_PARAMS: AccuracyParams = {
  winSlope: params.winSlope,
  decay: params.decay,
  scale: (params as { scale?: number }).scale ?? 1,
  offset: (params as { offset?: number }).offset ?? 0,
};
export interface ParamsInfo extends AccuracyParams {
  source: string;
  depth: number | null;
  games: number;
  maeBefore: number | null;
  maeAfter: number | null;
  maeUnseen?: number | null;
  fittedAt: string | null;
}
export const PARAMS_INFO = params as ParamsInfo;

export type MoveClass = 'best' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export interface ReviewedMove {
  ply: number;
  uci: string;
  san: string;
  bestMove: string | null;
  /** White-POV centipawns before and after the move. */
  cpBefore: number;
  cpAfter: number;
  /** How much the mover's win chance dropped, in percentage points (0–100). */
  winDrop: number;
  accuracy: number;
  classification: MoveClass;
}

export interface ReviewSummary {
  moves: ReviewedMove[];
  accuracy: { w: number; b: number };
  counts: { w: Record<MoveClass, number>; b: Record<MoveClass, number> };
}

/** 0–100, from White's point of view. */
export function winPercent(cp: number, slope = DEFAULT_PARAMS.winSlope): number {
  const clamped = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-slope * clamped)) - 1);
}

/**
 * Accuracy of one move from the mover's win% before and after, 0–100
 * (Lichess's curve, including its +1 allowance for engine uncertainty).
 * The curve's constants are chosen so that losing nothing scores 100.
 */
export function moveAccuracy(winBefore: number, winAfter: number, decay = DEFAULT_PARAMS.decay): number {
  if (winAfter >= winBefore) return 100;
  const drop = winBefore - winAfter;
  const raw = 103.1668100711649 * Math.exp(-decay * drop) - 3.166924740191411;
  return Math.max(0, Math.min(100, raw + 1));
}

function stdDev(xs: number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
}

/**
 * Whole-game accuracy per side, following Lichess's published method:
 *  - each move's accuracy is weighted by how volatile the game was around it
 *    (standard deviation of win% in a sliding window), so a slip in a sharp
 *    position counts more than one in a quiet, settled position;
 *  - the weighted mean is averaged with the harmonic mean, which a single
 *    terrible move drags down hard.
 * The old version used a plain mean, which let many easy moves hide errors
 * and gave scores that were too high.
 */
export function gameAccuracy(evalsCp: number[], p: AccuracyParams = DEFAULT_PARAMS): { w: number; b: number } {
  const wins = evalsCp.map((cp) => winPercent(cp, p.winSlope)); // White's win% at every position
  const moves = wins.length - 1;
  if (moves <= 0) return { w: 100, b: 100 };

  const windowSize = Math.min(8, Math.max(2, Math.floor(moves / 10)));
  const size = Math.min(windowSize, wins.length);
  const windows: number[][] = [];
  // The first few moves have no full window behind them; they reuse the first one.
  for (let i = 0; i < size - 2; i++) windows.push(wins.slice(0, size));
  for (let i = 0; i + size <= wins.length; i++) windows.push(wins.slice(i, i + size));
  const weights = windows.map((w) => Math.min(12, Math.max(0.5, stdDev(w))));

  const sides: { w: [number, number][]; b: [number, number][] } = { w: [], b: [] };
  for (let i = 0; i < moves; i++) {
    const white = i % 2 === 0;
    const before = white ? wins[i]! : 100 - wins[i]!;
    const after = white ? wins[i + 1]! : 100 - wins[i + 1]!;
    sides[white ? 'w' : 'b'].push([moveAccuracy(before, after, p.decay), weights[i] ?? 1]);
  }

  const score = (list: [number, number][]) => {
    if (list.length === 0) return 100;
    const totalWeight = list.reduce((s, [, w]) => s + w, 0);
    const weighted = list.reduce((s, [a, w]) => s + a * w, 0) / totalWeight;
    // Accuracies of 0 would make the harmonic mean meaningless; floor them slightly above zero.
    const harmonic = list.length / list.reduce((s, [a]) => s + 1 / Math.max(a, 0.5), 0);
    const raw = (weighted + harmonic) / 2;
    return Math.max(0, Math.min(100, 100 - (p.scale ?? 1) * (100 - raw) + (p.offset ?? 0)));
  };
  return { w: score(sides.w), b: score(sides.b) };
}

/** scoreToCp turns "mate in N" into 10 000 - 10N; anything this high is a forced mate. */
const MATE_CP_THRESHOLD = 9_000;

export function classify(winDrop: number, playedBest: boolean): MoveClass {
  if (playedBest) return 'best';
  if (winDrop < 2) return 'excellent';
  if (winDrop < 5) return 'good';
  if (winDrop < 10) return 'inaccuracy';
  if (winDrop < 20) return 'mistake';
  return 'blunder';
}

const emptyCounts = (): Record<MoveClass, number> => ({
  best: 0,
  excellent: 0,
  good: 0,
  inaccuracy: 0,
  mistake: 0,
  blunder: 0,
});

/**
 * @param moves     the game's moves (uci + san), in order
 * @param evalsCp   White-POV centipawns for every position: evalsCp[0] = start, evalsCp[i+1] = after move i
 * @param bestMoves engine's best move in every position before a move: bestMoves[i] for position i
 */
export function reviewGame(
  moves: { uci: string; san: string }[],
  evalsCp: number[],
  bestMoves: (string | null)[],
): ReviewSummary {
  const reviewed: ReviewedMove[] = [];
  const counts = { w: emptyCounts(), b: emptyCounts() };

  moves.forEach((m, i) => {
    const mover = i % 2 === 0 ? 'w' : 'b';
    const before = evalsCp[i] ?? 0;
    const after = evalsCp[i + 1] ?? before;
    // Move labels always use the standard (Lichess) curve. Calibration tunes the
    // accuracy NUMBER; it must not quietly change which moves count as mistakes.
    const winBeforeWhite = winPercent(before, LICHESS_PARAMS.winSlope);
    const winAfterWhite = winPercent(after, LICHESS_PARAMS.winSlope);
    const winBefore = mover === 'w' ? winBeforeWhite : 100 - winBeforeWhite;
    const winAfter = mover === 'w' ? winAfterWhite : 100 - winAfterWhite;
    const winDrop = Math.max(0, winBefore - winAfter);
    const best = bestMoves[i] ?? null;
    // Often several moves are equally best, e.g. two different mates in one. The
    // engine names only one, so also count a move as best when it checkmates, or
    // when it keeps a forced mate at least as fast as the engine's line. (Mate
    // scores are exact; ordinary centipawn scores are too noisy for this test.)
    const moverBefore = mover === 'w' ? before : -before;
    const moverAfter = mover === 'w' ? after : -after;
    const keepsFastestMate = moverBefore >= MATE_CP_THRESHOLD && moverAfter >= moverBefore;
    const playedBest = (best !== null && best === m.uci) || m.san.endsWith('#') || keepsFastestMate;
    const classification = classify(winDrop, playedBest);
    const accuracy = moveAccuracy(winBefore, winAfter, LICHESS_PARAMS.decay);
    counts[mover][classification]++;
    reviewed.push({ ply: i, uci: m.uci, san: m.san, bestMove: best, cpBefore: before, cpAfter: after, winDrop, accuracy, classification });
  });

  return {
    moves: reviewed,
    accuracy: gameAccuracy(evalsCp.slice(0, moves.length + 1)),
    counts,
  };
}

export const CLASS_STYLE: Record<MoveClass, { label: string; symbol: string; color: string }> = {
  best: { label: 'Best', symbol: '★', color: 'var(--color-good)' },
  excellent: { label: 'Excellent', symbol: '!', color: 'var(--color-good)' },
  good: { label: 'Good', symbol: '✓', color: '#8fb4d9' },
  inaccuracy: { label: 'Inaccuracy', symbol: '?!', color: 'var(--color-inacc)' },
  mistake: { label: 'Mistake', symbol: '?', color: 'var(--color-mistake)' },
  blunder: { label: 'Blunder', symbol: '??', color: 'var(--color-blunder)' },
};
