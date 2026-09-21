import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal .env loader. A dependency (dotenv) would do the same ~15 lines, and
 * `node --env-file` can't be set through NODE_OPTIONS, so we parse it here.
 * Real environment variables always win over the file.
 */
function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

const nodeEnv = str('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

const jwtSecret = str('JWT_SECRET', isProduction ? '' : 'dev-secret-change-me');
if (!jwtSecret) {
  throw new Error('JWT_SECRET must be set when NODE_ENV=production');
}

export const config = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === 'test',
  port: num('PORT', 3000),

  jwt: {
    secret: jwtSecret,
    ttlSeconds: num('JWT_TTL_SECONDS', 86_400),
  },

  databasePath: str('DATABASE_PATH', './data/chat.sqlite'),

  bootstrapAdmin: {
    username: str('ADMIN_USERNAME', 'admin'),
    password: str('ADMIN_PASSWORD', 'admin12345'),
  },

  /** Token bucket applied per user to `message.send`. */
  messageRateLimit: {
    burst: num('RATE_LIMIT_BURST', 5),
    refillPerSecond: num('RATE_LIMIT_REFILL_PER_SEC', 3),
  },

  /**
   * Much tighter bucket, keyed by IP, for login/register. Credential endpoints
   * are the cheapest thing to brute-force: 10 attempts up front, then one
   * every 6 seconds.
   */
  authRateLimit: {
    burst: num('AUTH_RATE_LIMIT_BURST', 10),
    refillPerSecond: num('AUTH_RATE_LIMIT_REFILL_PER_SEC', 1 / 6),
  },

  /**
   * Giphy integration. The key stays server-side and is never sent to the
   * browser — public/index.html is served to anyone, and a leaked key is
   * someone else spending your quota. With no key set, the endpoints return
   * 503 and the client hides its GIF button.
   */
  giphy: {
    apiKey: str('GIPHY_API_KEY', ''),
    /** Giphy content rating ceiling: g, pg, pg-13, or r. */
    rating: str('GIPHY_RATING', 'pg-13'),
    resultLimit: num('GIPHY_RESULT_LIMIT', 24),
    /** Upstream is a third party; never let a hung request hold a socket. */
    timeoutMs: num('GIPHY_TIMEOUT_MS', 6000),
  },

  /** Per-user bucket for GIF search, which costs an upstream API call. */
  giphyRateLimit: {
    burst: num('GIPHY_RATE_LIMIT_BURST', 15),
    refillPerSecond: num('GIPHY_RATE_LIMIT_REFILL_PER_SEC', 1),
  },

  /** Cheaper bucket applied per socket to every inbound frame. */
  connectionRateLimit: {
    burst: num('CONNECTION_OPS_BURST', 30),
    refillPerSecond: num('CONNECTION_OPS_REFILL_PER_SEC', 10),
  },

  limits: {
    messageMaxLength: 4000,
    roomNameMaxLength: 64,
    historyPageSize: 50,
    historyMaxPageSize: 200,
  },

  /** Interval for the WebSocket liveness ping sweep. */
  heartbeatIntervalMs: 30_000,
} as const;

export type Config = typeof config;
