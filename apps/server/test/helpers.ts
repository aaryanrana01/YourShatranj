import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@chess/shared';
import { loadConfig } from '../src/config.js';

export const ORIGIN = 'http://localhost:5173';

export function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    PORT: '4999',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/chess_test',
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6380',
    JWT_ACCESS_SECRET: 'test-access-secret-that-is-long-enough-123',
    REFRESH_TOKEN_SECRET: 'test-refresh-secret-that-is-long-enough-456',
    APP_ORIGIN: ORIGIN,
    LOG_LEVEL: 'silent',
  });
}

export const uniqueName = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 9)}`;

export type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

export async function http(base: string, path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

export async function register(base: string, username: string, password = 'correct horse battery') {
  const res = await http(base, '/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) });
  if (res.status !== 200) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = res.headers.get('set-cookie') ?? '';
  return { token: res.body.accessToken as string, user: res.body.user as { id: string; username: string }, cookie };
}

export function connect(base: string, token?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket: Client = connectClient(base, {
      transports: ['websocket'],
      auth: token ? { token } : {},
      reconnection: false,
      forceNew: true,
    });
    socket.on('srv:ping', (_t, ack) => ack());
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

export function waitFor<E extends keyof ServerToClientEvents>(
  socket: Client,
  event: E,
  predicate: (...args: Parameters<ServerToClientEvents[E]>) => boolean = () => true,
  timeoutMs = 5000,
): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener as never);
      reject(new Error(`timed out waiting for ${String(event)}`));
    }, timeoutMs);
    const listener = (...args: Parameters<ServerToClientEvents[E]>) => {
      if (!predicate(...args)) return;
      clearTimeout(timer);
      socket.off(event, listener as never);
      resolve(args[0]);
    };
    socket.on(event, listener as never);
  });
}
