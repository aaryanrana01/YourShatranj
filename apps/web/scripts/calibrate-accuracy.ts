/**
 * Fits our accuracy formula to chess.com's accuracies on real games.
 *
 *   pnpm --filter @chess/web calibrate <username> [more usernames…] [--games 40] [--depth 18]
 *
 * 1. Downloads each player's games that were reviewed on chess.com (only those
 *    carry chess.com's accuracy numbers). With several players, games come from
 *    all of them, so the result fits a mix of levels rather than one person.
 * 2. Evaluates every position with the SAME Stockfish build the browser uses,
 *    at the same depth as the review, so the fitted numbers apply directly.
 *    Results are cached in .calibration-cache.json, so a rerun (or a run
 *    stopped half-way) doesn't repeat engine work.
 * 3. Tries three versions of the formula with more or less freedom and scores
 *    each on data it wasn't tuned on: with one player, 5-fold cross-validation
 *    over games; with several, leave-one-player-out (fit on everyone else,
 *    test on the player left out), which is what the site really faces.
 *    Keeps the simplest version that isn't clearly worse.
 * 4. Breaks the unseen-games error down by time control, rating band and
 *    player, and flags any group that one setting doesn't fit.
 * 5. Writes the constants to src/engine/accuracy-params.json, which the web app reads.
 *
 * Options:
 *   --games N        reviewed games to use PER PLAYER (default 40; more = better fit, slower)
 *   --time-class T   only these time controls, comma-separated: bullet,blitz,rapid,daily
 *   --depth D        engine depth; must match the review depth you'll use (default 18 = "Standard")
 *   --from-file F    use games from a JSON file instead of chess.com:
 *                    [{ "id": "...", "pgn": "...", "accuracies": { "white": 81.2, "black": 74.0 },
 *                       "timeClass": "blitz", "ratings": { "white": 1250, "black": 1300 }, "player": "name" }]
 *                    (the last three fields are optional)
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
  type GroupError,
  MODELS,
  type ModelName,
  type Sample,
  TIME_CLASS_NAMES,
  bias,
  breakdown,
  chooseModel,
  crossValidate,
  crossValidateByPlayer,
  fit,
  foldOf,
  mae,
  outOfFold,
  pickGames,
  ratingBand,
  standsOut,
} from '../src/engine/calibrate';
import { LICHESS_PARAMS } from '../src/engine/review';
import { terminalEvalCp } from '../src/engine/terminal';
import { parseBestMove, parseInfo, scoreToCp, toWhitePov } from '../src/engine/uci';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '..');
const PARAMS_FILE = path.join(WEB_ROOT, 'src/engine/accuracy-params.json');
const CACHE_FILE = path.join(WEB_ROOT, '.calibration-cache.json');
// chess.com asks API clients to identify themselves; no personal data needed.
const USER_AGENT = 'YourShatranjAccuracyCalibration/1.0 (open-source chess project)';

// ------------------------------------------------------------------ args

function parseArgs(argv: string[]) {
  const opts = {
    usernames: [] as string[],
    games: 40,
    depth: 18,
    fromFile: '',
    dryRun: false,
    timeClasses: [] as string[],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--games') opts.games = Number(argv[++i]);
    else if (a === '--depth') opts.depth = Number(argv[++i]);
    else if (a === '--from-file') opts.fromFile = argv[++i] ?? '';
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--time-class') {
      opts.timeClasses = (argv[++i] ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    } else if (!a.startsWith('--')) opts.usernames.push(a);
  }
  if (opts.usernames.length === 0 && !opts.fromFile) {
    console.error('Usage: pnpm --filter @chess/web calibrate <username> [more usernames…] [--games 40] [--depth 18]');
    process.exit(1);
  }
  for (const u of opts.usernames) {
    if (!/^[A-Za-z0-9_-]{2,25}$/.test(u)) {
      console.error(`"${u}" does not look like a chess.com username.`);
      process.exit(1);
    }
  }
  const bad = opts.timeClasses.filter((t) => !(TIME_CLASS_NAMES as readonly string[]).includes(t));
  if (bad.length > 0) throw new Error(`Unknown --time-class ${bad.join(', ')}; use ${TIME_CLASS_NAMES.join(', ')}`);
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

async function downloadGames(
  username: string,
  wanted: number,
  timeClasses: string[],
  alreadyPicked: Set<string>,
): Promise<CalibrationGame[]> {
  const user = username.toLowerCase();
  const { archives } = (await getJson(`https://api.chess.com/pub/player/${user}/games/archives`)) as { archives: string[] };
  const picked: CalibrationGame[] = [];
  for (const monthUrl of [...archives].reverse()) {
    if (picked.length >= wanted) break;
    process.stdout.write(`  ${monthUrl.slice(-7)}: `);
    // A game between two of the requested players is used once, for whoever came first.
    const found = pickGames(await getJson(monthUrl), 20, timeClasses).filter((g) => !alreadyPicked.has(g.id));
    console.log(`${found.length} reviewed games${timeClasses.length ? ` (${timeClasses.join('/')})` : ''}`);
    for (const g of found) picked.push({ ...g, player: user });
  }
  if (picked.length === 0) {
    console.log(
      `  No reviewed games found for ${username}. chess.com only publishes accuracy for games that have been ` +
        'reviewed (Game Review); this player is skipped.',
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
const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
// Same split the single-player cross-validation uses.
const foldIndex = (id: string) => foldOf(id, 5);

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const games: CalibrationGame[] = [];
  if (opts.fromFile) {
    console.log(`Reading games from ${opts.fromFile}`);
    const all = JSON.parse(readFileSync(opts.fromFile, 'utf8')) as CalibrationGame[];
    const filtered = opts.timeClasses.length ? all.filter((g) => g.timeClass && opts.timeClasses.includes(g.timeClass)) : all;
    // Keep up to --games per player (games without a player count as one group).
    const perPlayer = new Map<string, number>();
    for (const g of filtered) {
      const key = g.player ?? 'file';
      if ((perPlayer.get(key) ?? 0) >= opts.games) continue;
      perPlayer.set(key, (perPlayer.get(key) ?? 0) + 1);
      games.push(g);
    }
  } else {
    const seen = new Set<string>();
    for (const username of opts.usernames) {
      console.log(`Fetching reviewed games for ${username}…`);
      const got = await downloadGames(username, opts.games, opts.timeClasses, seen);
      for (const g of got) seen.add(g.id);
      if (got.length > 0 && got.length < opts.games) console.log(`  Only ${got.length} usable games for ${username}.`);
      games.push(...got);
    }
  }
  if (games.length === 0) throw new Error('No usable games found.');

  const evals = await evaluateGames(games, opts.depth);
  const samples: (Sample & { id: string })[] = [];
  for (const g of games) {
    const e = evals.get(g.id);
    if (!e) continue;
    const common = { id: g.id, evals: e, player: g.player, timeClass: g.timeClass };
    samples.push({ ...common, side: 'w', target: g.accuracies.white, rating: g.ratings?.white });
    samples.push({ ...common, side: 'b', target: g.accuracies.black, rating: g.ratings?.black });
  }
  if (samples.length < 10) throw new Error('Too few usable games to fit (need at least 5).');

  const players = [...new Set(samples.map((s) => s.player ?? 'unknown'))];
  const byPlayer = players.length >= 2;
  console.log(`\n${samples.length / 2} games from ${players.length} player${players.length === 1 ? '' : 's'}.`);
  const before = { all: mae(samples, LICHESS_PARAMS), bias: bias(samples, LICHESS_PARAMS) };
  console.log(`Lichess formula: off by ${fmt(before.all)} points on average (ours ${before.bias >= 0 ? 'higher' : 'lower'} by ${fmt(Math.abs(before.bias))}).`);

  // Compare how much freedom the formula gets, scoring each option only on
  // data it was NOT tuned on, then keep the simplest option that isn't clearly
  // worse. With several players, a whole player is left out at a time.
  const validation = byPlayer ? 'leave-one-player-out' : '5-fold cross-validation';
  console.log(`\nError on unseen ${byPlayer ? 'players' : 'games'} (${validation}):`);
  const cv = {} as Record<ModelName, number>;
  for (const model of MODELS) {
    cv[model] = byPlayer ? crossValidateByPlayer(samples, model) : crossValidate(samples, model, 5);
    console.log(`  ${model.padEnd(14)} ${fmt(cv[model])} points`);
  }
  const chosen = chooseModel(cv);
  const unseen: number | null = Number.isFinite(cv[chosen]) ? cv[chosen] : null;
  console.log(`Using "${chosen}": simplest option within 0.3 points of the best.`);

  // Where does the remaining error come from? Same unseen predictions, split up.
  const preds = outOfFold(samples, chosen, byPlayer ? (s) => s.player ?? 'unknown' : (s) => String(foldIndex(s.id)));
  const flagged: string[] = [];
  const table = (title: string, rows: GroupError[]) => {
    if (rows.length < 2 && rows[0]?.group === 'unknown') return;
    console.log(`\n${title}`);
    console.log(`  ${'group'.padEnd(14)} ${'sides'.padStart(6)} ${'error'.padStart(7)} ${'bias'.padStart(7)}`);
    for (const r of rows) {
      const flag = standsOut(r) ? '  <- stands out' : '';
      if (flag) flagged.push(`${title.toLowerCase()} "${r.group}"`);
      console.log(`  ${r.group.padEnd(14)} ${String(r.count).padStart(6)} ${fmt(r.mae).padStart(7)} ${signed(r.bias).padStart(7)}${flag}`);
    }
  };
  table('By time control', breakdown(preds, (s) => s.timeClass));
  const bandOrder = ['under 1000', '1000–1499', '1500–1999', '2000+', 'unknown'];
  table(
    'By rating',
    breakdown(preds, (s) => ratingBand(s.rating)).sort((a, b) => bandOrder.indexOf(a.group) - bandOrder.indexOf(b.group)),
  );
  if (byPlayer) table('By player', breakdown(preds, (s) => s.player));
  if (flagged.length > 0) {
    console.log(
      `\nOne setting doesn't fit everyone: ${flagged.join(', ')} ${flagged.length === 1 ? 'is' : 'are'} off by 2+ points ` +
        'in one direction. Separate settings for that group would likely help. Look at time control first: ' +
        'if players play different mixes of bullet, blitz and rapid, a time-control difference also shows up per player.',
    );
  } else {
    console.log('\nNo group stands out: one setting fits all of them.');
  }

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
    validation,
    players,
    timeClasses: opts.timeClasses.length ? opts.timeClasses : 'all',
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
