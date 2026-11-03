import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { GameError } from '../game/errors.js';
import type { Logger } from '../logger.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Validates input against a schema; a mismatch becomes a 400 with the first problem. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new HttpError(400, 'VALIDATION', first ? first.message : 'Invalid input');
  }
  return result.data;
}

const GAME_ERROR_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  NOT_YOUR_GAME: 403,
  CONFLICT: 409,
  ALREADY_IN_GAME: 409,
};

/**
 * Last stop for every error. Users get a short, generic message; the full
 * error (stack trace included) goes only to the server log.
 */
export function errorHandler(log: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof GameError) {
      res.status(GAME_ERROR_STATUS[err.code] ?? 400).json({ error: err.code, message: err.message });
      return;
    }
    // Malformed JSON bodies and oversized payloads from express.json().
    const status = (err as { status?: number }).status;
    if (status === 400 || status === 413) {
      res.status(status).json({ error: 'VALIDATION', message: status === 413 ? 'Request too large' : 'Malformed request' });
      return;
    }
    log.error({ err, path: req.path }, 'unhandled request error');
    res.status(500).json({ error: 'INTERNAL', message: 'Something went wrong' });
  };
}
