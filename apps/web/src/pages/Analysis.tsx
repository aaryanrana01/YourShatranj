import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Chess, type Square } from 'chess.js';
import { Board } from '../components/Board';
import { EvalBar, evalLabel } from '../components/EvalBar';
import { EvalGraph } from '../components/EvalGraph';
import { ChevronIcon, FlipIcon } from '../components/Icons';
import { KingLogo } from '../components/Logo';
import { MOVE_CLASSES, MOVE_STYLE, MoveBadge } from '../components/MoveBadge';
import { MoveList } from '../components/MoveList';
import { PlayerBar } from '../components/PlayerBar';
import { TimeChart, timeSpent } from '../components/TimeChart';
import { PARAMS_INFO, type ReviewSummary, reviewGame } from '../engine/review';
import { terminalEvalCp } from '../engine/terminal';
import { Engine } from '../engine/stockfish';
import { type Score, formatScore, scoreToCp } from '../engine/uci';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';

const START = new Chess().fen();

interface LineMove {
  uci: string;
  san: string;
  fen: string;
  /** The PGN comment after this move, e.g. "[%clk 0:04:58.3]" (chess.com and YourShatranj games have one). */
  comment?: string;
}

interface LiveEval {
  score: Score;
  depth: number;
  pvSan: string[];
  best: string | null;
  fen: string;
}

// Below depth 18, evaluations can still jump by most of a pawn as the engine
// looks deeper; from 18 on they settle, so that is the standard review depth.
const DEPTHS = { fast: 14, standard: 18, deep: 22 } as const;
type ReviewDepth = keyof typeof DEPTHS;

function pvToSan(fen: string, pv: string[], max = 10): string[] {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const uci of pv.slice(0, max)) {
    try {
      out.push(chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san);
    } catch {
      break;
    }
  }
  return out;
}

function arrowFor(uci: string | null | undefined, color: string): [Square, Square, string] | null {
  if (!uci || uci.length < 4) return null;
  return [uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, color];
}

const terminalEval = terminalEvalCp;

/**
 * Analysis board + full game review. Everything here runs in the browser:
 * Stockfish lives in a Web Worker, so there's no server cost and no limit.
 */
