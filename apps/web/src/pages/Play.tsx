import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TIME_CONTROLS, type TimeControlKey, parseTimeControl } from '@chess/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getSocket } from '../lib/socket';

/** Lobby: pick a time control, wait for an opponent of similar rating. */
export function Play() {
  const { status } = useAuth();
  const navigate = useNavigate();
  const [queued, setQueued] = useState<{ tc: TimeControlKey; since: number } | null>(null);
  const [activeGame, setActiveGame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (status !== 'authed') return;
    void api<{ gameId: string | null }>('/api/me/active-game').then((r) => setActiveGame(r.gameId)).catch(() => {});
    const socket = getSocket();
    if (!socket.connected) socket.connect();
    const onMatch = ({ gameId }: { gameId: string }) => navigate(`/game/${gameId}`);
    const onLeft = () => setQueued(null);
    socket.on('match:found', onMatch);
    socket.on('queue:left', onLeft);
    return () => {
      socket.off('match:found', onMatch);
      socket.off('queue:left', onLeft);
    };
  }, [status, navigate]);

  useEffect(() => {
    if (!queued) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [queued]);

  // Leaving the page while queued takes you out of the queue.
  useEffect(() => {
    return () => {
      if (queued) void getSocket().emitWithAck('queue:leave');
    };
  }, [queued]);

  async function join(tc: TimeControlKey) {
    setError(null);
    const res = await getSocket().emitWithAck('queue:join', { timeControl: tc });
    if (res.ok) setQueued({ tc, since: res.data.joinedAt });
    else setError(res.message);
  }

  async function leave() {
    await getSocket().emitWithAck('queue:leave');
    setQueued(null);
  }

  if (status === 'loading') return null;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
      <section>
        <h1 className="text-3xl font-extrabold text-white">Play chess, then learn from every game.</h1>
        <p className="mt-2 max-w-xl text-ink-400">
          Rated games against people near your level. When the game ends, review it with Stockfish as many times as you
          like. It runs in your browser, so it's free.
        </p>

        {status !== 'authed' ? (
          <div className="card mt-8 p-6">
            <p className="text-ink-200">Log in to play rated games. Analysis and the bot work without an account.</p>
            <div className="mt-4 flex gap-2">
              <Link to="/register" className="btn-primary">Create account</Link>
              <Link to="/login" className="btn-ghost">Log in</Link>
            </div>
          </div>
        ) : activeGame ? (
          <div className="card mt-8 flex items-center justify-between p-6">
            <p>You have a game in progress.</p>
            <Link to={`/game/${activeGame}`} className="btn-primary">Resume game</Link>
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-3 gap-3 sm:max-w-lg">
            {TIME_CONTROLS.map((tc) => {
              const parsed = parseTimeControl(tc);
              const isQueued = queued?.tc === tc;
              return (
                <button
                  key={tc}
                  type="button"
                  onClick={() => (isQueued ? leave() : join(tc))}
                  className={`card flex flex-col items-center gap-1 py-5 transition hover:border-amber-accent ${
                    isQueued ? 'border-amber-accent bg-amber-accent/10' : ''
                  }`}
                >
                  <span className="text-xl font-bold text-white">{parsed.label}</span>
                  <span className="text-xs uppercase tracking-wide text-ink-400">{isQueued ? 'Searching… (cancel)' : parsed.timeClass}</span>
                </button>
              );
            })}
          </div>
        )}
        {queued ? (
          <p className="mt-4 text-sm text-ink-400">
            Looking for an opponent for {Math.floor((Date.now() - queued.since) / 1000)} s. The rating range widens the
            longer you wait.
          </p>
        ) : null}
        {error ? <p className="mt-4 text-sm text-blunder">{error}</p> : null}
      </section>

      <aside className="card space-y-4 p-6 text-sm">
        <h2 className="text-base font-bold text-white">Free tools</h2>
        <Link to="/analysis" className="block rounded-lg bg-ink-800 p-4 hover:bg-ink-700">
          <span className="font-semibold text-white">Analysis board</span>
          <span className="block text-ink-400">Paste a PGN or FEN and explore with Stockfish.</span>
        </Link>
        <Link to="/import" className="block rounded-lg bg-ink-800 p-4 hover:bg-ink-700">
          <span className="font-semibold text-white">Import from chess.com</span>
          <span className="block text-ink-400">Pull your games by username and review them.</span>
        </Link>
        <Link to="/bot" className="block rounded-lg bg-ink-800 p-4 hover:bg-ink-700">
          <span className="font-semibold text-white">Play the bot</span>
          <span className="block text-ink-400">Eight levels, from beginner to full strength.</span>
        </Link>
      </aside>
    </div>
  );
}
