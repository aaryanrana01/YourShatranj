import { useCallback, useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import type { Ack, ErrorCode, PublicGameState } from '@chess/shared';
import { getSocket } from './socket';

export interface LiveGame {
  state: PublicGameState | null;
  /** performance.now() when `state.clocks` was received; the clock display counts down from there. */
  syncedAt: number;
  error: string | null;
  connected: boolean;
  move: (uci: string) => boolean;
  act: (event: 'game:resign' | 'game:abort' | 'game:draw:offer' | 'game:claim-win') => Promise<void>;
  respondDraw: (accept: boolean) => Promise<void>;
}

const RESYNC_ERRORS: ErrorCode[] = ['STALE_PLY', 'NOT_YOUR_TURN', 'ILLEGAL_MOVE', 'CONFLICT', 'GAME_OVER'];

/**
 * Keeps one game in sync with the server.
 *  - Full state on join and on every reconnect (the server is the truth).
 *  - Small `game:moved` updates while connected; if one is missing (a gap
 *    in ply numbers), it re-asks for the full state instead of guessing.
 *  - Your own move shows instantly (optimistic), and is rolled back by a
 *    resync if the server refuses it.
 */
export function useLiveGame(gameId: string): LiveGame {
  const socket = getSocket();
  const [state, setState] = useState<PublicGameState | null>(null);
  const [syncedAt, setSyncedAt] = useState(() => performance.now());
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const stateRef = useRef<PublicGameState | null>(null);
  stateRef.current = state;

  const apply = useCallback((next: PublicGameState) => {
    setState(next);
    setSyncedAt(performance.now());
  }, []);

  const resync = useCallback(async () => {
    const res = await socket.emitWithAck('game:join', { gameId });
    if (res.ok) {
      apply(res.data);
      setError(null);
    } else {
      setError(res.message);
    }
  }, [socket, gameId, apply]);

  useEffect(() => {
    const onConnect = () => {
      setConnected(true);
      void resync();
    };
    const onDisconnect = () => setConnected(false);
    const onState = (s: PublicGameState) => {
      if (s.id === gameId) apply(s);
    };
    const onMoved = (e: Parameters<Parameters<typeof socket.on<'game:moved'>>[1]>[0]) => {
      if (e.gameId !== gameId) return;
      const cur = stateRef.current;
      if (!cur) return;
      if (e.ply === cur.ply && cur.moves[cur.ply - 1]?.uci === e.move.uci) {
        // Echo of our own optimistic move: just take the server's clocks.
        apply({ ...cur, clocks: e.clocks, clockRunning: e.clockRunning, serverNow: e.serverNow, drawOffer: e.drawOffer, abortAt: e.abortAt, fen: e.fen });
        return;
      }
      if (e.ply !== cur.ply + 1) {
        void resync(); // missed something: get the full picture
        return;
      }
      apply({
        ...cur,
        fen: e.fen,
        moves: [...cur.moves, e.move],
        ply: e.ply,
        turn: e.ply % 2 === 0 ? 'w' : 'b',
        clocks: e.clocks,
        clockRunning: e.clockRunning,
        serverNow: e.serverNow,
        drawOffer: e.drawOffer,
        abortAt: e.abortAt,
      });
    };
    // A tab that slept (browsers throttle background timers) may be stale.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && socket.connected) void resync();
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('game:state', onState);
    socket.on('game:moved', onMoved);
    document.addEventListener('visibilitychange', onVisible);
    if (socket.connected) void resync();
    else socket.connect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('game:state', onState);
      socket.off('game:moved', onMoved);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [socket, gameId, apply, resync]);

  const handleAck = useCallback(
    (res: Ack<unknown>) => {
      if (res.ok) return;
      setError(res.message);
      if (RESYNC_ERRORS.includes(res.error)) void resync();
    },
    [resync],
  );

  const move = useCallback(
    (uci: string) => {
      const cur = stateRef.current;
      if (!cur || cur.status !== 'active') return false;
      const chess = new Chess(cur.fen);
      let san: string;
      try {
        san = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
      } catch {
        return false;
      }
      const ply = cur.ply;
      // Optimistic: show the move now; the server's answer confirms or corrects it.
      apply({
        ...cur,
        fen: chess.fen(),
        moves: [...cur.moves, { uci, san, clockMs: cur.clocks[cur.turn] }],
        ply: ply + 1,
        turn: cur.turn === 'w' ? 'b' : 'w',
        clockRunning: false,
      });
      void socket.emitWithAck('game:move', { gameId, uci, ply }).then(handleAck);
      return true;
    },
    [socket, gameId, apply, handleAck],
  );

  const act = useCallback(
    async (event: 'game:resign' | 'game:abort' | 'game:draw:offer' | 'game:claim-win') => {
      handleAck(await socket.emitWithAck(event, { gameId }));
    },
    [socket, gameId, handleAck],
  );

  const respondDraw = useCallback(
    async (accept: boolean) => {
      handleAck(await socket.emitWithAck('game:draw:respond', { gameId, accept }));
    },
    [socket, gameId, handleAck],
  );

  return { state, syncedAt, error, connected, move, act, respondDraw };
}
