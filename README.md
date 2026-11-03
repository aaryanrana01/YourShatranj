# YourShatranj — real-time chess with free, unlimited analysis

Play rated real-time games against other people, then review every game with
Stockfish as often as you like. Import games from chess.com by username and
review those too. Analysis runs in the browser (WebAssembly), so it costs the
server nothing.

**Features**

- Accounts, ratings per time class (bullet / blitz / rapid) using Glicko-2
- Matchmaking by rating, with the rating window widening the longer you wait
- Live games over WebSockets: clocks with increment, lag compensation,
  premoves, click-to-move or drag, draw offers, resign, abort, claim win when
  the opponent disconnects, spectators
- Analysis board: eval bar, best line, best-move arrow, PGN/FEN import
- Game review: every move labelled (best → blunder), accuracy per player,
  evaluation graph, "best was …" for each mistake
- chess.com import (public games, cached)
- Play the bot, eight strength levels
- Game history and profiles

---

## How it works

```
Browser ── React app ──────────── Stockfish (WASM, Web Worker) → analysis, review, bot
   │
   │  REST (auth, history, import)  +  WebSocket (Socket.IO: moves, clocks, matchmaking)
   ▼
Game server (Node + Express + Socket.IO)        ← the referee: every rule is enforced here
   ├── Redis     live games, matchmaking queue, rate limits
   ├── Postgres  users, ratings, finished games and moves
   └── chess.com public API (server-side, cached)
```

**The server is the referee.** The browser only *asks* to move. The server
checks the move with chess.js, runs the clocks on its own time, and decides
how the game ends. That one rule blocks most cheating and most "the game broke
mid-way" bugs, because there is exactly one source of truth.

**Every change to a live game is compare-and-set.** The game lives in Redis
with a version number. A Lua script (atomic inside Redis) saves a change only
if nobody changed the game since it was read. If a move and a timeout, or two
resignations, arrive at the same instant, exactly one wins
(`apps/server/src/game/store.ts`, `service.ts`).

**Restarts don't end games.** Live state is in Redis, not in server memory. On
startup the server re-arms every game's timers and finishes saving any game
that ended mid-crash (`GameService.recover`). Clients reconnect automatically
and receive the full state. A test kills the server mid-game and continues it.

## Project layout

```
packages/shared/    Types, Zod schemas and socket event maps used by BOTH sides
apps/server/
  src/game/         The rules engine: clock.ts, rules.ts, glicko2.ts (pure),
                    store.ts (Redis CAS), service.ts (the referee), archive.ts (Postgres)
  src/auth/         Argon2id passwords, JWT access + rotating refresh tokens
  src/http/         REST routes and error handling
  src/socket.ts     Socket.IO: handshake auth, validation, rate limits, presence
  src/matchmaking.ts Rating-based pairing (atomic Lua script)
  src/chesscom.ts   chess.com client (serial requests, caching, validation)
  drizzle/          SQL migrations (applied automatically at startup)
  test/             Unit + integration tests against real Postgres and Redis
apps/web/
  src/engine/       Stockfish worker wrapper, UCI parser, review maths
  src/pages/        Play, Game, Analysis, Import, Bot, Profile, Auth
  src/components/   Board, Clock, EvalBar, EvalGraph, MoveList
```

## Tech stack, and why

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript everywhere | Socket messages are shared types; renaming a field is a compile error on both sides, not a mid-game crash. |
| Monorepo | pnpm workspaces | `packages/shared` holds the schemas both sides validate with, so they can't drift. |
| Frontend | React 19, Vite, Tailwind 4, react-chessboard | Familiar React; the board library handles drag, animation and promotion UI. |
| Rules | chess.js (client and server) | Legal moves, check, mate, repetition, 50-move rule, PGN/FEN. Never hand-roll these. |
| Engine | Stockfish 17.1 "lite single-threaded" WASM in a Web Worker | Runs on the user's CPU: unlimited, free. Single-threaded needs no special headers, so it works on any host. |
| Server | Node 22, Express 5, Socket.IO 4 | WebSockets with rooms, acks and reconnection built in. WebSocket-only transport, so no sticky sessions. |
| Validation | Zod | Every REST body and socket payload is checked; unknown fields are rejected. |
| Database | PostgreSQL + Drizzle ORM | Relational data; rating updates in one transaction. Drizzle is pure JS (no engine binaries), so Docker images are small and ARM servers just work. Queries are parameterised: no SQL injection. |
| Live state | Redis (ioredis) | Fast shared state for live games, the queue and rate limits; Lua scripts give atomic updates. |
| Auth | Argon2id + JWT access token + rotating refresh cookie | See Security below. |
| Logs | pino | Structured JSON logs with secrets redacted. |
| Tests | Vitest | Pure-function unit tests plus integration tests with two real socket clients. |

