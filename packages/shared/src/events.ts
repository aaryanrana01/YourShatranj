import type {
  DrawRespondInput,
  GameRefInput,
  MoveInput,
  QueueJoinInput,
} from './schemas.js';
import type { Ack, GameMovedEvent, PublicGameState } from './types.js';
import type { TimeControlKey } from './timeControls.js';

/**
 * Typed socket events. Socket.IO uses these maps on both client and server,
 * so renaming an event or a field is a compile error on both sides.
 */
export interface ClientToServerEvents {
  'queue:join': (input: QueueJoinInput, ack: (res: Ack<{ joinedAt: number }>) => void) => void;
  'queue:leave': (ack: (res: Ack) => void) => void;
  'game:join': (input: GameRefInput, ack: (res: Ack<PublicGameState>) => void) => void;
  'game:move': (input: MoveInput, ack: (res: Ack<{ ply: number }>) => void) => void;
  'game:resign': (input: GameRefInput, ack: (res: Ack) => void) => void;
  'game:abort': (input: GameRefInput, ack: (res: Ack) => void) => void;
  'game:draw:offer': (input: GameRefInput, ack: (res: Ack) => void) => void;
  'game:draw:respond': (input: DrawRespondInput, ack: (res: Ack) => void) => void;
  'game:claim-win': (input: GameRefInput, ack: (res: Ack) => void) => void;
}

export interface ServerToClientEvents {
  'match:found': (data: { gameId: string }) => void;
  'queue:left': (data: { timeControl: TimeControlKey | null }) => void;
  'game:state': (state: PublicGameState) => void;
  'game:moved': (event: GameMovedEvent) => void;
  /** Server-initiated ping; the client acks so the server can measure round-trip time. */
  'srv:ping': (serverTime: number, ack: () => void) => void;
}
