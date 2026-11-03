import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChessComGame } from '@chess/shared';
import { ApiError, api } from '../lib/api';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Fetches a chess.com player's public games (through our server, which
 * caches them and identifies itself to chess.com) and opens one for review.
 */
export function Import() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [months, setMonths] = useState<{ year: number; month: number }[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [games, setGames] = useState<ChessComGame[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const user = username.trim().toLowerCase();

  async function findArchives(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setGames(null);
    setSelected(null);
    try {
      const list = await api<{ year: number; month: number }[]>(`/api/import/chesscom/${encodeURIComponent(user)}/archives`);
      setMonths(list);
      if (list[0]) await openMonth(list[0].year, list[0].month);
      else setError('That player has no games yet.');
    } catch (err) {
      setMonths(null);
      setError(err instanceof ApiError ? err.message : 'Could not reach chess.com');
    } finally {
      setLoading(false);
    }
  }

  async function openMonth(year: number, month: number) {
    const key = `${year}-${month}`;
    setSelected(key);
    setGames(null);
    try {
      setGames(await api<ChessComGame[]>(`/api/import/chesscom/${encodeURIComponent(user)}/${year}/${month}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load games');
    }
  }

  function result(g: ChessComGame) {
    const me = g.white.username.toLowerCase() === user ? g.white : g.black.username.toLowerCase() === user ? g.black : null;
    if (!me) return '';
    if (me.result === 'win') return 'Won';
    if (['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'].includes(me.result)) return 'Draw';
    return 'Lost';
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-white">Import from chess.com</h1>
        <p className="mt-1 text-ink-400">Enter any chess.com username. Only public games are available.</p>
      </div>
      <form onSubmit={findArchives} className="flex max-w-md gap-2">
        <input
          className="input"
          placeholder="chess.com username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          pattern="[A-Za-z0-9_\-]{2,25}"
          required
        />
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? 'Loading…' : 'Find games'}
        </button>
      </form>
      {error ? <p className="text-sm text-blunder">{error}</p> : null}

      {months && months.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-[12rem_1fr]">
          <div className="card max-h-[32rem] overflow-y-auto p-2">
            {months.map((m) => {
              const key = `${m.year}-${m.month}`;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => openMonth(m.year, m.month)}
                  className={`block w-full rounded px-3 py-2 text-left text-sm ${selected === key ? 'bg-ink-700 text-white' : 'hover:bg-ink-800'}`}
                >
                  {MONTHS[m.month - 1]} {m.year}
                </button>
              );
            })}
          </div>
          <div className="card divide-y divide-ink-700">
            {games === null ? <p className="p-4 text-sm text-ink-400">Loading games…</p> : null}
            {games?.length === 0 ? <p className="p-4 text-sm text-ink-400">No games this month.</p> : null}
            {games?.map((g) => {
              const standard = g.rules === 'chess';
              const r = result(g);
              return (
                <div key={g.url} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate text-ink-200">
                      {g.white.username} ({g.white.rating}) vs {g.black.username} ({g.black.rating})
                    </p>
                    <p className="text-xs text-ink-400">
                      {g.timeClass} · {new Date(g.endTime * 1000).toLocaleDateString()}
                      {r ? ` · ${r}` : ''}
                      {g.accuracies
                        ? ` · chess.com accuracy ${g.accuracies.white.toFixed(1)} / ${g.accuracies.black.toFixed(1)}`
                        : ''}
                      {!standard ? ` · ${g.rules} (not supported)` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn-primary shrink-0 px-3 py-1.5"
                    disabled={!standard}
                    onClick={() =>
                      navigate('/analysis', { state: { pgn: g.pgn, autoReview: true, chessComAccuracy: g.accuracies } })
                    }
                  >
                    Review
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
