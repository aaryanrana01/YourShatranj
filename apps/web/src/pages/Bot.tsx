import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Board } from '../components/Board';
import { MoveList } from '../components/MoveList';
import { Engine } from '../engine/stockfish';

/** Strength levels: Stockfish "Skill Level" (0–20) plus a search-depth cap for the weakest ones. */
const LEVELS = [
  { name: '1 · Beginner', skill: 0, depth: 1 },
  { name: '2 · Novice', skill: 3, depth: 2 },
  { name: '3 · Casual', skill: 6, depth: 4 },
  { name: '4 · Club', skill: 9, depth: 6 },
  { name: '5 · Strong club', skill: 12, depth: 8 },
  { name: '6 · Expert', skill: 15, depth: 12 },
  { name: '7 · Master', skill: 18, depth: 16 },
  { name: '8 · Full strength', skill: 20, depth: 20 },
];

/**
 * Casual games against Stockfish, entirely in the browser. They're unrated
 * and never touch the server, so there's nothing to cheat against.
 */
export function Bot() {
  const navigate = useNavigate();
  const engineRef = useRef<Engine | null>(null);
  const [game, setGame] = useState(() => new Chess());
  const [fen, setFen] = useState(game.fen());
  const [level, setLevel] = useState(3);
  const [color, setColor] = useState<'w' | 'b'>('w');
  const [started, setStarted] = useState(false);
  const [thinking, setThinking] = useState(false);

  useEffect(() => {
    engineRef.current = new Engine();
    return () => engineRef.current?.dispose();
  }, []);

  const over = game.isGameOver();
  const history = game.history({ verbose: true });
  const last = history[history.length - 1];

  // The bot moves whenever it's its turn.
  useEffect(() => {
    const engine = engineRef.current;
    if (!started || !engine || game.isGameOver() || game.turn() === color) return;
    let cancelled = false;
    setThinking(true);
    const lvl = LEVELS[level]!;
    engine.setOption('Skill Level', lvl.skill);
    const controller = new AbortController();
    void engine
      .search(game.fen(), { depth: lvl.depth, movetime: 1500 }, undefined, controller.signal)
      .then((res) => {
        if (cancelled || res.cancelled || !res.bestMove) return;
        const next = new Chess();
        next.loadPgn(game.pgn());
        next.move({ from: res.bestMove.slice(0, 2), to: res.bestMove.slice(2, 4), promotion: res.bestMove[4] });
        setGame(next);
        setFen(next.fen());
      })
      .catch(() => {})
      .finally(() => !cancelled && setThinking(false));
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fen, started, color, level, game]);

  function playerMove(uci: string) {
    if (thinking || game.turn() !== color) return false;
    const next = new Chess();
    next.loadPgn(game.pgn());
    try {
      next.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      return false;
    }
    setGame(next);
    setFen(next.fen());
    return true;
  }

  function newGame() {
    const fresh = new Chess();
    setGame(fresh);
    setFen(fresh.fen());
    setStarted(true);
    void engineRef.current?.newGame();
  }

  const result = game.isCheckmate()
    ? game.turn() === color
      ? 'Stockfish wins by checkmate'
      : 'You win by checkmate!'
    : game.isDraw()
      ? 'Draw'
      : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,600px)_1fr]">
      <Board
        id="bot"
        fen={fen}
        orientation={color === 'w' ? 'white' : 'black'}
        movable={started && !over ? color : null}
        onMove={playerMove}
        lastMove={last ? { from: last.from, to: last.to } : null}
        premoves
      />
      <div className="space-y-4">
        <section className="card space-y-3 p-4">
          <h1 className="text-xl font-extrabold text-white">Play against Stockfish</h1>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-400">Strength</span>
            <select className="input" value={level} onChange={(e) => setLevel(Number(e.target.value))} disabled={started && !over}>
              {LEVELS.map((l, i) => (
                <option key={l.name} value={i}>{l.name}</option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            {(['w', 'b'] as const).map((c) => (
              <button
                key={c}
                type="button"
                className={color === c ? 'btn-primary' : 'btn-ghost'}
                disabled={started && !over}
                onClick={() => setColor(c)}
              >
                Play {c === 'w' ? 'White' : 'Black'}
              </button>
            ))}
          </div>
          <button type="button" className="btn-primary w-full" onClick={newGame}>
            {started ? 'New game' : 'Start'}
          </button>
          {thinking ? <p className="text-sm text-ink-400">Stockfish is thinking…</p> : null}
          {result ? (
            <div className="rounded-lg bg-ink-800 p-3">
              <p className="font-bold text-white">{result}</p>
              <button
                type="button"
                className="btn-ghost mt-2"
                onClick={() => navigate('/analysis', { state: { pgn: game.pgn(), autoReview: true } })}
              >
                Review this game
              </button>
            </div>
          ) : null}
        </section>
        <section className="card p-3">
          <MoveList moves={history} current={history.length} />
        </section>
      </div>
    </div>
  );
}
