import { z } from 'zod';

/**
 * All configuration comes from environment variables and is validated once at
 * startup. A missing or malformed secret stops the server immediately instead
 * of failing later in the middle of a game.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  // Signs access tokens (JWTs).
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  // A separate key for hashing refresh tokens, so one leaked secret doesn't compromise both.
  REFRESH_TOKEN_SECRET: z.string().min(32, 'REFRESH_TOKEN_SECRET must be at least 32 characters'),
  // The one origin allowed to call the API and open sockets, e.g. https://chess.example.com
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  // Use the Redis adapter only when running more than one server instance.
  // A single free-tier instance doesn't need it, and skipping it saves Redis commands.
  REDIS_ADAPTER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Folder with the built web app; when set, the server also serves the frontend (same origin).
  WEB_DIST: z.string().optional(),
  // chess.com asks API clients to identify themselves with a contact in the User-Agent.
  CHESSCOM_CONTACT: z.string().default('set-CHESSCOM_CONTACT-env'),
  // Set when the app runs behind a proxy (Render, Koyeb, Caddy) so req.ip is the real client IP.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // "Continue with Google". Both or neither: without them the Google button is simply hidden.
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
}).refine((c) => Boolean(c.GOOGLE_CLIENT_ID) === Boolean(c.GOOGLE_CLIENT_SECRET), {
  message: 'Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither',
  path: ['GOOGLE_CLIENT_SECRET'],
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
