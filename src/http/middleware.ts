import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { bearerFromHeader, verifyAccessToken } from '../auth/tokens.js';
import type { AppContext } from '../context.js';
import { AppError, type AuthPrincipal, errors } from '../types.js';

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function requireAuth(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    try {
      const token = bearerFromHeader(req.headers.authorization);
      if (!token) throw errors.unauthorized('Missing bearer token');

      const principal = verifyAccessToken(token);
      // Re-check against the database: a stateless token outlives a ban.
      const user = ctx.auth.resolvePrincipal(principal);

      req.principal = { userId: user.id, username: user.username, role: user.role };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.principal?.role !== 'admin') {
    next(errors.forbidden('Administrator access required'));
    return;
  }
  next();
};

/** Narrowing helper: requireAuth has already guaranteed this is set. */
export function principalOf(req: Request): AuthPrincipal {
  const principal = req.principal;
  if (!principal) throw errors.unauthorized();
  return principal;
}

/** Validates and replaces `req.body`, turning zod issues into a 400. */
export function validateBody<T extends z.ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue?.path.join('.');
      next(errors.invalid(issue ? `${path ? `${path}: ` : ''}${issue.message}` : 'Invalid body'));
      return;
    }
    req.body = result.data;
    next();
  };
}

/** Parses a positive-integer path parameter or rejects with a 400. */
export function intParam(req: Request, name: string): number {
  const value = Number(req.params[name]);
  if (!Number.isInteger(value) || value <= 0) {
    throw errors.invalid(`${name} must be a positive integer`);
  }
  return value;
}

export function optionalIntQuery(req: Request, name: string): number | undefined {
  const raw = req.query[name];
  if (raw === undefined || raw === '') return undefined;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw errors.invalid(`${name} must be a positive integer`);
  }
  return value;
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint' } });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  // express.json() surfaces malformed payloads as a SyntaxError with .status.
  if (err instanceof SyntaxError && 'status' in err) {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body' } });
    return;
  }

  console.error('[http] unhandled error:', err);
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
}
