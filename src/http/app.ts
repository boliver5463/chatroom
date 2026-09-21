import express, { type Express } from 'express';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { AppContext } from '../context.js';
import { errorHandler, notFoundHandler } from './middleware.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { mentionRoutes, messageRoutes, roomRoutes } from './routes/rooms.js';

// Works from both src/ (tsx) and dist/ (compiled): both are one directory deep.
const PUBLIC_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../public');

export function createApp(ctx: AppContext): Express {
  const app = express();

  // Behind a reverse proxy this makes req.ip the real client address, which
  // the login throttle keys on.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Bodies are small (a message is capped at 4 KB); a low cap is free defence.
  app.use(express.json({ limit: '64kb' }));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.floor(process.uptime()), ...ctx.hub.stats });
  });

  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/rooms', roomRoutes(ctx));
  app.use('/api/messages', messageRoutes(ctx));
  app.use('/api/mentions', mentionRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));

  // Canonical page URLs. The redirects are registered before express.static so
  // the underlying .html paths never resolve directly and each page has exactly
  // one address.
  app.get('/index.html', (_req, res) => res.redirect(301, '/'));
  app.get('/admin.html', (_req, res) => res.redirect(301, '/admin'));

  app.get('/', (_req, res) => res.sendFile(resolve(PUBLIC_DIR, 'index.html')));
  app.get('/admin', (_req, res) => res.sendFile(resolve(PUBLIC_DIR, 'admin.html')));

  // Any other asset dropped into public/. `index: false` leaves "/" to the
  // explicit route above rather than having static serve index.html again.
  app.use(express.static(PUBLIC_DIR, { index: false }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
