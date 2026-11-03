import { type InfoLine, type Score, parseBestMove, parseInfo, toWhitePov } from './uci';

export interface SearchOptions {
  depth?: number;
  movetime?: number;
  multipv?: number;
}

export interface SearchResult {
  bestMove: string | null;
  /** Last reported score, from White's point of view (null if cancelled before any output). */
  score: Score | null;
  depth: number;
  pv: string[];
  cancelled: boolean;
}

interface Pending {
  sideToMove: 'w' | 'b';
  onInfo?: (info: InfoLine & { whiteScore: Score }) => void;
  resolve: (r: SearchResult) => void;
  reject: (e: Error) => void;
  last: InfoLine | null;
  cancelled: boolean;
}

/** If Stockfish goes silent this long mid-search, assume it crashed and restart it. */
const WATCHDOG_MS = 15_000;

/**
 * Stockfish (WebAssembly) running in a Web Worker, so heavy thinking never
 * blocks the page. Talks UCI: we send text commands, it streams text back.
 * Only one search runs at a time; starting a new one stops the old one.
 */
export class Engine {
  private worker!: Worker;
  private ready!: Promise<void>;
  private current: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private lineHandlers = new Set<(line: string) => void>();
  private options: Record<string, string> = {};
  private disposed = false;

  constructor(private readonly url = '/stockfish/stockfish.js') {
    this.boot();
  }

  private boot() {
    this.worker = new Worker(this.url);
    this.worker.onmessage = (e: MessageEvent) => this.onLine(String(e.data));
    this.worker.onerror = () => this.restart('worker error');
    this.ready = (async () => {
      await this.waitFor('uci', (l) => l === 'uciok');
      for (const [name, value] of Object.entries(this.options)) this.send(`setoption name ${name} value ${value}`);
      await this.waitFor('isready', (l) => l === 'readyok');
    })();
  }

  private restart(reason: string) {
    if (this.disposed) return;
    console.warn(`Restarting Stockfish: ${reason}`);
    this.worker.terminate();
    if (this.current) {
      this.current.reject(new Error(`Engine restarted (${reason})`));
      this.current = null;
    }
    this.boot();
  }

  private send(cmd: string) {
    this.worker.postMessage(cmd);
  }

  private waitFor(cmd: string, match: (line: string) => boolean): Promise<void> {
    return new Promise((resolve) => {
      const handler = (line: string) => {
        if (match(line)) {
          this.lineHandlers.delete(handler);
          resolve();
        }
      };
      this.lineHandlers.add(handler);
      this.send(cmd);
    });
  }

  private kickWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = this.current ? setTimeout(() => this.restart('no output'), WATCHDOG_MS) : null;
  }

  private onLine(line: string) {
    for (const h of [...this.lineHandlers]) h(line);
    const job = this.current;
    if (!job) return;
    this.kickWatchdog();
    const info = parseInfo(line);
    if (info) {
      if (info.multipv === 1) job.last = info;
      if (!job.cancelled) job.onInfo?.({ ...info, whiteScore: toWhitePov(info.score, job.sideToMove) });
      return;
    }
    const best = parseBestMove(line);
    if (best === undefined) return;
    this.current = null;
    this.kickWatchdog();
    job.resolve({
      bestMove: best,
      score: job.last ? toWhitePov(job.last.score, job.sideToMove) : null,
      depth: job.last?.depth ?? 0,
      pv: job.last?.pv ?? [],
      cancelled: job.cancelled,
    });
  }

  setOption(name: string, value: string | number) {
    this.options[name] = String(value);
    this.send(`setoption name ${name} value ${value}`);
  }

  /** Stops the running search (its promise resolves with cancelled: true). */
  stop() {
    if (this.current) {
      this.current.cancelled = true;
      this.send('stop');
    }
  }

  /**
   * Searches a position. Calls are queued: a new search waits until the
   * previous one has fully stopped, so their outputs never mix.
   */
  /**
   * `signal` cancels THIS search only (whether it is running or still
   * queued). Callers use it instead of the global stop(), so one part of the
   * page can never cut short a search another part started.
   */
  search(fen: string, opts: SearchOptions, onInfo?: Pending['onInfo'], signal?: AbortSignal): Promise<SearchResult> {
    const cancelledResult: SearchResult = { bestMove: null, score: null, depth: 0, pv: [], cancelled: true };
    const run = this.queue.then(async () => {
      await this.ready;
      if (signal?.aborted) return cancelledResult; // cancelled while waiting its turn
      return new Promise<SearchResult>((resolve, reject) => {
        const sideToMove = fen.split(' ')[1] === 'b' ? 'b' : 'w';
        const job: Pending = { sideToMove, onInfo, resolve, reject, last: null, cancelled: false };
        this.current = job;
        signal?.addEventListener(
          'abort',
          () => {
            if (this.current === job && !job.cancelled) {
              job.cancelled = true;
              this.send('stop');
            }
          },
          { once: true },
        );
        this.send(`setoption name MultiPV value ${opts.multipv ?? 1}`);
        this.send(`position fen ${fen}`);
        const limits = [opts.depth ? `depth ${opts.depth}` : '', opts.movetime ? `movetime ${opts.movetime}` : '']
          .filter(Boolean)
          .join(' ');
        this.send(`go ${limits || 'infinite'}`);
        this.kickWatchdog();
      });
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Fully resets the engine between games: waits for any running search to
   * finish, clears its memory (hash table), and waits until it confirms.
   * Without this, leftovers from earlier searches nudge the numbers, so the
   * same game could review slightly differently each time.
   */
  async newGame() {
    this.stop();
    await this.queue;
    await this.ready;
    this.send('ucinewgame');
    await this.waitFor('isready', (l) => l === 'readyok');
  }

  dispose() {
    this.disposed = true;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.worker.terminate();
  }
}
