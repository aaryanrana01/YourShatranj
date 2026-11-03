import type { ComponentType } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { closeSocket } from '../lib/socket';
import { AnalysisIcon, BotIcon, ImportIcon, LogoutIcon, PlayIcon, RookIcon, UserIcon } from './Icons';

const NAV: { to: string; label: string; Icon: ComponentType<{ className?: string }> }[] = [
  { to: '/', label: 'Play', Icon: PlayIcon },
  { to: '/analysis', label: 'Analysis', Icon: AnalysisIcon },
  { to: '/import', label: 'Import', Icon: ImportIcon },
  { to: '/bot', label: 'Bots', Icon: BotIcon },
];

/**
 * Left sidebar on desktop (icons + labels), a slim icon rail on tablets, and a
 * top bar on phones. The main column holds each page.
 */
export function Layout() {
  const { user, status, logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = async () => {
    closeSocket();
    await logout();
    navigate('/');
  };

  const navItem = (to: string, label: string, Icon: ComponentType<{ className?: string }>) => (
    <NavLink
      key={to}
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] font-bold transition-colors ${
          isActive ? 'bg-raised text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink'
        }`
      }
      title={label}
    >
      <Icon className="h-6 w-6 shrink-0" />
      <span className="md:hidden lg:inline">{label}</span>
    </NavLink>
  );

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      {/* Sidebar (tablet and up) */}
      <aside className="sticky top-0 hidden h-screen shrink-0 flex-col bg-[#211f1d] px-2 py-4 md:flex md:w-[68px] lg:w-[180px]">
        <Link to="/" className="mb-6 flex items-center gap-2 px-2.5" aria-label="Rookery home">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-go text-white">
            <RookIcon className="h-6 w-6" />
          </span>
          <span className="text-xl font-extrabold tracking-tight md:hidden lg:inline">Rookery</span>
        </Link>
        <nav className="flex flex-col gap-1" aria-label="Main">
          {NAV.map((n) => navItem(n.to, n.label, n.Icon))}
        </nav>
        <div className="mt-auto flex flex-col gap-1">
          {status === 'authed' && user ? (
            <>
              {navItem(`/u/${user.username}`, user.username, UserIcon)}
              <button
                type="button"
                onClick={onLogout}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] font-bold text-muted hover:bg-raised/60 hover:text-ink"
                title="Log out"
              >
                <LogoutIcon className="h-6 w-6 shrink-0" />
                <span className="md:hidden lg:inline">Log out</span>
              </button>
            </>
          ) : status === 'guest' ? (
            <div className="flex flex-col gap-2 px-1 md:hidden lg:flex">
              <Link to="/register" className="btn-go w-full">
                Sign up
              </Link>
              <Link to="/login" className="btn-quiet w-full">
                Log in
              </Link>
            </div>
          ) : null}
          {status === 'guest' ? (
            <Link to="/login" className="hidden justify-center rounded-lg p-2.5 text-muted hover:text-ink md:flex lg:hidden" title="Log in">
              <UserIcon className="h-6 w-6" />
            </Link>
          ) : null}
        </div>
      </aside>

      {/* Top bar (phones) */}
      <header className="sticky top-0 z-20 flex items-center gap-1 bg-[#211f1d] px-3 py-2 md:hidden">
        <Link to="/" className="mr-2 flex items-center gap-2" aria-label="Rookery home">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-go text-white">
            <RookIcon className="h-5 w-5" />
          </span>
        </Link>
        {NAV.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            title={label}
            className={({ isActive }) => `rounded-lg p-2 ${isActive ? 'bg-raised text-ink' : 'text-muted'}`}
          >
            <Icon className="h-6 w-6" />
          </NavLink>
        ))}
        <div className="ml-auto">
          {status === 'authed' && user ? (
            <Link to={`/u/${user.username}`} className="rounded-lg p-2 text-muted" title={user.username}>
              <UserIcon className="h-6 w-6" />
            </Link>
          ) : status === 'guest' ? (
            <Link to="/login" className="btn-go px-3 py-1.5 text-sm">
              Log in
            </Link>
          ) : null}
        </div>
      </header>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 lg:px-8 lg:py-7">
          <Outlet />
        </main>
        <footer className="px-4 py-4 text-center text-xs text-faint">
          Analysis by Stockfish (GPLv3,{' '}
          <a className="underline hover:text-muted" href="https://github.com/official-stockfish/Stockfish" rel="noreferrer" target="_blank">
            source
          </a>
          ), running in your browser.
        </footer>
      </div>
    </div>
  );
}
