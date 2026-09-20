import { createServer } from 'node:http';
import { config } from './config.js';
import { createContext } from './context.js';
import { openDatabase } from './db/index.js';
import { slugify } from './db/rooms.js';
import { createApp } from './http/app.js';
import { CloseCode } from './ws/protocol.js';
import { attachWebSocketServer } from './ws/server.js';

async function main(): Promise<void> {
  const db = openDatabase();
  const ctx = createContext(db);

  const admin = await ctx.auth.ensureBootstrapAdmin();
  if (admin) {
    console.log(`[boot] created bootstrap admin "${admin.username}"`);
    if (config.bootstrapAdmin.password === 'admin12345' && config.isProduction) {
      console.warn('[boot] WARNING: bootstrap admin is using the default password');
    }
  }

  // Give a fresh install somewhere to talk, so the demo client is usable
  // immediately after `npm run dev`.
  if (ctx.rooms.listAll().length === 0) {
    const owner = admin ?? ctx.users.findByUsername(config.bootstrapAdmin.username);
    if (owner) {
      ctx.rooms.create({
        slug: slugify('general'),
        name: 'general',
        visibility: 'public',
        createdBy: owner.id,
      });
      console.log('[boot] created default #general room');
    }
  }

  const app = createApp(ctx);
  const httpServer = createServer(app);
  const wss = attachWebSocketServer(httpServer, ctx);

  httpServer.listen(config.port, () => {
    console.log(`[boot] http    http://localhost:${config.port}`);
    console.log(`[boot] ws      ws://localhost:${config.port}/ws?token=<jwt>`);
    console.log(`[boot] admin   http://localhost:${config.port}/admin.html`);
    console.log(`[boot] client  http://localhost:${config.port}/index.html`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received, closing`);

    // Tell clients why, so they can reconnect with backoff instead of
    // treating it as a network blip.
    for (const connection of ctx.hub.all()) {
      connection.socket.close(CloseCode.SERVER_SHUTDOWN, 'Server shutting down');
    }

    wss.close();
    httpServer.close(() => {
      db.close();
      process.exit(0);
    });

    // Don't let a stuck socket block the exit forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[boot] fatal:', err);
  process.exit(1);
});
