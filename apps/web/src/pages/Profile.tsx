import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { type GameSummary, TIME_CLASSES, type UserPublic } from '@chess/shared';
import { ApiError, api } from '../lib/api';
import { signed } from '../lib/format';

export function Profile() {
  const { username = '' } = useParams();
  const [profile, setProfile] = useState<UserPublic | null>(null);
  const [games, setGames] = useState<GameSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProfile(null);
    setGames([]);
    setError(null);
    const name = encodeURIComponent(username);
    api<UserPublic>(`/api/users/${name}`)
      .then(setProfile)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load profile'));
    api<GameSummary[]>(`/api/users/${name}/games`)
      .then((g) => {
        setGames(g);
        setHasMore(g.length === 20);
      })
      .catch(() => {});
  }, [username]);

  async function more() {
    const lastEnded = games[games.length - 1]?.endedAt;
    if (!lastEnded) return;
    const next = await api<GameSummary[]>(
      `/api/users/${encodeURIComponent(username)}/games?before=${encodeURIComponent(lastEnded)}`,
    );
    setGames([...games, ...next]);
    setHasMore(next.length === 20);
  }

  if (error) return <p className="text-blunder">{error}</p>;
  if (!profile) return <p className="text-ink-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-extrabold text-white">{profile.username}</h1>
        <p className="text-sm text-ink-400">Joined {new Date(profile.createdAt).toLocaleDateString()}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {TIME_CLASSES.map((tc) => {
          const r = profile.ratings[tc];
          return (
            <div key={tc} className="card p-4">
              <p className="text-xs uppercase tracking-wide text-ink-400">{tc}</p>
              <p className="text-3xl font-extrabold text-white">
                {r.rating}
                {r.deviation > 110 ? <span className="text-lg text-ink-400">?</span> : null}
              </p>
              <p className="text-xs text-ink-400">{r.games} games</p>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-ink-400">A “?” means the rating is still provisional (too few games to be sure).</p>

      <section className="card divide-y divide-ink-700">
        <h2 className="px-4 py-3 font-bold text-white">Recent games</h2>
        {games.length === 0 ? <p className="px-4 py-3 text-sm text-ink-400">No finished games yet.</p> : null}
        {games.map((g) => {
          const isWhite = g.white.toLowerCase() === profile.username.toLowerCase();
          const delta = isWhite ? g.whiteRatingDelta : g.blackRatingDelta;
          const won = (g.result === '1-0' && isWhite) || (g.result === '0-1' && !isWhite);
          const outcome = g.result === '1/2-1/2' ? 'Draw' : won ? 'Won' : 'Lost';
          return (
            <div key={g.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <p className="text-ink-200">
                  {g.white} vs {g.black}
                </p>
                <p className="text-xs text-ink-400">
                  {g.timeControl} · {g.endedAt ? new Date(g.endedAt).toLocaleString() : ''} · {outcome}
                  {delta !== null ? (
                    <span className={delta >= 0 ? 'text-good' : 'text-blunder'}> ({signed(delta)})</span>
                  ) : null}
                </p>
              </div>
              <Link to={`/analysis?game=${g.id}`} className="btn-ghost px-3 py-1.5">Review</Link>
            </div>
          );
        })}
        {hasMore ? (
          <button type="button" className="w-full px-4 py-3 text-sm text-amber-accent" onClick={more}>
            Load more
          </button>
        ) : null}
      </section>
    </div>
  );
}
