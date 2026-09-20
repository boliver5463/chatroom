import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { type AuthPrincipal, errors } from '../types.js';

interface TokenClaims {
  sub: string;
  username: string;
  role: AuthPrincipal['role'];
}

export function signAccessToken(principal: AuthPrincipal): string {
  const claims: TokenClaims = {
    sub: String(principal.userId),
    username: principal.username,
    role: principal.role,
  };
  return jwt.sign(claims, config.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: config.jwt.ttlSeconds,
  });
}

/**
 * Verifies signature + expiry and returns the principal.
 * Throws AppError('unauthorized') on any failure so callers never have to
 * distinguish "expired" from "forged" — both are just "log in again".
 */
export function verifyAccessToken(token: string): AuthPrincipal {
  let decoded: unknown;
  try {
    // Pinning algorithms prevents the `alg: none` / algorithm-confusion class
    // of attack where a client picks the verification algorithm for us.
    decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
  } catch {
    throw errors.unauthorized('Invalid or expired token');
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw errors.unauthorized('Malformed token');
  }

  const claims = decoded as Partial<TokenClaims>;
  const userId = Number(claims.sub);
  if (!Number.isInteger(userId) || !claims.username || !claims.role) {
    throw errors.unauthorized('Malformed token');
  }

  return { userId, username: claims.username, role: claims.role };
}

/** Pulls a bearer token out of an Authorization header, if present. */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return null;
  return value.trim() || null;
}
