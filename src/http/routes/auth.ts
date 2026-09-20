import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import type { AppContext } from '../../context.js';
import { TokenBucketRateLimiter } from '../../lib/rateLimiter.js';
import { errors } from '../../types.js';
import { asyncHandler, principalOf, requireAuth, validateBody } from '../middleware.js';

const credentialsSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export function authRoutes(ctx: AppContext): Router {
  const router = Router();

  // Credential endpoints get a much tighter, IP-keyed bucket than the in-band
  // message limiter. See config.authRateLimit for the defaults.
  const attempts = new TokenBucketRateLimiter(
    config.authRateLimit.burst,
    config.authRateLimit.refillPerSecond,
  );

  const throttle = asyncHandler(async (req, _res, next) => {
    const key = `ip:${req.ip ?? 'unknown'}`;
    const decision = attempts.consume(key);
    if (!decision.allowed) {
      throw errors.rateLimited(
        `Too many attempts. Try again in ${Math.ceil(decision.retryAfterMs / 1000)}s`,
      );
    }
    next();
  });

  router.post(
    '/register',
    throttle,
    validateBody(credentialsSchema),
    asyncHandler(async (req, res) => {
      const { username, password } = req.body as z.infer<typeof credentialsSchema>;
      const result = await ctx.auth.register(username, password);

      res.status(201).json({
        token: result.token,
        expiresInSeconds: result.expiresInSeconds,
        user: result.user,
      });
    }),
  );

  router.post(
    '/login',
    throttle,
    validateBody(credentialsSchema),
    asyncHandler(async (req, res) => {
      const { username, password } = req.body as z.infer<typeof credentialsSchema>;
      const result = await ctx.auth.login(username, password);

      // A successful login shouldn't count against the attempt budget.
      attempts.reset(`ip:${req.ip ?? 'unknown'}`);

      res.json({
        token: result.token,
        expiresInSeconds: result.expiresInSeconds,
        user: result.user,
      });
    }),
  );

  router.get(
    '/me',
    requireAuth(ctx),
    asyncHandler(async (req, res) => {
      const principal = principalOf(req);
      res.json({ user: ctx.users.findById(principal.userId) });
    }),
  );

  return router;
}
