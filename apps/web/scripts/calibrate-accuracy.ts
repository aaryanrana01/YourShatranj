/**
 * Fits our accuracy formula to chess.com's accuracies on real games.
 *
 *   pnpm --filter @chess/web calibrate <chess.com username> [--games 40] [--depth 18]
 *
 * 1. Downloads the player's games that were reviewed on chess.com (only those
 *    carry chess.com's accuracy numbers).
 * 2. Evaluates every position with the SAME Stockfish build the browser uses,
 *    at the same depth as the review, so the fitted numbers apply directly.
 *    Results are cached in .calibration-cache.json, so a rerun (or a run
 *    stopped half-way) doesn't repeat engine work.
 * 3. Tries three versions of the formula with more or less freedom, scores
 *    each on games it wasn't tuned on (5-fold cross-validation), keeps the
 *    simplest one that isn't clearly worse, and writes its constants to
 *    src/engine/accuracy-params.json, which the web app reads.
 *
 * Options:
 *   --games N        how many reviewed games to use (default 40; more = better fit, slower)
 *   --depth D        engine depth; must match the review depth you'll use (default 18 = "Standard")
 *   --from-file F    use games from a JSON file instead of chess.com:
 *                    [{ "id": "...", "pgn": "...", "accuracies": { "white": 81.2, "black": 74.0 } }]
 *   --dry-run        fit and report, but don't overwrite accuracy-params.json
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import {
  type CalibrationGame,
  MODELS,
  type ModelName,
  type Sample,
  bias,
  chooseModel,
  crossValidate,
  fit,
  mae,
  pickGames,
} from '../src/engine/calibrate';
import { LICHESS_PARAMS } from '../src/engine/review';
import { terminalEvalCp } from '../src/engine/terminal';
import { parseBestMove, parseInfo, scoreToCp, toWhitePov } from '../src/engine/uci';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '..');
const PARAMS_FILE = path.join(WEB_ROOT, 'src/engine/accuracy-params.json');
const CACHE_FILE = path.join(WEB_ROOT, '.calibration-cache.json');
// chess.com asks API clients to identify themselves; no personal data needed.
const USER_AGENT = 'RookeryAccuracyCalibration/1.0 (open-source chess project)';

// ------------------------------------------------------------------ args

function parseArgs(argv: string[]) {
  const opts = { username: '', games: 40, depth: 18, fromFile: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--games') opts.games = Number(argv[++i]);
    else if (a === '--depth') opts.depth = Number(argv[++i]);
    else if (a === '--from-file') opts.fromFile = argv[++i] ?? '';
    else if (a === '--dry-run') opts.dryRun = true;
    else if (!a.startsWith('--')) opts.username = a;
  }
  if (!opts.username && !opts.fromFile) {
    console.error('Usage: pnpm --filter @chess/web calibrate <chess.com username> [--games 40] [--depth 18]');
    process.exit(1);
  }
  if (!/^[A-Za-z0-9_-]{2,25}$/.test(opts.username) && !opts.fromFile) {
    console.error('That does not look like a chess.com username.');
    process.exit(1);
  }
  if (!Number.isInteger(opts.games) || opts.games < 5) throw new Error('--games must be at least 5');
  if (!Number.isInteger(opts.depth) || opts.depth < 6 || opts.depth > 24) throw new Error('--depth must be 6–24');
  return opts;
}

// ------------------------------------------------------------- chess.com

async function getJson(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (res.status === 404) throw new Error(`Not found on chess.com: ${url}`);
    if (res.status === 429) {
      // Too many requests: wait and retry (requests are already one at a time).
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`chess.com returned ${res.status} for ${url}`);
    return res.json();
  }
  throw new Error('chess.com kept rate-limiting; try again in a minute.');
}

async function downloadGames(username: string, wanted: number): Promise<CalibrationGame[]> {
  const user = username.toLowerCase();
  const { archives } = (await getJson(`https://api.chess.com/pub/player/${user}/games/archives`)) as { archives: string[] };
  const picked: CalibrationGame[] = [];
  for (const monthUrl of [...archives].reverse()) {
    if (picked.length >= wanted) break;
    process.stdout.write(`  ${monthUrl.slice(-7)}: `);
    const found = pickGames(await getJson(monthUrl));
    console.log(`${found.length} reviewed games`);
    picked.push(...found);
  }
  if (picked.length === 0) {
    throw new Error(
      'No reviewed games found. chess.com only publishes accuracy for games that have been reviewed: ' +
        'open a few of your games on chess.com, run Game Review, then try again.',
    );
  }
  return picked.slice(0, wanted);
}

// ---------------------------------------------------------------- engine

/** Same Stockfish build the browser uses (lite, single-threaded), driven over UCI. */
class NodeEngine {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private waiter: ((line: string) => void) | null = null;

