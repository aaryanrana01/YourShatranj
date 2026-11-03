import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isLogin = mode === 'login';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isLogin) await login(username, password);
      else await register(username, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="text-2xl font-extrabold text-white">{isLogin ? 'Welcome back' : 'Create your account'}</h1>
      <form onSubmit={submit} className="card mt-6 space-y-4 p-6">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-400">Username</span>
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
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-400">Password</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            minLength={isLogin ? 1 : 8}
            maxLength={128}
            required
          />
          {!isLogin ? <span className="mt-1 block text-xs text-ink-400">At least 8 characters.</span> : null}
        </label>
        {error ? <p className="text-sm text-blunder">{error}</p> : null}
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Please wait…' : isLogin ? 'Log in' : 'Sign up'}
        </button>
        <p className="text-center text-sm text-ink-400">
          {isLogin ? (
            <>New here? <Link className="text-amber-accent" to="/register">Create an account</Link></>
          ) : (
            <>Have an account? <Link className="text-amber-accent" to="/login">Log in</Link></>
          )}
        </p>
      </form>
    </div>
  );
}
