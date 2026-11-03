import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Board } from '../components/Board';
import { MoveList } from '../components/MoveList';
import { PlayerBar } from '../components/PlayerBar';
import { useAuth } from '../lib/auth';
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
  const user = useAuth((st) => st.user);
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

  const botColor: 'w' | 'b' = color === 'w' ? 'b' : 'w';
  const botBar = <PlayerBar name={`Stockfish · level ${level + 1}`} color={botColor} fen={fen} note={LEVELS[level]!.name.split(' · ')[1]} right={thinking ? <span className="text-sm text-muted">Thinking…</span> : null} />;
  const youBar = <PlayerBar name={user?.username ?? 'You'} color={color} fen={fen} />;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section aria-label="Board">
        <div className="mx-auto w-full max-w-[min(100%,calc(100vh-150px))]">
          {botBar}
          <Board
            id="bot"
            fen={fen}
            orientation={color === 'w' ? 'white' : 'black'}
            movable={started && !over ? color : null}
            onMove={playerMove}
            lastMove={last ? { from: last.from, to: last.to } : null}
            premoves
          />
          {youBar}
        </div>
      </section>

      <aside className="panel flex flex-col gap-4 p-4 lg:self-start">
        <h1 className="text-lg font-extrabold">Play the bot</h1>

        <fieldset disabled={started && !over} className="space-y-2">
          <legend className="mb-2 text-sm font-bold text-muted">Strength</legend>
          <div className="grid grid-cols-4 gap-2">
            {LEVELS.map((l, i) => (
              <button
                key={l.name}
                type="button"
                onClick={() => setLevel(i)}
                title={l.name.split(' · ')[1]}
                className={`tabular rounded-md py-2 font-extrabold disabled:opacity-50 ${
                  level === i ? 'bg-go text-white' : 'bg-raised text-ink hover:bg-line'
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <p className="text-sm text-muted">{LEVELS[level]!.name.split(' · ')[1]}</p>
        </fieldset>

        <fieldset disabled={started && !over}>
          <legend className="mb-2 text-sm font-bold text-muted">You play</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['w', 'b'] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`rounded-md py-2 font-bold disabled:opacity-50 ${
                  color === c ? 'bg-go text-white' : 'bg-raised text-ink hover:bg-line'
                }`}
              >
                {c === 'w' ? 'White' : 'Black'}
              </button>
            ))}
          </div>
        </fieldset>

        <button type="button" className="btn-go py-3.5 text-lg" onClick={newGame}>
          {started ? 'New game' : 'Start'}
        </button>

        {result ? (
          <div className="rounded-xl bg-raised p-4 text-center">
            <p className="text-lg font-extrabold">{result}</p>
            <button
              type="button"
              className="btn-quiet mt-3 w-full"
              onClick={() => navigate('/analysis', { state: { pgn: game.pgn(), autoReview: true } })}
            >
              Review this game
            </button>
          </div>
        ) : null}

        <div className="rounded-lg bg-felt/60 py-1">
          <MoveList moves={history} current={history.length} maxHeight="max-h-[40vh]" />
        </div>
      </aside>
    </div>
  );
}