  constructor() {
    const require = createRequire(import.meta.url);
    const dir = path.join(path.dirname(require.resolve('stockfish/package.json')), 'src');
    const file = readdirSync(dir).find((f) => /^stockfish-.*-lite-single-[0-9a-f]+\.js$/.test(f));
    if (!file) throw new Error('Stockfish lite-single build not found; run pnpm install');
    this.proc = spawn(process.execPath, [path.join(dir, file)], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let i: number;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        this.waiter?.(line);
      }
    });
  }

  private until(cmd: string, done: (line: string) => boolean, onLine?: (line: string) => void): Promise<void> {
    return new Promise((resolve) => {
      this.waiter = (line) => {
        onLine?.(line);
        if (done(line)) {
          this.waiter = null;
          resolve();
        }
      };
      this.proc.stdin.write(`${cmd}\n`);
    });
  }

  async init() {
    await this.until('uci', (l) => l === 'uciok');
    await this.until('isready', (l) => l === 'readyok');
  }

  async newGame() {
    this.proc.stdin.write('ucinewgame\n');
    await this.until('isready', (l) => l === 'readyok');
  }

  /** White-POV centipawns for a position, computed exactly like the browser review. */
  async evaluate(fen: string, depth: number): Promise<number | null> {
    const sideToMove = fen.split(' ')[1] === 'b' ? 'b' : 'w';
    let last: ReturnType<typeof parseInfo> = null;
    this.proc.stdin.write(`setoption name MultiPV value 1\nposition fen ${fen}\n`);
    await this.until(
      `go depth ${depth}`,
      (l) => parseBestMove(l) !== undefined,
      (l) => {
        const info = parseInfo(l);
        if (info && info.multipv === 1) last = info;
      },
    );
    const info = last as ReturnType<typeof parseInfo>;
    return info ? scoreToCp(toWhitePov(info.score, sideToMove)) : null;
  }

  quit() {
    this.proc.stdin.write('quit\n');
    this.proc.kill();
  }
}

// ----------------------------------------------------------------- cache

type Cache = Record<string, { depth: number; evals: number[] }>;

function loadCache(): Cache {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Cache;
  } catch {
    return {};
  }
}

async function evaluateGames(games: CalibrationGame[], depth: number): Promise<Map<string, number[]>> {
  const cache = loadCache();
  const result = new Map<string, number[]>();
  const todo = games.filter((g) => cache[g.id]?.depth !== depth);
  if (todo.length > 0) console.log(`\nEvaluating ${todo.length} games at depth ${depth} (${games.length - todo.length} cached)…`);

  const engine = new NodeEngine();
  await engine.init();
  try {
    for (const [n, game] of todo.entries()) {
      const chess = new Chess();
      try {
        chess.loadPgn(game.pgn);
      } catch {
        console.log(`  skipping unreadable game ${game.id}`);
        continue;
      }
      const history = chess.history({ verbose: true });
      const fens = [history[0]?.before ?? chess.fen(), ...history.map((m) => m.after)];
      await engine.newGame();
      const evals: number[] = [];
      for (const fen of fens) {
        const terminal = terminalEvalCp(fen);
        evals.push(terminal ?? (await engine.evaluate(fen, depth)) ?? evals[evals.length - 1] ?? 0);
      }
      cache[game.id] = { depth, evals };
      // Save after every game, so stopping with Ctrl+C loses at most one game's work.
      writeFileSync(CACHE_FILE, JSON.stringify(cache));
      console.log(`  [${n + 1}/${todo.length}] ${fens.length - 1} moves`);
    }
  } finally {
    engine.quit();
  }
  for (const g of games) {
    const hit = cache[g.id];
    if (hit && hit.depth === depth) result.set(g.id, hit.evals);
  }
  return result;
}

