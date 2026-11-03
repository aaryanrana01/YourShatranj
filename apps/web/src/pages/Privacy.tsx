import { Link } from 'react-router-dom';

const REPO = 'https://github.com/aaryanrana01/YourShatranj';

/** Plain-language privacy policy. Google's sign-in setup requires one, and players deserve to know. */
export function Privacy() {
  return (
    <article className="mx-auto max-w-2xl space-y-6 pb-10 leading-relaxed text-muted">
      <header>
        <h1 className="text-3xl font-extrabold text-ink">Privacy policy</h1>
        <p className="mt-1 text-sm">Last updated 3 November 2026</p>
      </header>

      <p>
        YourShatranj is a free, open-source chess site built as a student project. This page explains what it stores
        about you and why. The short version: only what's needed to run your account and your games. There are no ads,
        no trackers and no analytics.
      </p>

      <section className="space-y-2">
        <h2 className="text-xl font-bold text-ink">What we store</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <strong className="text-ink">Your account:</strong> your username, and either a securely hashed password
            (Argon2; we never see or keep the password itself) or, if you use “Continue with Google”, the account ID
            Google gives us.
          </li>
          <li>
            <strong className="text-ink">Your games:</strong> the moves, clock times, results and rating changes of games
            you play here. Finished games and usernames are public, like on other chess sites.
          </li>
          <li>
            <strong className="text-ink">Login sessions:</strong> a login cookie so you stay signed in. It can only be
            read by our server, and it's deleted when you log out or after 30 days without use.
          </li>
          <li>
            <strong className="text-ink">Abuse protection:</strong> your IP address is kept for at most one hour to limit
            repeated login attempts. It isn't linked to your account or kept afterwards.
          </li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-bold text-ink">Signing in with Google</h2>
        <p>
          When you choose “Continue with Google”, Google tells us your Google account ID and your first name. We use the
          ID to recognise you next time and the name only to suggest a username. We don't receive your password, and we
          don't store your email address, contacts or anything else from your Google account.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-bold text-ink">Game analysis and chess.com imports</h2>
        <p>
          Game review runs the Stockfish engine inside your own browser, so the games you analyse aren't sent to us.
          When you import games from chess.com, our server fetches that player's public games from chess.com's public
          API; nothing is saved from the import.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-bold text-ink">Who else handles data</h2>
        <p>
          The site runs on Render (server), Neon (database) and Upstash (live game data), in their Singapore regions.
          They store data on our behalf and don't use it for their own purposes. We don't sell or share your data with
          anyone else.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-bold text-ink">Your choices</h2>
        <p>
          To have your account and games deleted, or to ask anything about your data, open an issue on the project's{' '}
          <a className="font-bold text-go-hi hover:underline" href={`${REPO}/issues`} rel="noreferrer" target="_blank">
            GitHub page
          </a>
          . You can also remove YourShatranj's access to your Google account at any time from your Google account's
          security settings.
        </p>
      </section>

      <p>
        <Link to="/" className="font-bold text-go-hi hover:underline">
          Back to YourShatranj
        </Link>
      </p>
    </article>
  );
}
