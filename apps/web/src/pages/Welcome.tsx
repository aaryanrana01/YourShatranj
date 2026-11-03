import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, completeGoogle, googlePending } from '../lib/api';

/**
 * Shown once, after someone signs in with Google for the first time:
 * they choose the username other players will see.
 */
export function Welcome() {
  const navigate = useNavigate();
  const [state, setState] = useState<'loading' | 'ready' | 'expired'>('loading');
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void googlePending().then((p) => {
      if (!p) return setState('expired');
      setUsername(p.suggestion);
      setState('ready');
    });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await completeGoogle(username);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState('expired');
      else setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading') return <p className="pt-10 text-center text-muted">Loading…</p>;

  if (state === 'expired') {
    return (
      <div className="mx-auto max-w-sm pt-6 text-center">
        <h1 className="text-3xl font-extrabold">Sign-in expired</h1>
        <p className="mt-3 text-muted">That Google sign-in took too long or was already used.</p>
        <Link to="/login" className="btn-go mt-6 w-full py-3 text-base">
          Back to log in
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm pt-6">
      <h1 className="text-center text-3xl font-extrabold">Choose your username</h1>
      <p className="mt-2 text-center text-muted">This is the name other players see. It can’t be changed later.</p>
      <form onSubmit={submit} className="panel mt-6 space-y-4 p-6">
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Username</span>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            minLength={3}
            maxLength={20}
            pattern="[A-Za-z0-9_\-]+"
            title="Letters, digits, _ and -"
            required
            autoFocus
          />
          <span className="mt-1 block text-xs text-muted">3–20 letters, digits, _ or -.</span>
        </label>
        {error ? <p className="text-sm text-blunder">{error}</p> : null}
        <button type="submit" className="btn-go w-full py-3 text-base" disabled={busy}>
          {busy ? 'Please wait…' : 'Create account'}
        </button>
      </form>
    </div>
  );
}