export function Analysis() {
  const [params] = useSearchParams();
  const location = useLocation() as {
    state?: { pgn?: string; autoReview?: boolean; chessComAccuracy?: { white: number; black: number } | null };
  };
  const chessComAccuracy = location.state?.chessComAccuracy ?? null;
  const engineRef = useRef<Engine | null>(null);
  const reviewRun = useRef(0);
  const me = useAuth((s) => s.user?.username.toLowerCase());

  const [startFen, setStartFen] = useState(START);
  const [line, setLine] = useState<LineMove[]>([]);
  const [cursor, setCursor] = useState(0);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [engineOn, setEngineOn] = useState(true);
  const [live, setLive] = useState<LiveEval | null>(null);
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [reviewEvals, setReviewEvals] = useState<number[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  // Accuracy is only comparable with chess.com at the depth it was calibrated at, so start there.
  const [depth, setDepth] = useState<ReviewDepth>(
    () => (Object.keys(DEPTHS) as ReviewDepth[]).find((k) => DEPTHS[k] === PARAMS_INFO.depth) ?? 'standard',
  );
  const [input, setInput] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pendingAutoReview, setPendingAutoReview] = useState(false);

  const fen = cursor === 0 ? startFen : line[cursor - 1]!.fen;
  const gameOverText = useMemo(() => {
    const c = new Chess(fen);
    if (c.isCheckmate()) return 'Checkmate';
    if (c.isStalemate()) return 'Stalemate';
    if (c.isDraw()) return 'Draw';
    return null;
  }, [fen]);

  // One engine per page visit; it's terminated when you leave.
  useEffect(() => {
    engineRef.current = new Engine();
    return () => {
      reviewRun.current++;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const loadPgn = useCallback((pgn: string, autoReview = false) => {
    const chess = new Chess();
    try {
      chess.loadPgn(pgn);
    } catch {
      setMessage('That PGN could not be read. Check that it is a standard chess game.');
      return false;
    }
    const hdrs = chess.getHeaders();
    const history = chess.history({ verbose: true });
    const comments = new Map(chess.getComments().map((c) => [c.fen, c.comment]));
    reviewRun.current++;
    setStartFen(history[0]?.before ?? hdrs.FEN ?? START);
    setLine(history.map((m) => ({ uci: m.lan, san: m.san, fen: m.after, comment: comments.get(m.after) })));
    setCursor(0);
    setHeaders(hdrs);
    // Show your own games from your side of the board.
    setOrientation(me && hdrs.Black?.toLowerCase() === me ? 'black' : 'white');
    setReview(null);
    setReviewEvals([]);
    setProgress(null);
    setMessage(null);
    setPendingAutoReview(autoReview);
    return true;
  }, [me]);

  function loadFen(text: string) {
    try {
      const chess = new Chess(text.trim());
      reviewRun.current++;
      setStartFen(chess.fen());
      setLine([]);
      setCursor(0);
      setHeaders({});
      setReview(null);
      setReviewEvals([]);
      setMessage(null);
    } catch {
      setMessage('That FEN is not a valid position.');
    }
  }

  // Load from ?game=<id> (our own games) or from navigation state (chess.com import, bot).
  useEffect(() => {
    const gameId = params.get('game');
    if (gameId) {
      api<{ pgn: string }>(`/api/games/${encodeURIComponent(gameId)}/pgn`)
        .then((r) => loadPgn(r.pgn, true))
        .catch((err) => setMessage(err instanceof ApiError ? err.message : 'Could not load that game'));
    } else if (location.state?.pgn) {
      loadPgn(location.state.pgn, location.state.autoReview ?? false);
    }
  }, [params, location.state, loadPgn]);

  // Live engine on the current position. It only ever cancels its OWN search
  // (via the AbortController), never the engine as a whole: a global stop here
  // used to cut every review search short whenever the progress bar moved.
  const reviewing = progress !== null;
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !engineOn || reviewing || gameOverText) return;
    const controller = new AbortController();
    setLive(null);
    void engine
      .search(
        fen,
        { depth: 22 },
        (info) => {
          if (info.depth < 6) return;
          setLive({ score: info.whiteScore, depth: info.depth, pvSan: pvToSan(fen, info.pv), best: info.pv[0] ?? null, fen });
        },
        controller.signal,
      )
      .catch(() => {});
    return () => controller.abort();
  }, [fen, engineOn, reviewing, gameOverText]);

  const runReview = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || line.length === 0) return;
    const run = ++reviewRun.current;
    // newGame() stops the live search, waits for it to end, and clears the engine's memory.
    await engine.newGame();
    const fens = [startFen, ...line.map((m) => m.fen)];
    const evals: number[] = [];
    const bests: (string | null)[] = [];
    setProgress(0);
    try {
      for (let i = 0; i < fens.length; i++) {
        if (reviewRun.current !== run) return; // a new game was loaded meanwhile
        const f = fens[i]!;
        const terminal = terminalEval(f);
        if (terminal !== null) {
          evals.push(terminal);
          bests.push(null);
        } else {
          const res = await engine.search(f, { depth: DEPTHS[depth] });
          evals.push(res.score ? scoreToCp(res.score) : (evals[i - 1] ?? 0));
          bests.push(res.bestMove);
        }
        setProgress((i + 1) / fens.length);
      }
      if (reviewRun.current !== run) return;
      setReviewEvals(evals);
      setReview(reviewGame(line, evals, bests));
    } catch {
      setMessage('The engine stopped unexpectedly. Try the review again.');
    } finally {
      if (reviewRun.current === run) setProgress(null);
    }
  }, [line, startFen, depth]);

  useEffect(() => {
    if (pendingAutoReview && line.length > 0) {
      setPendingAutoReview(false);
      void runReview();
    }
  }, [pendingAutoReview, line, runReview]);

  // Keyboard: ← → to step, Home/End to jump.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.key === 'ArrowLeft') setCursor((c) => Math.max(0, c - 1));
      else if (e.key === 'ArrowRight') setCursor((c) => Math.min(line.length, c + 1));
      else if (e.key === 'Home') setCursor(0);
      else if (e.key === 'End') setCursor(line.length);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [line.length]);

  function onBoardMove(uci: string): boolean {
    const chess = new Chess(fen);
    let san: string;
    try {
      san = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
    } catch {
      return false;
    }
    if (line[cursor]?.uci === uci) {
      setCursor(cursor + 1);
      return true;
    }
    // A different move starts a new line from here (the old continuation is dropped).
    setLine([...line.slice(0, cursor), { uci, san, fen: chess.fen() }]);
    setCursor(cursor + 1);
    if (review) {
      setReview(null);
      setReviewEvals([]);
    }
    return true;
  }

  const current = cursor > 0 ? review?.moves[cursor - 1] : undefined;
  const arrows = [
    engineOn && live && live.fen === fen ? arrowFor(live.best, 'rgba(246,190,60,0.9)') : null,
    current && current.classification !== 'best' ? arrowFor(current.bestMove, 'rgba(111,163,63,0.95)') : null,
  ].filter((a): a is [Square, Square, string] => a !== null);
  const last = cursor > 0 ? line[cursor - 1] : undefined;
  const terminal = terminalEval(fen);
  const liveHere = live && live.fen === fen ? live : null;
  const barCp = terminal ?? reviewEvals[cursor] ?? (liveHere ? scoreToCp(liveHere.score) : null);
  const barLabel = terminal === null && reviewEvals[cursor] === undefined && liveHere ? formatScore(liveHere.score) : undefined;

  const names = { w: headers.White ?? 'White', b: headers.Black ?? 'Black' };
  const elos = { w: headers.WhiteElo, b: headers.BlackElo };
  const top: 'w' | 'b' = orientation === 'white' ? 'b' : 'w';
  const bottom: 'w' | 'b' = top === 'w' ? 'b' : 'w';
  const classes = review?.moves.map((m) => m.classification);
  const spent = useMemo(() => timeSpent(line.map((m) => m.comment), headers.TimeControl), [line, headers.TimeControl]);
  const keyMoments = (review?.moves ?? []).filter((m) => m.classification === 'blunder' || m.classification === 'mistake');
  const bestSan =
    current && current.classification !== 'best' && current.bestMove
      ? pvToSan(cursor > 1 ? line[cursor - 2]!.fen : startFen, [current.bestMove])[0]
      : null;

  const reset = () => {
    reviewRun.current++;
    setStartFen(START);
    setLine([]);
    setCursor(0);
    setHeaders({});
    setReview(null);
    setReviewEvals([]);
  };

  const accuracyChip = (side: 'w' | 'b') =>
    review ? (
      <span
        className={`tabular rounded-md px-2.5 py-1 text-lg font-extrabold ${side === 'w' ? 'bg-ink text-felt' : 'bg-[#1d1c1a] text-ink ring-1 ring-line'}`}
        title="Accuracy"
      >
        {review.accuracy[side].toFixed(1)}
      </span>
    ) : null;

  // What the coach bubble says right now.
  const coach = (() => {
    if (progress !== null) return <>Reviewing the game… {Math.round(progress * 100)}%</>;
    if (!review) {
      return line.length > 0 ? (
        <>Start a review to rate every move and find where the game turned.</>
      ) : (
        <>Paste a game under “Load a game”, or play moves on the board to explore.</>
      );
    }
    if (current) {
      const s = MOVE_STYLE[current.classification];
      return (
        <>
          <span className="font-extrabold">{current.san}</span> is{' '}
          <span className="font-extrabold" style={{ color: s.color }}>
            {s.label.toLowerCase()}
          </span>
          {bestSan ? (
            <>
              . Best was <span className="font-extrabold text-go-hi">{bestSan}</span>.
            </>
          ) : (
            '.'
          )}
        </>
      );
    }
    return <>Step through the moves with the arrows, or jump to a key moment.</>;
  })();

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[280px_minmax(0,1fr)_360px]">
      {/* ---------- Left: key moments, time, engine, load ---------- */}
      <aside className="order-3 space-y-4 lg:col-span-2 xl:order-1 xl:col-span-1">
        <section className="panel p-4">
          <h2 className="mb-2 font-extrabold">Key moments</h2>
          {!review ? (
            <p className="text-sm text-muted">After a review, the moves that changed the game are listed here.</p>
          ) : keyMoments.length === 0 ? (
            <p className="text-sm text-muted">No mistakes or blunders in this game.</p>
          ) : (
            <ul className="-mx-1 max-h-64 space-y-0.5 overflow-y-auto">
              {keyMoments.map((m) => (
                <li key={m.ply}>
                  <button
                    type="button"
                    onClick={() => setCursor(m.ply + 1)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-raised ${
                      cursor === m.ply + 1 ? 'bg-raised' : ''
                    }`}
                  >
                    <MoveBadge kind={m.classification} size="sm" />
                    <span className="tabular w-10 text-faint">
                      {Math.floor(m.ply / 2) + 1}
                      {m.ply % 2 === 0 ? '.' : '…'}
                    </span>
                    <span className="font-bold">{m.san}</span>
                    <span className="tabular ml-auto text-xs text-muted">
                      {evalLabel(m.cpBefore)} → {evalLabel(m.cpAfter)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {spent.some((s) => s !== null) ? (
          <section className="panel p-4">
            <h2 className="mb-2 font-extrabold">Time per move</h2>
            <TimeChart spent={spent} current={cursor} onSelect={setCursor} />
          </section>
        ) : null}

        <section className="panel p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-extrabold">Engine</h2>
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" className="accent-[var(--color-go)]" checked={engineOn} onChange={(e) => setEngineOn(e.target.checked)} />
              Stockfish 17.1
            </label>
          </div>
          {gameOverText ? (
            <p className="mt-2 text-sm text-muted">{gameOverText}</p>
          ) : engineOn && liveHere ? (
            <div className="mt-2">
              <div className="flex items-baseline gap-2">
                <span className="tabular text-xl font-extrabold">{formatScore(liveHere.score)}</span>
                <span className="text-xs text-muted">depth {liveHere.depth}</span>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-muted">{liveHere.pvSan.join(' ')}</p>
            </div>
          ) : engineOn ? (
            <p className="mt-2 text-sm text-muted">{progress !== null ? 'Paused while reviewing.' : 'Thinking…'}</p>
          ) : null}
        </section>

        <section className="panel space-y-2 p-4">
          <h2 className="font-extrabold">Load a game</h2>
          <textarea
            className="input h-24 text-xs"
            placeholder="Paste a PGN or a FEN"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={100_000}
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-quiet px-3 py-1.5 text-sm" onClick={() => loadPgn(input)} disabled={!input.trim()}>
              Load PGN
            </button>
            <button type="button" className="btn-quiet px-3 py-1.5 text-sm" onClick={() => loadFen(input)} disabled={!input.trim()}>
              Load FEN
            </button>
            <button type="button" className="btn-quiet ml-auto px-3 py-1.5 text-sm" onClick={reset}>
              Clear
            </button>
          </div>
          {message ? <p className="text-sm text-blunder">{message}</p> : null}
        </section>
      </aside>

      {/* ---------- Centre: board ---------- */}
      <section className="order-1 xl:order-2" aria-label="Board">
        <div className="mx-auto w-full max-w-[min(100%,calc(100vh-150px))]">
          <div className="pl-9">
            <PlayerBar name={names[top]} rating={elos[top]} color={top} fen={fen} right={accuracyChip(top)} />
          </div>
          <div className="flex gap-2">
            <EvalBar cp={barCp} label={barLabel} orientation={orientation} />
            <div className="min-w-0 flex-1">
              <Board
                id="analysis"
                fen={fen}
                orientation={orientation}
                movable="both"
                onMove={onBoardMove}
                lastMove={last ? { from: last.uci.slice(0, 2), to: last.uci.slice(2, 4) } : null}
                arrows={arrows}
                badge={
                  current && last && current.classification !== 'good'
                    ? { square: last.uci.slice(2, 4), node: <MoveBadge kind={current.classification} /> }
                    : null
                }
              />
            </div>
          </div>
          <div className="pl-9">
            <PlayerBar name={names[bottom]} rating={elos[bottom]} color={bottom} fen={fen} right={accuracyChip(bottom)} />
          </div>
        </div>
      </section>

      {/* ---------- Right: game review ---------- */}
      <aside className="order-2 xl:order-3">
        <section className="panel flex flex-col gap-4 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-extrabold">Game review</h2>
            <select
              className="input w-auto py-1 text-sm"
              value={depth}
              onChange={(e) => setDepth(e.target.value as ReviewDepth)}
              aria-label="Review depth"
            >
              <option value="fast">Fast (depth 14)</option>
              <option value="standard">Standard (depth 18)</option>
              <option value="deep">Deep (depth 22)</option>
            </select>
          </div>

          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-go text-white">
              <KingLogo className="h-9 w-9" />
            </span>
            <p className="relative min-h-11 flex-1 rounded-xl bg-ink px-3.5 py-2.5 text-[15px] leading-snug text-felt" aria-live="polite">
              {coach}
            </p>
          </div>

          {progress !== null ? (
            <div className="h-2 overflow-hidden rounded-full bg-raised">
              <div className="h-full bg-go transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          ) : null}

          {review ? (
            <>
              <EvalGraph evalsCp={reviewEvals} current={cursor} onSelect={setCursor} classes={classes ?? []} />

              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="w-[38%]" />
                    <th className="truncate pb-2 text-center font-bold">{names.w}</th>
                    <th className="w-9" />
                    <th className="truncate pb-2 text-center font-bold">{names.b}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="py-1.5 font-bold">Accuracy</td>
                    <td className="text-center">
                      <span className="tabular inline-block rounded-md bg-ink px-2.5 py-1 text-lg font-extrabold text-felt">
                        {review.accuracy.w.toFixed(1)}
                      </span>
                    </td>
                    <td />
                    <td className="text-center">
                      <span className="tabular inline-block rounded-md bg-[#1d1c1a] px-2.5 py-1 text-lg font-extrabold ring-1 ring-line">
                        {review.accuracy.b.toFixed(1)}
                      </span>
                    </td>
                  </tr>
                  {chessComAccuracy ? (
                    <tr className="text-muted">
                      <td className="py-1">chess.com</td>
                      <td className="tabular text-center">{chessComAccuracy.white.toFixed(1)}</td>
                      <td />
                      <td className="tabular text-center">{chessComAccuracy.black.toFixed(1)}</td>
                    </tr>
                  ) : null}
                  <tr>
                    <td colSpan={4} className="pt-2">
                      <div className="border-t border-line" />
                    </td>
                  </tr>
                  {MOVE_CLASSES.map((c) => (
                    <tr key={c}>
                      <td className="py-1.5 font-semibold">{MOVE_STYLE[c].label}</td>
                      <td className="tabular text-center text-base font-extrabold" style={{ color: MOVE_STYLE[c].color }}>
                        {review.counts.w[c]}
                      </td>
                      <td className="text-center">
                        <MoveBadge kind={c} />
                      </td>
                      <td className="tabular text-center text-base font-extrabold" style={{ color: MOVE_STYLE[c].color }}>
                        {review.counts.b[c]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}

          <button type="button" className="btn-go py-3.5 text-lg" disabled={line.length === 0 || progress !== null} onClick={runReview}>
            {progress !== null ? 'Reviewing…' : review ? 'Review again' : 'Start review'}
          </button>

          <div className="rounded-lg bg-felt/60 py-1">
            <MoveList moves={line} current={cursor} onSelect={setCursor} classes={classes} maxHeight="max-h-60" />
          </div>

          <div className="grid grid-cols-5 gap-1.5">
            <button type="button" className="btn-quiet px-0" onClick={() => setCursor(0)} aria-label="First move">
              <ChevronIcon dir="first" className="h-5 w-5" />
            </button>
            <button type="button" className="btn-quiet px-0" onClick={() => setCursor(Math.max(0, cursor - 1))} aria-label="Previous move">
              <ChevronIcon dir="left" className="h-5 w-5" />
            </button>
            <button type="button" className="btn-quiet px-0" onClick={() => setCursor(Math.min(line.length, cursor + 1))} aria-label="Next move">
              <ChevronIcon dir="right" className="h-5 w-5" />
            </button>
            <button type="button" className="btn-quiet px-0" onClick={() => setCursor(line.length)} aria-label="Last move">
              <ChevronIcon dir="last" className="h-5 w-5" />
            </button>
            <button
              type="button"
              className="btn-quiet px-0"
              onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')}
              aria-label="Flip board"
            >
              <FlipIcon className="h-5 w-5" />
            </button>
          </div>

          {review ? (
            <p className="text-xs leading-relaxed text-faint">
              {PARAMS_INFO.source === 'lichess-default'
                ? 'Accuracy uses Lichess’s formula, which runs higher than chess.com’s.'
                : `Accuracy calibrated to chess.com on ${PARAMS_INFO.games} games, at depth ${PARAMS_INFO.depth}.`}
              {PARAMS_INFO.depth !== null && PARAMS_INFO.depth !== DEPTHS[depth]
                ? ` This review ran at depth ${DEPTHS[depth]}, so numbers are less comparable.`
                : ''}
            </p>
          ) : null}
        </section>
      </aside>
    </div>
  );
}
