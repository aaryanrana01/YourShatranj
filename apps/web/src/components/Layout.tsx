import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { closeSocket } from '../lib/socket';

const links = [
  { to: '/', label: 'Play' },
  { to: '/analysis', label: 'Analysis' },
  { to: '/import', label: 'Import' },
  { to: '/bot', label: 'vs Bot' },
];

export function Layout() {
  const { user, status, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-ink-700 bg-ink-900/80 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center gap-1 px-4 py-3">
          <Link to="/" className="mr-4 flex items-center gap-2 text-lg font-extrabold tracking-tight text-white">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            Rookery
          </Link>
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === '/'}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-ink-700 text-white' : 'text-ink-400 hover:text-ink-200'}`
              }
            >
              {l.label}
            </NavLink>
          ))}
          <div className="ml-auto flex items-center gap-2">
            {status === 'authed' && user ? (
              <>
                <Link to={`/u/${user.username}`} className="text-sm font-semibold text-ink-200 hover:text-white">
                  {user.username}
                </Link>
                <button
                  type="button"
                  className="btn-ghost px-3 py-1.5"
                  onClick={async () => {
                    closeSocket();
                    await logout();
                    navigate('/');
                  }}
                >
                  Log out
                </button>
              </>
            ) : status === 'guest' ? (
              <>
                <Link to="/login" className="btn-ghost px-3 py-1.5">
                  Log in
                </Link>
                <Link to="/register" className="btn-primary px-3 py-1.5">
                  Sign up
                </Link>
              </>
            ) : null}
          </div>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <footer className="border-t border-ink-700 px-4 py-4 text-center text-xs text-ink-400">
        Analysis by Stockfish (GPLv3,{' '}
        <a className="underline" href="https://github.com/official-stockfish/Stockfish" rel="noreferrer" target="_blank">
          source
        </a>
        ), running in your browser.
      </footer>
    </div>
  );
}
