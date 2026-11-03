/**
 * Fitting our accuracy formula to chess.com's numbers.
 *
 * chess.com publishes its accuracy for every reviewed game but not the
 * formula behind it. So we treat it as a regression problem: for a set of
 * games we know the engine's evaluation of every position (computed once)
 * and chess.com's accuracy for each player, and we search for the two
 * constants of our formula that make our numbers closest to theirs.
 *
 * Error measure: mean absolute error (MAE) in accuracy points, so
 * "MAE 2.1" means we're 2.1 points away from chess.com on average.
 */
import { type AccuracyParams, LICHESS_PARAMS, gameAccuracy } from './review';

export interface Sample {
  /** White-POV centipawns for every position, start position first. */
  evals: number[];
  side: 'w' | 'b';
  /** chess.com's accuracy for that side. */
  target: number;
}

export function mae(samples: Sample[], p: AccuracyParams): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const s of samples) total += Math.abs(gameAccuracy(s.evals, p)[s.side] - s.target);
  return total / samples.length;
}

/** Mean signed error: positive means our numbers are higher than chess.com's. */
export function bias(samples: Sample[], p: AccuracyParams): number {
  if (samples.length === 0) return 0;
  return samples.reduce((t, s) => t + (gameAccuracy(s.evals, p)[s.side] - s.target), 0) / samples.length;
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let x = from; x <= to + step / 2; x += step) out.push(Number(x.toFixed(8)));
  return out;
}

/** Value m minimising sum(w * |x - m|): the weighted median. */
function weightedMedian(items: { x: number; w: number }[]): number {
  const sorted = items.filter((i) => i.w > 0).sort((a, b) => a.x - b.x);
  if (sorted.length === 0) return 1;
  const half = sorted.reduce((t, i) => t + i.w, 0) / 2;
  let acc = 0;
  for (const i of sorted) {
    acc += i.w;
    if (acc >= half) return i.x;
  }
  return sorted[sorted.length - 1]!.x;
}

/**
 * For one (winSlope, decay) pair, finds the best `scale` in closed form.
 * We want 100 - target ≈ scale * (100 - ours). Minimising the absolute error
 * of that is a weighted median of the ratios (100 - target) / (100 - ours),
 * weighted by (100 - ours), so the third constant costs no extra search.
 */
function scorePair(samples: Sample[], winSlope: number, decay: number): { params: AccuracyParams; error: number } {
  const gaps = samples.map((s) => ({
    ours: 100 - gameAccuracy(s.evals, { winSlope, decay, scale: 1 })[s.side],
    theirs: 100 - s.target,
  }));
  const scale = weightedMedian(gaps.filter((g) => g.ours > 0).map((g) => ({ x: g.theirs / g.ours, w: g.ours })));
  const error = gaps.reduce((t, g) => t + Math.abs(g.theirs - scale * g.ours), 0) / gaps.length;
  return { params: { winSlope, decay, scale }, error };
}

function bestOnGrid(samples: Sample[], slopes: number[], decays: number[]): { params: AccuracyParams; error: number } {
  let best = { params: { winSlope: slopes[0]!, decay: decays[0]!, scale: 1 } as AccuracyParams, error: Infinity };
  for (const winSlope of slopes) {
    for (const decay of decays) {
      const candidate = scorePair(samples, winSlope, decay);
      if (candidate.error < best.error) best = candidate;
    }
  }
  return best;
}

const SLOPE_RANGE = { min: 0.001, max: 0.02, step: 0.0005 };
const DECAY_RANGE = { min: 0.005, max: 0.25, step: 0.005 };

/**
 * How much of the formula a calibration may change, from least to most:
 *  - stretch:        only how far scores sit below 100 (1 constant)
 *  - stretch+decay:  also how hard each lost chance is punished (2)
 *  - full:           also how evaluations turn into winning chances (3)
 * More freedom always fits the games it was tuned on better, but with only a
 * few dozen games it can learn quirks of those games that don't carry over.
 * Cross-validation decides which one actually predicts new games best.
 */
export const MODELS = ['stretch', 'stretch+decay', 'full'] as const;
export type ModelName = (typeof MODELS)[number];

/**
 * Grid search over the constants the model may change: a coarse pass over a
 * wide range, then a fine pass around the best point. Brute force is fine:
 * each try is cheap because the engine work is already done. `atEdge` flags a
 * best value on the border of the range (the true best may lie outside it).
 */
