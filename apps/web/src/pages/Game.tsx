import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Color } from '@chess/shared';
import { Board } from '../components/Board';
import { Clock } from '../components/Clock';
import { MoveList } from '../components/MoveList';
import { PlayerBar } from '../components/PlayerBar';
import { useAuth } from '../lib/auth';
import { describeResult, signed } from '../lib/format';
import { useLiveGame } from '../lib/useLiveGame';

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function Game() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { state, syncedAt, error, connected, move, act, respondDraw } = useLiveGame(id);
  const now = useNow(state?.status === 'active');

  if (!state) {
    return <p className="text-muted">{error ?? 'Loading game…'}</p>;
  }

  const myColor: Color | null = state.white.id === user?.id ? 'w' : state.black.id === user?.id ? 'b' : null;
  const orientation = myColor === 'b' ? 'black' : 'white';
  const bottom: Color = orientation === 'white' ? 'w' : 'b';
  const top: Color = bottom === 'w' ? 'b' : 'w';
  const active = state.status === 'active';
  const last = state.moves[state.moves.length - 1];
  const opponent: Color | null = myColor ? (myColor === 'w' ? 'b' : 'w') : null;
  // Server time and our clock differ; translate server timestamps by the offset seen at sync.
  const serverOffset = state.serverNow - (Date.now() - (performance.now() - syncedAt));
  const claimAt = opponent ? state.claimWinAt[opponent] : null;
  const canClaim = claimAt !== null && now + serverOffset >= claimAt;
  const canAbort = myColor !== null && active && (myColor === 'w' ? state.ply === 0 : state.ply < 2);

  const bar = (c: Color) => {
    const p = c === 'w' ? state.white : state.black;
    const delta = state.ratingChanges?.[c];
    return (
      <PlayerBar
        name={p.username}
        rating={p.rating}
        color={c}
        linkToProfile
        note={
          state.disconnectedAt[c] !== null && active ? (
            <span className="font-bold text-blunder">Disconnected</span>
          ) : delta !== undefined && delta !== null ? (
            <span className={`font-bold ${delta >= 0 ? 'text-go-hi' : 'text-blunder'}`}>{signed(delta)} rating</span>
          ) : null
        }
        right={
          <Clock ms={state.clocks[c]} running={active && state.clockRunning && state.turn === c} syncedAt={syncedAt} label={p.username} />
        }
      />
    );
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section aria-label="Board">
        <div className="mx-auto w-full max-w-[min(100%,calc(100vh-150px))]">
          {bar(top)}
          <Board
            id={`game-${state.id}`}
            fen={state.fen}
            orientation={orientation}
            movable={active ? myColor : null}
            onMove={move}
            lastMove={last ? { from: last.uci.slice(0, 2), to: last.uci.slice(2, 4) } : null}
            premoves
          />
          {bar(bottom)}
        </div>
      </section>

      <aside className="panel flex flex-col gap-3 p-4 lg:self-start">
        {!connected ? (
          <p className="rounded-lg bg-mistake/20 px-3 py-2 text-sm font-semibold text-mistake">Reconnecting. Your clock keeps running.</p>
        ) : null}

        {active && state.abortAt ? (
          <p className="rounded-lg bg-raised px-3 py-2 text-sm text-muted">
            {state.turn === myColor ? 'Make your first move.' : 'Waiting for the first move.'} The game is cancelled in{' '}
            <span className="tabular font-bold text-ink">{Math.max(0, Math.ceil((state.abortAt - (now + serverOffset)) / 1000))} s</span>.
          </p>
        ) : null}

        {!active ? (
          <div className="rounded-xl bg-raised p-4 text-center">
            <p className="text-xl font-extrabold">
              {describeResult(state.result, state.endReason, state.white.username, state.black.username)}
            </p>
            {state.result !== '*' ? <p className="tabular mt-0.5 text-muted">{state.result}</p> : null}
            {state.rated && state.endReason !== 'aborted' && !state.ratingChanges ? (
              <p className="mt-1 text-xs text-muted">Updating ratings…</p>
            ) : null}
            <div className="mt-4 flex flex-col gap-2">
              {state.endReason !== 'aborted' ? (
                <Link to={`/analysis?game=${state.id}`} className="btn-go py-3 text-lg">
                  Game review
                </Link>
              ) : null}
              <Link to="/" className="btn-quiet">
                New game
              </Link>
            </div>
          </div>
        ) : null}

        {active && myColor && state.drawOffer === opponent ? (
          <div className="rounded-xl bg-raised p-3">
            <p className="mb-2 font-semibold">Your opponent offers a draw.</p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="btn-go" onClick={() => respondDraw(true)}>
                Accept
              </button>
              <button type="button" className="btn-quiet" onClick={() => respondDraw(false)}>
                Decline
              </button>
            </div>
          </div>
        ) : null}

        {active && myColor && canClaim ? (
          <div className="rounded-xl bg-raised p-3">
            <p className="mb-2 font-semibold">Your opponent left the game.</p>
            <button type="button" className="btn-go w-full" onClick={() => act('game:claim-win')}>
              Claim the win
            </button>
          </div>
        ) : null}

        <div className="rounded-lg bg-felt/60 py-1">
          <MoveList moves={state.moves} current={state.moves.length} maxHeight="max-h-[46vh]" />
        </div>

        {active && myColor ? (
          canAbort ? (
            <button type="button" className="btn-quiet" onClick={() => act('game:abort')}>
              Cancel game
            </button>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="btn-quiet"
                disabled={state.drawOffer === myColor || state.ply < 2}
                onClick={() => act('game:draw:offer')}
              >
                {state.drawOffer === myColor ? 'Draw offered' : 'Offer draw'}
              </button>
              <button
                type="button"
                className="btn-quiet"
                onClick={() => {
                  if (window.confirm('Resign this game?')) void act('game:resign');
                }}
              >
                Resign
              </button>
            </div>
          )
        ) : null}

        {!myColor && active ? <p className="text-sm text-muted">You're watching this game.</p> : null}
        {error ? <p className="text-sm text-blunder">{error}</p> : null}
      </aside>
    </div>
  );
}
