import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Color, PlayerInfo } from '@chess/shared';
import { Board } from '../components/Board';
import { Clock } from '../components/Clock';
import { MoveList } from '../components/MoveList';
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
    return <p className="text-ink-400">{error ?? 'Loading game…'}</p>;
  }

  const myColor: Color | null = state.white.id === user?.id ? 'w' : state.black.id === user?.id ? 'b' : null;
  const orientation = myColor === 'b' ? 'black' : 'white';
  const bottom: Color = orientation === 'white' ? 'w' : 'b';
  const top: Color = bottom === 'w' ? 'b' : 'w';
  const playerOf = (c: Color): PlayerInfo => (c === 'w' ? state.white : state.black);
  const active = state.status === 'active';
  const last = state.moves[state.moves.length - 1];
  const opponent: Color | null = myColor ? (myColor === 'w' ? 'b' : 'w') : null;
  // Server time and our clock differ; translate server timestamps by the offset seen at sync.
  const serverOffset = state.serverNow - (Date.now() - (performance.now() - syncedAt));
  const claimAt = opponent ? state.claimWinAt[opponent] : null;
  const canClaim = claimAt !== null && now + serverOffset >= claimAt;
  const canAbort = myColor !== null && active && (myColor === 'w' ? state.ply === 0 : state.ply < 2);

  const playerRow = (c: Color) => {
    const p = playerOf(c);
    const delta = state.ratingChanges?.[c];
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/u/${p.username}`} className="truncate font-semibold text-white hover:underline">
            {p.username}
          </Link>
          <span className="ml-2 text-sm text-ink-400">
            {p.rating}
            {delta !== undefined && delta !== null ? (
              <span className={delta >= 0 ? 'text-good' : 'text-blunder'}> {signed(delta)}</span>
            ) : null}
          </span>
          {state.disconnectedAt[c] !== null && active ? (
            <span className="ml-2 rounded bg-blunder/20 px-1.5 py-0.5 text-xs text-blunder">disconnected</span>
          ) : null}
        </div>
        <Clock
          ms={state.clocks[c]}
          running={active && state.clockRunning && state.turn === c}
          syncedAt={syncedAt}
          label={p.username}
        />
      </div>
    );
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,600px)_1fr]">
      <div className="space-y-3">
        {playerRow(top)}
        <Board
          id={`game-${state.id}`}
          fen={state.fen}
          orientation={orientation}
          movable={active ? myColor : null}
          onMove={move}
          lastMove={last ? { from: last.uci.slice(0, 2), to: last.uci.slice(2, 4) } : null}
          premoves
        />
        {playerRow(bottom)}
      </div>

      <div className="space-y-4">
        {!connected ? (
          <div className="rounded-lg bg-mistake/20 px-4 py-3 text-sm text-mistake">Reconnecting… your clock keeps running.</div>
        ) : null}

        {state.abortAt && active ? (
          <div className="rounded-lg bg-ink-800 px-4 py-3 text-sm text-ink-400">
            {state.turn === myColor ? 'Make your first move' : 'Waiting for the first move'} — the game is aborted in{' '}
            {Math.max(0, Math.ceil((state.abortAt - (now + serverOffset)) / 1000))} s.
          </div>
        ) : null}

        {!active ? (
          <div className="card p-5">
            <p className="text-lg font-bold text-white">
              {describeResult(state.result, state.endReason, state.white.username, state.black.username)}
            </p>
            <p className="mt-1 text-sm text-ink-400">{state.result !== '*' ? state.result : ''}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {state.endReason !== 'aborted' ? (
                <Link to={`/analysis?game=${state.id}`} className="btn-primary">Review game</Link>
              ) : null}
              <Link to="/" className="btn-ghost">New game</Link>
            </div>
            {state.rated && state.endReason !== 'aborted' && !state.ratingChanges ? (
              <p className="mt-3 text-xs text-ink-400">Updating ratings…</p>
            ) : null}
          </div>
        ) : null}

        {active && myColor && state.drawOffer === opponent ? (
          <div className="card flex items-center justify-between gap-3 p-4">
            <span>Your opponent offers a draw.</span>
            <div className="flex gap-2">
              <button type="button" className="btn-primary" onClick={() => respondDraw(true)}>Accept</button>
              <button type="button" className="btn-ghost" onClick={() => respondDraw(false)}>Decline</button>
            </div>
          </div>
        ) : null}

        {active && myColor && canClaim ? (
          <div className="card flex items-center justify-between gap-3 p-4">
            <span>Your opponent left the game.</span>
            <button type="button" className="btn-primary" onClick={() => act('game:claim-win')}>Claim win</button>
          </div>
        ) : null}

        <div className="card p-3">
          <MoveList moves={state.moves} current={state.moves.length} />
        </div>

        {active && myColor ? (
          <div className="flex flex-wrap gap-2">
            {canAbort ? (
              <button type="button" className="btn-ghost" onClick={() => act('game:abort')}>Abort</button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={state.drawOffer === myColor || state.ply < 2}
                  onClick={() => act('game:draw:offer')}
                >
                  {state.drawOffer === myColor ? 'Draw offered' : 'Offer draw'}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    if (window.confirm('Resign this game?')) void act('game:resign');
                  }}
                >
                  Resign
                </button>
              </>
            )}
          </div>
        ) : null}

        {!myColor && active ? <p className="text-sm text-ink-400">You are watching this game.</p> : null}
        {error ? <p className="text-sm text-blunder">{error}</p> : null}
      </div>
    </div>
  );
}