export function fit(
  samples: Sample[],
  model: ModelName = 'full',
): { params: AccuracyParams; error: number; atEdge: boolean } {
  if (samples.length === 0) throw new Error('No samples to fit');
  const freeSlope = model === 'full';
  const freeDecay = model !== 'stretch';
  const coarse = bestOnGrid(
    samples,
    freeSlope ? range(SLOPE_RANGE.min, SLOPE_RANGE.max, SLOPE_RANGE.step) : [LICHESS_PARAMS.winSlope],
    freeDecay ? range(DECAY_RANGE.min, DECAY_RANGE.max, DECAY_RANGE.step) : [LICHESS_PARAMS.decay],
  );
  const { winSlope, decay } = coarse.params;
  const atEdge =
    (freeSlope && (winSlope <= SLOPE_RANGE.min || winSlope >= SLOPE_RANGE.max)) ||
    (freeDecay && (decay <= DECAY_RANGE.min || decay >= DECAY_RANGE.max));
  const fine = bestOnGrid(
    samples,
    freeSlope
      ? range(Math.max(0.0005, winSlope - SLOPE_RANGE.step), winSlope + SLOPE_RANGE.step, SLOPE_RANGE.step / 20)
      : [winSlope],
    freeDecay
      ? range(Math.max(0.002, decay - DECAY_RANGE.step), decay + DECAY_RANGE.step, DECAY_RANGE.step / 20)
      : [decay],
  );
  // Report the error exactly as the app will compute it (scores clamped to 0–100).
  return { params: fine.params, error: mae(samples, fine.params), atEdge };
}

/**
 * K-fold cross-validation: games are split into k groups; each group in turn
 * is held out while the model is fitted on the rest, then scored on it. Every
 * game is "unseen" exactly once, so the error is a much steadier estimate than
 * a single held-out batch. Both sides of a game always stay in the same group.
 */
export function crossValidate(samples: (Sample & { id: string })[], model: ModelName, k = 5): number {
  let total = 0;
  let count = 0;
  for (let f = 0; f < k; f++) {
    const test = samples.filter((s) => foldOf(s.id, k) === f);
    const train = samples.filter((s) => foldOf(s.id, k) !== f);
    if (test.length === 0 || train.length === 0) continue;
    const { params } = fit(train, model);
    total += mae(test, params) * test.length;
    count += test.length;
  }
  return count === 0 ? NaN : total / count;
}

/**
 * Picks the simplest model whose cross-validated error is within `tolerance`
 * points of the best: a gain smaller than that is more likely luck than skill.
 */
export function chooseModel(errors: Record<ModelName, number>, tolerance = 0.3): ModelName {
  const best = Math.min(...MODELS.map((m) => errors[m]));
  return MODELS.find((m) => errors[m] <= best + tolerance) ?? 'stretch';
}

/** Stable group number (0..k-1) for a game, so reruns split games the same way. */
export function foldOf(key: string, k: number): number {
  return Math.min(k - 1, Math.floor(hashUnit(key) * k));
}

/** Stable pseudo-random split by key, so reruns put each game on the same side. */
export function isHoldout(key: string, fraction = 0.25): boolean {
  return hashUnit(key) < fraction;
}

/** Hash of a string mapped to [0, 1]. */
function hashUnit(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  // Final mixing (MurmurHash3's fmix32): without it, ids that differ only in
  // their last character land on the same side of the split.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/** What we keep from chess.com's monthly archive JSON. */
export interface CalibrationGame {
  id: string;
  pgn: string;
  accuracies: { white: number; black: number };
}

/**
 * Picks usable games from one month of chess.com's archive: standard chess
 * only (variants like Chess960 can't be replayed), reviewed (has accuracies),
 * and long enough that one move doesn't decide the whole score.
 */
export function pickGames(monthJson: unknown, minPlies = 20): CalibrationGame[] {
  const games = (monthJson as { games?: unknown[] } | null)?.games;
  if (!Array.isArray(games)) return [];
  const out: CalibrationGame[] = [];
  for (const raw of games) {
    const g = raw as {
      url?: unknown;
      pgn?: unknown;
      rules?: unknown;
      accuracies?: { white?: unknown; black?: unknown };
    };
    if (typeof g.url !== 'string' || typeof g.pgn !== 'string') continue;
    if ((g.rules ?? 'chess') !== 'chess') continue;
    const w = g.accuracies?.white;
    const b = g.accuracies?.black;
    if (typeof w !== 'number' || typeof b !== 'number') continue;
    // Count plies from the PGN's move text: numbers like "12." are not moves.
    const moveText = g.pgn.replace(/\[[^\]]*\]/g, '').replace(/\{[^}]*\}/g, '');
    const plies = moveText.split(/\s+/).filter((t) => t && !/^\d+\.+$/.test(t) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)).length;
    if (plies < minPlies) continue;
    out.push({ id: g.url, pgn: g.pgn, accuracies: { white: w, black: b } });
  }
  return out;
}
