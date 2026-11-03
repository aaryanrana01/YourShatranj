import { StrictMode, Suspense, lazy, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { useAuth } from './lib/auth';
import { AuthPage } from './pages/Auth';
import { Play } from './pages/Play';
import { Privacy } from './pages/Privacy';
import { Welcome } from './pages/Welcome';
import './styles.css';

// Pages load on demand, so the lobby doesn't download the board and engine code up front.
const Analysis = lazy(() => import('./pages/Analysis').then((m) => ({ default: m.Analysis })));
const Bot = lazy(() => import('./pages/Bot').then((m) => ({ default: m.Bot })));
const Game = lazy(() => import('./pages/Game').then((m) => ({ default: m.Game })));
const Import = lazy(() => import('./pages/Import').then((m) => ({ default: m.Import })));
const Profile = lazy(() => import('./pages/Profile').then((m) => ({ default: m.Profile })));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return null;
  if (status === 'guest') return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function App() {
  const init = useAuth((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);

  return (
    <BrowserRouter>
      <Suspense fallback={<p className="p-6 text-muted">Loading…</p>}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Play />} />
          <Route path="login" element={<AuthPage mode="login" />} />
          <Route path="register" element={<AuthPage mode="register" />} />
          <Route path="welcome" element={<Welcome />} />
          <Route path="privacy" element={<Privacy />} />
          <Route path="game/:id" element={<RequireAuth><Game /></RequireAuth>} />
          <Route path="analysis" element={<Analysis />} />
          <Route path="import" element={<Import />} />
          <Route path="bot" element={<Bot />} />
          <Route path="u/:username" element={<Profile />} />
          <Route
            path="*"
            element={
              <div className="py-20 text-center">
                <p className="text-2xl font-bold text-ink">Page not found</p>
                <Link to="/" className="mt-4 inline-block font-bold text-go-hi hover:underline">Back to the lobby</Link>
              </div>
            }
          />
        </Route>
      </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