// ------------------------------------------------------------------ main

const fmt = (n: number) => n.toFixed(2);

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(opts.fromFile ? `Reading games from ${opts.fromFile}` : `Fetching reviewed games for ${opts.username}…`);
  const games: CalibrationGame[] = opts.fromFile
    ? (JSON.parse(readFileSync(opts.fromFile, 'utf8')) as CalibrationGame[]).slice(0, opts.games)
    : await downloadGames(opts.username, opts.games);
  if (games.length < opts.games) console.log(`Only ${games.length} reviewed games available; using all of them.`);

  const evals = await evaluateGames(games, opts.depth);
  const samples: (Sample & { id: string })[] = [];
  for (const g of games) {
    const e = evals.get(g.id);
    if (!e) continue;
    samples.push({ id: g.id, evals: e, side: 'w', target: g.accuracies.white });
    samples.push({ id: g.id, evals: e, side: 'b', target: g.accuracies.black });
  }
  if (samples.length < 10) throw new Error('Too few usable games to fit (need at least 5).');

  console.log(`\n${samples.length / 2} games.`);
  const before = { all: mae(samples, LICHESS_PARAMS), bias: bias(samples, LICHESS_PARAMS) };
  console.log(`Lichess formula: off by ${fmt(before.all)} points on average (ours ${before.bias >= 0 ? 'higher' : 'lower'} by ${fmt(Math.abs(before.bias))}).`);

  // Compare how much freedom the formula gets, scoring each option only on
  // games it was NOT tuned on (5-fold cross-validation), then keep the simplest
  // option that isn't clearly worse.
  console.log('\nError on unseen games (5-fold cross-validation):');
  const cv = {} as Record<ModelName, number>;
  for (const model of MODELS) {
    cv[model] = crossValidate(samples, model, 5);
    console.log(`  ${model.padEnd(14)} ${fmt(cv[model])} points`);
  }
  const chosen = chooseModel(cv);
  const unseen: number | null = Number.isFinite(cv[chosen]) ? cv[chosen] : null;
  console.log(`Using "${chosen}": simplest option within 0.3 points of the best.`);

  const final = fit(samples, chosen);
  const after = { all: final.error, bias: bias(samples, final.params) };
  console.log(`Final fit on all games: off by ${fmt(after.all)} points on average (bias ${fmt(after.bias)}).`);
  console.log(
    `  winSlope ${final.params.winSlope.toFixed(6)}   decay ${final.params.decay.toFixed(5)}   scale ${final.params.scale.toFixed(3)}`,
  );
  if (final.atEdge) {
    console.log('  Note: a value landed on the edge of the search range, so the best fit may lie outside it.');
  }

  // Compare like with like: the default formula was never tuned on these games,
  // so its error is already an unseen-games error.
  if (unseen !== null && unseen >= before.all) {
    console.log('\nOn unseen games the fit is no better than the default, so accuracy-params.json was left unchanged.');
    return;
  }
  if (opts.dryRun) {
    console.log('\n--dry-run: accuracy-params.json not changed.');
    return;
  }
  const out = {
    winSlope: final.params.winSlope,
    decay: final.params.decay,
    scale: Number(final.params.scale.toFixed(4)),
    source: 'fitted to chess.com accuracies',
    model: chosen,
    depth: opts.depth,
    games: samples.length / 2,
    maeBefore: Number(before.all.toFixed(2)),
    maeAfter: Number(after.all.toFixed(2)),
    // Error on games the fit never saw: the honest number to quote.
    maeUnseen: unseen === null ? null : Number(unseen.toFixed(2)),
    fittedAt: new Date().toISOString().slice(0, 10),
  };
  writeFileSync(PARAMS_FILE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nSaved to src/engine/accuracy-params.json. Restart \`pnpm dev\` and re-run a review at depth ${opts.depth}.`);
  if (existsSync(CACHE_FILE)) console.log('(Engine results are cached in apps/web/.calibration-cache.json; delete it to start fresh.)');
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