---

## Run it locally

You need **Node 22+**, **pnpm 10** (`npm i -g pnpm`), and Postgres + Redis
(easiest: Docker Desktop).

```bash
# 1. Install dependencies for all three packages at once
pnpm install

# 2. Start Postgres and Redis in containers (data persists in a Docker volume)
docker compose -f docker-compose.dev.yml up -d

# 3. Create the server's config from the template, then put two different
#    long random strings in JWT_ACCESS_SECRET and REFRESH_TOKEN_SECRET
cp .env.example apps/server/.env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# 4. Build the shared package once (the server and web app import its compiled output)
pnpm --filter @chess/shared build

# 5. Start the server (port 4000) and the web app (port 5173) together
pnpm dev
```

Open http://localhost:5173. To try a real game, open a second browser (or a
private window, which has separate cookies), sign up as a second user, and
pick the same time control in both.

**Why these steps:** step 2 gives you the same databases as production without
installing them; step 3 keeps secrets out of Git (`.env` is ignored); step 4
is needed because `@chess/shared` is a compiled package; step 5 runs Vite with
a proxy to the API, so the browser sees one origin, exactly like production.

The database tables are created automatically when the server starts (pending
migrations in `apps/server/drizzle/` are applied). After changing
`src/db/schema.ts`, run `pnpm --filter @chess/server db:generate` to create a
new migration file.

## Calibrate accuracy to chess.com

chess.com doesn't publish its accuracy formula, so out of the box YourShatranj
uses Lichess's, which usually comes out 10+ points higher than chess.com's.
chess.com *does* publish its accuracy for every game that has been reviewed,
so the gap can be measured and fitted away:

```bash
pnpm --filter @chess/web calibrate <your chess.com username> --games 40
```

To fit a mix of players (recommended for a public site), list several
usernames; `--games` is then per player:

```bash
pnpm --filter @chess/web calibrate player1 player2 player3 player4 --games 30
pnpm --filter @chess/web calibrate player1 player2 --time-class rapid   # only rapid games
```

Add `--dry-run` to see the report without changing the saved settings.

What it does, and why:

1. **Downloads your games that were reviewed on chess.com.** Only reviewed
   games carry chess.com's accuracy. If it finds none, open a few of your games
   on chess.com and run Game Review there first.
2. **Evaluates every position with the same Stockfish build the browser uses,
   at the same depth** (default 18 = "Standard"). Fitted constants only apply
   at the depth they were fitted at, so the review page preselects that depth
   afterwards. Takes about 30–60 s per game at depth 18; results are cached in
   `apps/web/.calibration-cache.json`, so you can stop and resume.
3. **Fits the formula's two constants** (how fast an advantage turns into
   winning chances, and how hard lost chances are punished) by searching for
   the values closest to chess.com's numbers. About a quarter of the games are
   held out of the fit and used to report the error on games it never saw:
   an honest estimate for new games.
4. **Checks where the remaining error comes from**: the unseen-games error
   split by time control, rating band and player. A group that is off by 2+
   points in one direction is flagged: that's the sign one setting doesn't
   fit everyone. With several players, testing leaves out a whole player at a
   time, because the site mostly sees people it was never tuned on.
5. **Saves them to `apps/web/src/engine/accuracy-params.json`.** Commit that
   file; restart `pnpm dev` and the review uses the new constants. Expect to
   land within a few points of chess.com, not exactly on it: their engine,
   depth and formula still differ from ours.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `REDIS_URL` | yes | Redis URL (`rediss://` for TLS, e.g. Upstash) |
