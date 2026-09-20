import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // config.ts reads these at import time, so they must be set before the
    // suite loads rather than inside a beforeEach.
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-not-used-anywhere-else',
      DATABASE_PATH: ':memory:',
      // Small, deterministic buckets so the limiter tests are fast.
      RATE_LIMIT_BURST: '3',
      RATE_LIMIT_REFILL_PER_SEC: '1',
      CONNECTION_OPS_BURST: '100',
      CONNECTION_OPS_REFILL_PER_SEC: '50',
      // The suite registers dozens of users from 127.0.0.1; the production
      // brute-force default (10 then 1 per 6s) would correctly block it.
      AUTH_RATE_LIMIT_BURST: '10000',
      AUTH_RATE_LIMIT_REFILL_PER_SEC: '1000',
    },
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
