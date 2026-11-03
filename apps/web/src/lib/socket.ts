import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@chess/shared';
import { getAccessToken, refreshSession } from './api';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: GameSocket | null = null;

/**
 * One socket per tab. `auth` is a function, so every (re)connect sends the
 * current access token rather than the one we had when the page loaded.
 */
export function getSocket(): GameSocket {
  if (socket) return socket;
  const s: GameSocket = io({
    transports: ['websocket'],
    auth: (cb) => cb({ token: getAccessToken() }),
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
  });
  // Answer the server's pings so it can measure our lag for fair clocks.
  s.on('srv:ping', (_time, ack) => ack());
  s.on('connect_error', async (err) => {
    // Token expired between connects: refresh it and try again.
    if (err.message === 'UNAUTHORIZED') {
      const user = await refreshSession();
      if (user) setTimeout(() => s.connect(), 200);
    }
  });
  socket = s;
  return s;
}

export function closeSocket(): void {
  socket?.disconnect();
  socket = null;
}