| `JWT_ACCESS_SECRET` | yes | ≥ 32 chars, signs access tokens |
| `REFRESH_TOKEN_SECRET` | yes | ≥ 32 chars, different from the above; hashes refresh tokens |
| `APP_ORIGIN` | yes in prod | Exact public URL, e.g. `https://chess.example.com`. Only this origin may call the API or open sockets. |
| `PORT` | no | Default 4000 |
| `WEB_DIST` | no | Folder of the built web app; when set, the server serves it too (set in the Docker image) |
| `TRUST_PROXY` | no | Set to `1` behind Render/Koyeb/Caddy so rate limits see real client IPs |
| `REDIS_ADAPTER` | no | `true` only when running 2+ server instances |
| `CHESSCOM_CONTACT` | recommended | Your email or URL; chess.com asks API clients to identify themselves |
| `LOG_LEVEL` | no | Default `info` |

## Tests

```bash
docker compose -f docker-compose.dev.yml up -d
TEST_DATABASE_URL=postgres://chess:chess@localhost:5432/chess \
TEST_REDIS_URL=redis://localhost:6379/1 \
pnpm test
```

52 tests. Highlights:

- **Glicko-2** reproduces the worked example from Glickman's paper.
- **Full game:** two socket clients get matched, play to checkmate, ratings update, the PGN is reviewable.
- **Races:** both players resign at the same instant → one result, ratings counted once; two parallel moves → exactly one applied.
- **Clocks** (with a fake clock): flag fall on a late move, timer-driven timeout, first-move abort.
- **Restart:** server stopped mid-game, a new one starts, players reconnect and keep playing.
- **Security:** refresh-token replay kills the session, cross-site requests rejected, login rate limit, sockets without a token refused, extra payload fields rejected.

CI (`.github/workflows/ci.yml`) runs typecheck, all tests against real Postgres and Redis, the production build and a dependency audit on every push.

---

## Deploy it for free

TypeScript compiles to plain JavaScript before it runs, so it deploys
anywhere Node does. The free-tier question is about *hosting a server that
holds WebSocket connections open*, which rules out serverless platforms.

### Option A — Oracle Cloud "Always Free" VM (recommended: always on)

Oracle's Always Free tier includes up to 4 Arm cores and 24 GB RAM that don't
expire and don't sleep. Everything (app, Postgres, Redis, HTTPS) runs on the
one machine with Docker Compose.

1. **Create an Oracle Cloud account.** A card is needed for identity
   verification (a small temporary hold); Always Free resources aren't charged.
   *Why:* it's the only big free tier with an always-on server.
2. **Create a VM:** Compute → Instances → Create. Image: Ubuntu 24.04. Shape:
   Ampere `VM.Standard.A1.Flex` (2 OCPU / 12 GB is plenty). Add your SSH key.
   If you see "Out of capacity", try another availability domain or try again later.
3. **Open ports 80 and 443 in both firewalls.**
   *Why:* Oracle has a cloud firewall *and* the Ubuntu image ships with
   restrictive iptables rules; both must allow web traffic.
   - Cloud: Networking → your VCN → Security List → add ingress rules for TCP 80 and 443 from `0.0.0.0/0`.
   - VM:
     ```bash
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```
4. **Get a domain name** pointing at the VM's public IP — a free subdomain
   from DuckDNS works, or any domain you own.
   *Why:* HTTPS certificates are issued for names, not raw IPs.
5. **Install Docker:** `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`, then log out and back in.
6. **Configure:**
   ```bash
   git clone <your repo> yourshatranj && cd yourshatranj
   cp .env.example .env
   nano .env   # set DOMAIN, the two JWT/refresh secrets, POSTGRES_PASSWORD, CHESSCOM_CONTACT
   ```
7. **Start:** `docker compose up -d --build`. Caddy fetches a Let's Encrypt
   certificate automatically. Check `https://<your-domain>/api/health` returns `{"ok":true}`.
8. **Update later:** `git pull && docker compose up -d --build`. The server
   shuts down gracefully, and live games continue on the new container.
9. **Back up** the database regularly, e.g. a daily cron job:
   `docker compose exec -T db pg_dump -U chess chess | gzip > backup-$(date +%F).sql.gz`

### Option B — Render + Neon + Upstash (no server to manage, but it sleeps)

Put all three in the same region (Singapore is closest to India) so each
move's round trip between the server and Redis stays short.

1. **Neon** (Postgres): create a project, then copy the connection string with
   connection pooling **off** (keep `?sslmode=require`). Startup migrations
   need a direct connection.
