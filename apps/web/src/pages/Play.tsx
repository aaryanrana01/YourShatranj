import { type ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import {
  type GameSummary,
  TIME_CONTROLS,
  type TimeControlKey,
  type UserPublic,
  parseTimeControl,
} from '@chess/shared';
import { AnalysisIcon, BotIcon, ImportIcon } from '../components/Icons';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { describeResult, signed } from '../lib/format';
import { getSocket } from '../lib/socket';

const LIGHT = '#edeed1';
const DARK = '#779952';
const START = new Chess().fen();
/** A middlegame from a famous game, used as the home page picture. */
const HERO_FEN = 'r1bq1rk1/pp2ppbp/2np1np1/8/3NP3/2N1BP2/PPPQ2PP/R3KB1R w KQ - 3 9';
const IMPORT_FEN = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
const BOT_FEN = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';

function MiniBoard({ fen, id }: { fen: string; id: string }) {
  return (
    <Chessboard
      id={id}
      position={fen}
      arePiecesDraggable={false}
      animationDuration={0}
      customLightSquareStyle={{ backgroundColor: LIGHT }}
      customDarkSquareStyle={{ backgroundColor: DARK }}
      customBoardStyle={{ borderRadius: '4px 4px 0 0' }}
    />
  );
}

/** A tile with a board picture on top and one action underneath. */
function Tile({ fen, id, title, note, action }: { fen: string; id: string; title: string; note: ReactNode; action: ReactNode }) {
  return (
    <div className="panel flex flex-col overflow-hidden">
      <MiniBoard fen={fen} id={id} />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <p className="font-bold text-ink">{title}</p>
          <p className="text-sm text-muted">{note}</p>
        </div>
        <div className="mt-auto">{action}</div>
      </div>
    </div>
  );
}

const GROUPS: { label: string; keys: TimeControlKey[] }[] = [
  { label: 'Bullet', keys: TIME_CONTROLS.filter((k) => parseTimeControl(k).timeClass === 'bullet') },
  { label: 'Blitz', keys: TIME_CONTROLS.filter((k) => parseTimeControl(k).timeClass === 'blitz') },
  { label: 'Rapid', keys: TIME_CONTROLS.filter((k) => parseTimeControl(k).timeClass === 'rapid') },
];

/** "10 min", "3 | 2", "15 | 10" */
function tcName(key: TimeControlKey): string {
  const tc = parseTimeControl(key);
  const min = tc.initialMs / 60_000;
  return tc.incrementMs === 0 ? `${min} min` : `${min} | ${tc.incrementMs / 1000}`;
}

function PlayCard({ activeGame }: { activeGame: string | null }) {
  const navigate = useNavigate();
  const [tc, setTc] = useState<TimeControlKey>(() => {
    try {
      const saved = localStorage.getItem('rookery:tc');
      return saved && (TIME_CONTROLS as readonly string[]).includes(saved) ? (saved as TimeControlKey) : '600+0';
    } catch {
      return '600+0';
    }
  });
  const [showAll, setShowAll] = useState(false);
  const [queued, setQueued] = useState<{ tc: TimeControlKey; since: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
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
  }, [navigate]);

  useEffect(() => {
    if (!queued) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    // Leaving the page while searching takes you out of the queue.
    return () => {
      clearInterval(t);
      void getSocket().emitWithAck('queue:leave');
    };
  }, [queued]);

  const choose = (key: TimeControlKey) => {
    setTc(key);
    setShowAll(false);
    try {
      localStorage.setItem('rookery:tc', key);
    } catch {
      /* private mode: fine, just not remembered */
    }
  };

  async function start() {
    setError(null);
    const res = await getSocket().emitWithAck('queue:join', { timeControl: tc });
    if (res.ok) setQueued({ tc, since: res.data.joinedAt });
    else setError(res.message);
  }

  async function cancel() {
    await getSocket().emitWithAck('queue:leave');
    setQueued(null);
  }

  return (
    <section className="panel flex flex-col gap-3 p-4" aria-label="Play online">
      <h2 className="text-lg font-extrabold">Play online</h2>

      {activeGame ? (
        <>
          <p className="text-sm text-muted">You have a game in progress.</p>
          <Link to={`/game/${activeGame}`} className="btn-go py-3 text-lg">
            Resume game
          </Link>
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn-quiet justify-between py-3 text-base"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            disabled={queued !== null}
          >
            <span>{tcName(tc)}</span>
            <span className="text-sm font-semibold text-muted">{parseTimeControl(tc).timeClass}</span>
          </button>

          {showAll ? (
            <div className="space-y-3 rounded-lg bg-felt/60 p-3">
              {GROUPS.map((g) => (
                <div key={g.label}>
                  <p className="mb-1.5 text-sm font-bold text-muted">{g.label}</p>
                  <div className="grid grid-cols-3 gap-2">
                    {g.keys.map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => choose(k)}
                        className={`rounded-md py-2 text-sm font-bold ${
                          k === tc ? 'bg-go text-white' : 'bg-raised text-ink hover:bg-line'
                        }`}
                      >
                        {tcName(k)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {queued ? (
            <button type="button" className="btn-quiet py-3.5 text-lg" onClick={cancel}>
              Searching {Math.floor((Date.now() - queued.since) / 1000)} s · Cancel
            </button>
          ) : (
            <button type="button" className="btn-go py-3.5 text-xl" onClick={start}>
              Play
            </button>
          )}
          {queued ? (
            <p className="text-xs text-muted">Matching you with someone near your rating. The range widens the longer you wait.</p>
          ) : null}
          {error ? <p className="text-sm text-blunder">{error}</p> : null}
        </>
      )}

      <div className="mt-1 flex flex-col gap-2 border-t border-line pt-3">
        <Link to="/bot" className="btn-quiet justify-start">
          <BotIcon className="h-5 w-5 text-muted" /> Play the bot
        </Link>
        <Link to="/analysis" className="btn-quiet justify-start">
          <AnalysisIcon className="h-5 w-5 text-muted" /> Analysis board
        </Link>
        <Link to="/import" className="btn-quiet justify-start">
          <ImportIcon className="h-5 w-5 text-muted" /> Import from chess.com
        </Link>
      </div>
    </section>
  );
}

function RecentGames({ username, games }: { username: string; games: GameSummary[] }) {
  return (
    <section className="panel overflow-hidden" aria-label="Recent games">
      <h2 className="px-4 pt-4 pb-2 text-lg font-extrabold">Recent games</h2>
      {games.length === 0 ? (
        <p className="px-4 pb-5 text-sm text-muted">Your finished games show up here, ready to review.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-semibold">Players</th>
                <th className="px-2 py-2 font-semibold">Result</th>
                <th className="px-2 py-2 font-semibold">Time</th>
                <th className="px-2 py-2 font-semibold">Rating</th>
                <th className="px-2 py-2 font-semibold">Date</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {games.slice(0, 8).map((g) => {
                const isWhite = g.white.toLowerCase() === username.toLowerCase();
                const won = (g.result === '1-0' && isWhite) || (g.result === '0-1' && !isWhite);
                const draw = g.result === '1/2-1/2';
                const delta = isWhite ? g.whiteRatingDelta : g.blackRatingDelta;
                return (
                  <tr key={g.id} className="border-b border-line/60 last:border-0 hover:bg-raised/40">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="h-3 w-3 rounded-sm bg-ink" aria-label="White" />
                        <span className={isWhite ? 'font-bold' : ''}>{g.white}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="h-3 w-3 rounded-sm bg-[#1d1c1a] ring-1 ring-line" aria-label="Black" />
                        <span className={!isWhite ? 'font-bold' : ''}>{g.black}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2.5">
                      <span
                        className={`inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-xs font-extrabold text-white ${
                          draw ? 'bg-faint' : won ? 'bg-go' : 'bg-blunder'
                        }`}
                        title={describeResult(g.result, g.endReason, g.white, g.black)}
                      >
                        {draw ? '½' : won ? 'Won' : 'Lost'}
                      </span>
                    </td>
                    <td className="tabular px-2 py-2.5 text-muted">{tcName(g.timeControl as TimeControlKey)}</td>
                    <td className={`tabular px-2 py-2.5 font-bold ${delta === null ? 'text-muted' : delta >= 0 ? 'text-go-hi' : 'text-blunder'}`}>
                      {delta === null ? '–' : signed(delta)}
                    </td>
                    <td className="px-2 py-2.5 text-muted">{g.endedAt ? new Date(g.endedAt).toLocaleDateString() : ''}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Link to={`/analysis?game=${g.id}`} className="btn-quiet px-3 py-1.5 text-sm">
                        Review
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Dashboard({ username }: { username: string }) {
  const [profile, setProfile] = useState<UserPublic | null>(null);
  const [games, setGames] = useState<GameSummary[]>([]);
  const [lastFen, setLastFen] = useState<string | null>(null);
  const [activeGame, setActiveGame] = useState<string | null>(null);

  useEffect(() => {
    void api<UserPublic>('/api/me').then(setProfile).catch(() => {});
    void api<{ gameId: string | null }>('/api/me/active-game').then((r) => setActiveGame(r.gameId)).catch(() => {});
    void api<GameSummary[]>(`/api/users/${encodeURIComponent(username)}/games`)
      .then(async (g) => {
        setGames(g);
        const last = g[0];
        if (!last) return;
        const { pgn } = await api<{ pgn: string }>(`/api/games/${last.id}/pgn`);
        const chess = new Chess();
        chess.loadPgn(pgn);
        setLastFen(chess.fen());
      })
      .catch(() => {});
  }, [username]);

  const last = games[0];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-go text-xl font-extrabold text-white">
          {username.slice(0, 1).toUpperCase()}
        </span>
        <h1 className="text-2xl font-extrabold">{username}</h1>
        {profile ? (
          <div className="flex flex-wrap gap-2 text-sm">
            {(['bullet', 'blitz', 'rapid'] as const).map((tc) => (
              <span key={tc} className="tabular rounded-md bg-panel px-2.5 py-1">
                <span className="text-muted">{tc[0]!.toUpperCase() + tc.slice(1)}</span>{' '}
                <span className="font-bold">{profile.ratings[tc].rating}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(280px,340px)_1fr_1fr_1fr]">
        <PlayCard activeGame={activeGame} />
        {last && lastFen ? (
          <Tile
            id="tile-last"
            fen={lastFen}
            title={`vs ${last.white.toLowerCase() === username.toLowerCase() ? last.black : last.white}`}
            note={describeResult(last.result, last.endReason, last.white, last.black)}
            action={
              <Link to={`/analysis?game=${last.id}`} className="btn-quiet w-full">
                Review game
              </Link>
            }
          />
        ) : (
          <Tile
            id="tile-analysis"
            fen={START}
            title="Analysis board"
            note="Explore any position with Stockfish."
            action={
              <Link to="/analysis" className="btn-quiet w-full">
                Open board
              </Link>
            }
          />
        )}
        <Tile
          id="tile-bot"
          fen={BOT_FEN}
          title="Play the bot"
          note="Eight levels, from beginner to full strength."
          action={
            <Link to="/bot" className="btn-quiet w-full">
              Play bot
            </Link>
          }
        />
        <Tile
          id="tile-import"
          fen={IMPORT_FEN}
          title="Your chess.com games"
          note="Import by username and review them here."
          action={
            <Link to="/import" className="btn-quiet w-full">
              Import games
            </Link>
          }
        />
      </div>

      <RecentGames username={username} games={games} />
    </div>
  );
}

function Welcome() {
  return (
    <div className="space-y-6">
      <section className="grid items-center gap-8 lg:grid-cols-[minmax(0,520px)_1fr]">
        <div className="mx-auto w-full max-w-[520px]">
          <MiniBoard fen={HERO_FEN} id="hero" />
        </div>
        <div className="max-w-xl">
          <h1 className="text-4xl leading-[1.1] font-extrabold tracking-tight sm:text-5xl">
            Play chess online, then review every game for free.
          </h1>
          <p className="mt-4 max-w-[60ch] text-lg text-muted">
            Rated games against people near your level. Stockfish runs in your browser, so game review has no limits.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link to="/register" className="btn-go px-8 py-3.5 text-lg">
              Sign up
            </Link>
            <Link to="/login" className="btn-quiet px-8 py-3.5 text-lg">
              Log in
            </Link>
          </div>
          <p className="mt-4 text-sm text-muted">
            No account needed for the <Link className="font-bold text-ink underline" to="/analysis">analysis board</Link>,{' '}
            <Link className="font-bold text-ink underline" to="/import">chess.com import</Link> or{' '}
            <Link className="font-bold text-ink underline" to="/bot">bots</Link>.
          </p>
        </div>
      </section>
    </div>
  );
}

/** Home: a dashboard when logged in, a welcome screen otherwise. */
export function Play() {
  const { status, user } = useAuth();
  if (status === 'loading') return null;
  if (status !== 'authed' || !user) return <Welcome />;
  return <Dashboard username={user.username} />;
}
