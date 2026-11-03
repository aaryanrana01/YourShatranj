import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Chess, type Square } from 'chess.js';
import { Board } from '../components/Board';
import { EvalBar } from '../components/EvalBar';
import { EvalGraph } from '../components/EvalGraph';
import { MoveList } from '../components/MoveList';
import { CLASS_STYLE, PARAMS_INFO, type ReviewSummary, reviewGame } from '../engine/review';
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
    reviewRun.current++;
    setStartFen(history[0]?.before ?? hdrs.FEN ?? START);
    setLine(history.map((m) => ({ uci: m.lan, san: m.san, fen: m.after })));
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
  const reviewBest = review?.moves[cursor]?.bestMove ?? null;
  const arrows = [
    engineOn && live && live.fen === fen ? arrowFor(live.best, 'rgba(242,184,75,0.85)') : null,
    current && current.classification !== 'best' ? arrowFor(current.bestMove, 'rgba(95,191,138,0.8)') : null,
  ].filter((a): a is [Square, Square, string] => a !== null);
  const last = cursor > 0 ? line[cursor - 1] : undefined;
  const terminal = terminalEval(fen);
  const liveHere = live && live.fen === fen ? live : null;
  const barCp = terminal ?? reviewEvals[cursor] ?? (liveHere ? scoreToCp(liveHere.score) : null);
  const barLabel = terminal === null && reviewEvals[cursor] === undefined && liveHere ? formatScore(liveHere.score) : undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,640px)_1fr]">
      <div>
        {headers.White ? (
          <p className="mb-2 text-sm text-ink-400">
            <span className="font-semibold text-ink-200">{headers.White}</span> ({headers.WhiteElo ?? '?'}) vs{' '}
            <span className="font-semibold text-ink-200">{headers.Black}</span> ({headers.BlackElo ?? '?'}) ·{' '}
            {headers.Result}
          </p>
        ) : null}
        <div className="flex gap-3">
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
            />
          </div>
        </div>
        <div className="mt-3 flex justify-center gap-2">
          <button type="button" className="btn-ghost" onClick={() => setCursor(0)} aria-label="Start">⏮</button>
          <button type="button" className="btn-ghost" onClick={() => setCursor(Math.max(0, cursor - 1))} aria-label="Back">◀</button>
          <button type="button" className="btn-ghost" onClick={() => setCursor(Math.min(line.length, cursor + 1))} aria-label="Forward">▶</button>
          <button type="button" className="btn-ghost" onClick={() => setCursor(line.length)} aria-label="End">⏭</button>
          <button type="button" className="btn-ghost" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')}>
            Flip
          </button>
        </div>
      </div>

      <div className="space-y-4">
        <section className="card p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-white">Stockfish 17.1</h2>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={engineOn} onChange={(e) => setEngineOn(e.target.checked)} />
              Engine
            </label>
          </div>
          {gameOverText ? (
            <p className="mt-2 text-sm text-ink-400">{gameOverText}</p>
          ) : engineOn && live && live.fen === fen ? (
            <div className="mt-2 text-sm">
              <span className="mr-2 font-mono text-lg font-bold text-white">{formatScore(live.score)}</span>
              <span className="text-ink-400">depth {live.depth}</span>
              <p className="mt-1 font-mono text-ink-400">{live.pvSan.join(' ')}</p>
            </div>
          ) : engineOn ? (
            <p className="mt-2 text-sm text-ink-400">{progress !== null ? 'Paused during review…' : 'Thinking…'}</p>
          ) : null}
        </section>

        <section className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-bold text-white">Game review</h2>
            <div className="flex items-center gap-2">
              <select className="input w-auto py-1.5" value={depth} onChange={(e) => setDepth(e.target.value as ReviewDepth)}>
                <option value="fast">Fast (depth 14)</option>
                <option value="standard">Standard (depth 18)</option>
                <option value="deep">Deep (depth 22, slow)</option>
              </select>
              <button type="button" className="btn-primary" disabled={line.length === 0 || progress !== null} onClick={runReview}>
                {review ? 'Re-run' : 'Review'}
              </button>
            </div>
          </div>
          {progress !== null ? (
            <div className="mt-3 h-2 overflow-hidden rounded bg-ink-700">
              <div className="h-full bg-amber-accent transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          ) : null}
          {review ? (
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-3 text-center">
                {(['w', 'b'] as const).map((side) => (
                  <div key={side} className="rounded-lg bg-ink-800 p-3">
                    <p className="text-xs uppercase text-ink-400">{side === 'w' ? headers.White ?? 'White' : headers.Black ?? 'Black'}</p>
                    <p className="text-2xl font-extrabold text-white">{review.accuracy[side].toFixed(1)}</p>
                    <p className="text-xs text-ink-400">accuracy</p>
                    {chessComAccuracy ? (
                      <p className="mt-1 text-xs text-ink-400">
                        chess.com:{' '}
                        <span className="font-semibold text-ink-200">
                          {(side === 'w' ? chessComAccuracy.white : chessComAccuracy.black).toFixed(1)}
                        </span>
                      </p>
                    ) : null}
                    <p className="mt-2 text-xs">
                      {(['inaccuracy', 'mistake', 'blunder'] as const).map((c) => (
                        <span key={c} className="mx-1" style={{ color: CLASS_STYLE[c].color }}>
                          {review.counts[side][c]} {CLASS_STYLE[c].symbol}
                        </span>
                      ))}
                    </p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-ink-400">
                {PARAMS_INFO.source === 'lichess-default'
                  ? 'Accuracy uses Lichess’s formula, which runs higher than chess.com’s. Calibrate it to bring them closer (see README).'
                  : `Accuracy calibrated to chess.com on ${PARAMS_INFO.games} games: on average ${(PARAMS_INFO.maeUnseen ?? PARAMS_INFO.maeAfter)?.toFixed(1)} points from chess.com at depth ${PARAMS_INFO.depth}.`}
                {PARAMS_INFO.depth !== null && PARAMS_INFO.depth !== DEPTHS[depth]
                  ? ` This review ran at depth ${DEPTHS[depth]}, so re-calibrate at that depth for comparable numbers.`
                  : ''}
              </p>
              <EvalGraph
                evalsCp={reviewEvals}
                current={cursor}
                onSelect={setCursor}
                classes={review.moves.map((m) => m.classification)}
              />
              {current ? (
                <p className="text-sm">
                  <span className="font-mono font-semibold text-white">{current.san}</span> is{' '}
                  <span style={{ color: CLASS_STYLE[current.classification].color }}>
                    {CLASS_STYLE[current.classification].label.toLowerCase()}
                  </span>
                  {current.classification !== 'best' && current.bestMove ? (
                    <>
                      . Best was{' '}
                      <span className="font-mono text-good">
                        {pvToSan(cursor > 1 ? line[cursor - 2]!.fen : startFen, [current.bestMove])[0]}
                      </span>
                      .
                    </>
                  ) : (
                    '.'
                  )}
                </p>
              ) : reviewBest ? (
                <p className="text-sm text-ink-400">Step through the moves to see each one rated.</p>
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-400">
              Rates every move, finds your mistakes and shows the better move. Free, and as often as you like.
            </p>
          )}
        </section>

        <section className="card p-3">
          <MoveList moves={line} current={cursor} onSelect={setCursor} classes={review?.moves.map((m) => m.classification)} />
        </section>

        <section className="card space-y-2 p-4">
          <h2 className="font-bold text-white">Load a game or position</h2>
          <textarea
            className="input h-24 font-mono text-xs"
            placeholder="Paste a PGN, or a FEN position"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={100_000}
          />
          <div className="flex gap-2">
            <button type="button" className="btn-primary" onClick={() => loadPgn(input)} disabled={!input.trim()}>
              Load PGN
            </button>
            <button type="button" className="btn-ghost" onClick={() => loadFen(input)} disabled={!input.trim()}>
              Load FEN
            </button>
            <button
              type="button"
              className="btn-ghost ml-auto"
              onClick={() => {
                reviewRun.current++;
                setStartFen(START);
                setLine([]);
                setCursor(0);
                setHeaders({});
                setReview(null);
                setReviewEvals([]);
              }}
            >
              Reset
            </button>
          </div>
          {message ? <p className="text-sm text-blunder">{message}</p> : null}
        </section>
      </div>
    </div>
  );
}
