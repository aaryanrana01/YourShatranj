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
    <div className="space-y-5">
      <section className="panel flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold">Import from chess.com</h1>
          <p className="mt-1 text-muted">Enter any chess.com username to review their public games here.</p>
        </div>
        <form onSubmit={findArchives} className="flex w-full max-w-md gap-2">
          <input
            className="input"
            placeholder="chess.com username"
            aria-label="chess.com username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            pattern="[A-Za-z0-9_\-]{2,25}"
            required
          />
          <button type="submit" className="btn-go shrink-0" disabled={loading}>
            {loading ? 'Loading…' : 'Find games'}
          </button>
        </form>
      </section>
      {error ? <p className="text-sm text-blunder">{error}</p> : null}

      {months && months.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-[11rem_1fr]">
          <nav className="panel flex gap-1 overflow-x-auto p-2 md:max-h-[36rem] md:flex-col md:overflow-y-auto" aria-label="Months">
            {months.map((m) => {
              const key = `${m.year}-${m.month}`;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => openMonth(m.year, m.month)}
                  className={`shrink-0 rounded-md px-3 py-2 text-left text-sm font-semibold ${
                    selected === key ? 'bg-raised text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink'
                  }`}
                >
                  {MONTHS[m.month - 1]} {m.year}
                </button>
              );
            })}
          </nav>

          <section className="panel overflow-hidden">
            {games === null ? <p className="p-4 text-sm text-muted">Loading games…</p> : null}
            {games?.length === 0 ? <p className="p-4 text-sm text-muted">No games this month.</p> : null}
            {games && games.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead className="text-left text-muted">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2.5 font-semibold">Players</th>
                      <th className="px-2 py-2.5 font-semibold">Result</th>
                      <th className="px-2 py-2.5 font-semibold">Accuracy</th>
                      <th className="px-2 py-2.5 font-semibold">Type</th>
                      <th className="px-2 py-2.5 font-semibold">Date</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {games.map((g) => {
                      const standard = g.rules === 'chess';
                      const r = result(g);
                      return (
                        <tr key={g.url} className="border-b border-line/60 last:border-0 hover:bg-raised/40">
                          <td className="px-4 py-2.5">
                            {(['white', 'black'] as const).map((side) => (
                              <div key={side} className="flex items-center gap-2">
                                <span
                                  className={`h-3 w-3 shrink-0 rounded-sm ${side === 'white' ? 'bg-ink' : 'bg-[#1d1c1a] ring-1 ring-line'}`}
                                  aria-label={side}
                                />
                                <span className={g[side].username.toLowerCase() === user ? 'font-bold' : ''}>{g[side].username}</span>
                                <span className="tabular text-muted">({g[side].rating})</span>
                              </div>
                            ))}
                          </td>
                          <td className="px-2 py-2.5">
                            {r ? (
                              <span
                                className={`inline-flex h-6 items-center rounded px-1.5 text-xs font-extrabold text-white ${
                                  r === 'Won' ? 'bg-go' : r === 'Lost' ? 'bg-blunder' : 'bg-faint'
                                }`}
                              >
                                {r === 'Draw' ? '½' : r}
                              </span>
                            ) : null}
                          </td>
                          <td className="tabular px-2 py-2.5">
                            {g.accuracies ? (
                              <>
                                <div>{g.accuracies.white.toFixed(1)}</div>
                                <div className="text-muted">{g.accuracies.black.toFixed(1)}</div>
                              </>
                            ) : (
                              <span className="text-faint">–</span>
                            )}
                          </td>
                          <td className="px-2 py-2.5 text-muted">
                            {standard ? g.timeClass : `${g.rules} (not supported)`}
                          </td>
                          <td className="px-2 py-2.5 text-muted">{new Date(g.endTime * 1000).toLocaleDateString()}</td>
                          <td className="px-4 py-2.5 text-right">
                            <button
                              type="button"
                              className="btn-quiet px-3 py-1.5 text-sm"
                              disabled={!standard}
                              onClick={() =>
                                navigate('/analysis', { state: { pgn: g.pgn, autoReview: true, chessComAccuracy: g.accuracies } })
                              }
                            >
                              Review
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