2. **Upstash** (Redis): create a database with eviction **off**, copy the `rediss://` URL.
3. **Render**: New → Web Service → connect your GitHub repo → it detects the
   `Dockerfile` → instance type **Free** → environment variables:
   `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `REFRESH_TOKEN_SECRET`,
   `APP_ORIGIN=https://<name>.onrender.com` (no trailing slash),
   `TRUST_PROXY=1`, `PORT=4000`, `CHESSCOM_CONTACT`.
   Leave the health check path **empty**: `/api/health` queries Postgres and
   Redis, and Render calls it every few seconds, which would use up Upstash's
   monthly commands and keep Neon from ever going idle.
4. Optional: an UptimeRobot HTTP monitor on `https://<name>.onrender.com/`
   every 5 minutes keeps the free service awake (750 free hours a month covers one service).

Limits to know (as of Nov 2026; check the providers' pages):

- **Render free** spins a service down after 15 minutes with no HTTP request
  or WebSocket message, and waking takes about a minute. Render may also
  restart free services at any time; this app survives restarts (state is in
  Redis), but players see a short reconnect.
- **Upstash free:** 256 MB and 500K Redis commands a month. The app keeps
  idle usage near zero (no polling when nobody is queued, Redis adapter off by
  default), but heavy daily play will outgrow it.
- **Neon free:** 0.5 GB storage and 100 compute-hours a month per project;
  the database scales to zero after 5 idle minutes and wakes on the next query.

Fine for portfolios, demos and friends. For a site people rely on, use Option A.

---

## Security

| Threat | Defence | Where |
| --- | --- | --- |
| Modified client sends illegal moves, fake clocks or results | Server-authoritative rules and clocks | `game/service.ts`, `game/clock.ts` |
| Acting as another user | User id comes only from the verified token, never the payload; strict schemas reject extra fields | `socket.ts`, `packages/shared/src/schemas.ts` |
| Password theft | Argon2id (OWASP parameters); same response and timing for unknown user vs wrong password | `auth/password.ts`, `http/auth.ts` |
| Brute force | Redis rate limits per IP and per account | `security/rateLimit.ts` |
| Stolen session | 15-min access token kept in memory; refresh token in an `httpOnly`, `Secure`, `SameSite=Strict` cookie, rotated on every use; replaying an old one revokes the whole login | `auth/tokens.ts` |
| Database leak | Refresh tokens stored as HMAC hashes with a server secret | `auth/tokens.ts` |
| CSRF | SameSite=Strict cookie + Origin check on cookie endpoints; API auth uses a header | `http/auth.ts` |
| XSS | React escapes output; strict Content-Security-Policy; username character allowlist | `app.ts` |
| SQL injection | Parameterised queries (Drizzle) | everywhere |
| Message flooding | Per-socket token buckets, 4 KB max message, 20 connections per IP | `socket.ts` |
| Cross-site WebSocket | Origin allowlist on the socket handshake | `socket.ts` |
| Clickjacking, sniffing, downgrade | helmet: `frame-ancestors 'none'`, HSTS, nosniff | `app.ts` |
| Leaks via errors | Generic messages to clients; details only in logs, with secrets redacted | `http/errors.ts`, `logger.ts` |
| Engine help during live games | Our analysis refuses games still in progress | `http/api.ts` |
| Vulnerable dependencies | `pnpm audit` in CI | `.github/workflows/ci.yml` |

No site is unhackable. These layers mean one mistake doesn't expose everything.

## Honest limits and next steps

- **Cheat detection** only blocks our own analysis during live games. Someone
  can still use an engine on another device; detecting that (comparing moves
  with the engine, move-time patterns) is unsolved even for large sites.
- **No email** yet, so no password reset or email verification. Adding one
  (e.g. a transactional email provider) is a good next feature.
- **Accuracy and move labels** use the published Lichess formulas;
  chess.com's own formulas (and its "Brilliant" label) aren't public.
- **Bot games** are local and unrated by design.
- Ideas: rematch button, sounds, a live-games list for spectators, puzzles,
  opening names, game chat (with moderation), Sentry error tracking.

## Licences

Your code is yours. **Stockfish is GPLv3**: the web app serves Stockfish's
licence next to the engine (`/stockfish/COPYING.txt`) and links its source in
the footer. Keep both if you deploy publicly.
The name "YourShatranj" is this project's own; the rook logo is an original drawing. Don't use
chess.com's name, logo, pieces or design as your own.
