import { pino } from 'pino';

/**
 * Structured JSON logs. `redact` strips secrets even if someone logs a whole
 * request object by accident, so passwords and tokens never reach log storage.
 */
export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    redact: {
      paths: [
        'password',
        '*.password',
        'token',
        '*.token',
        'accessToken',
        '*.accessToken',
        'req.headers.authorization',
        'req.headers.cookie',
      ],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
