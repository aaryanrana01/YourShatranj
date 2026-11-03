/**
 * Small fetch wrapper.
 * The access token lives only in this module's memory (not localStorage), so
 * an injected script can't read it from storage. If a request gets 401, we
 * try once to refresh the session with the httpOnly refresh cookie.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionUser {
  id: string;
  username: string;
}

let accessToken: string | null = null;
let refreshing: Promise<SessionUser | null> | null = null;
const listeners = new Set<(user: SessionUser | null) => void>();

export const getAccessToken = () => accessToken;
export function onSessionChange(fn: (user: SessionUser | null) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setSession(token: string | null, user: SessionUser | null) {
  accessToken = token;
  for (const fn of listeners) fn(user);
}

async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  return fetch(path, { ...init, headers, credentials: 'same-origin' });
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? 'ERROR', body?.message ?? `Request failed (${res.status})`);
  return body as T;
}

/**
 * Uses the refresh cookie to get a new access token. Concurrent callers
 * share one request, so two tabs' worth of 401s don't trigger two refreshes.
 */
export function refreshSession(): Promise<SessionUser | null> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) {
        setSession(null, null);
        return null;
      }
      const body = (await res.json()) as { accessToken: string; user: SessionUser };
      setSession(body.accessToken, body.user);
      return body.user;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await raw(path, init);
  if (res.status === 401 && accessToken !== null) {
    const user = await refreshSession();
    if (user) res = await raw(path, init);
  }
  return parse<T>(res);
}

export async function login(username: string, password: string): Promise<SessionUser> {
  const body = await parse<{ accessToken: string; user: SessionUser }>(
    await raw('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  );
  setSession(body.accessToken, body.user);
  return body.user;
}

export async function register(username: string, password: string): Promise<SessionUser> {
  const body = await parse<{ accessToken: string; user: SessionUser }>(
    await raw('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  );
  setSession(body.accessToken, body.user);
  return body.user;
}

export async function logout(): Promise<void> {
  await raw('/api/auth/logout', { method: 'POST' }).catch(() => {});
  setSession(null, null);
}

// Access tokens live 15 minutes; refresh a little before they expire.
setInterval(() => {
  if (accessToken) void refreshSession();
}, 12 * 60 * 1000);
