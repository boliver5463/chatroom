import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { bearerFromHeader, verifyAccessToken } from '../auth/tokens.js';
import { config } from '../config.js';
import type { AppContext } from '../context.js';
import { AppError, type AuthPrincipal } from '../types.js';
import { dispatch } from './handlers.js';
import type { Connection } from './hub.js';
import { CloseCode, clientFrameSchema, type ServerFrame } from './protocol.js';

/**
 * Tokens can arrive three ways, in order of preference:
 *  1. `Authorization: Bearer <token>` — correct, but browsers cannot set
 *     headers on a WebSocket handshake.
 *  2. `Sec-WebSocket-Protocol: bearer, <token>` — the usual browser workaround;
 *     keeps the token out of URLs and therefore out of access logs.
 *  3. `?token=` — simplest for curl/wscat and local development.
 */
function extractToken(req: IncomingMessage): string | null {
  const header = bearerFromHeader(req.headers.authorization);
  if (header) return header;

  const protocols = (req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const marker = protocols.findIndex((p) => p.toLowerCase() === 'bearer');
  if (marker !== -1 && protocols[marker + 1]) return protocols[marker + 1]!;

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  return url.searchParams.get('token');
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

export function attachWebSocketServer(httpServer: HttpServer, ctx: AppContext): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    // Cap a single frame well above the message limit but far below anything
    // that could exhaust memory.
    maxPayload: 256 * 1024,
    // Echo only the `bearer` marker, never the token that follows it. ws would
    // otherwise default to selecting the first offered protocol, which happens
    // to be correct here but would silently reflect the credential back in a
    // response header if a client ever reordered them.
    handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false),
  });

  // Authenticate during the HTTP upgrade so an unauthenticated peer never
  // reaches the WebSocket state machine at all.
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const token = extractToken(req);
    if (!token) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    try {
      const principal = verifyAccessToken(token);
      // Stateless token, live account: this is where a ban or deletion that
      // happened after the token was issued actually bites.
      const user = ctx.auth.resolvePrincipal(principal);

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, {
          userId: user.id,
          username: user.username,
          role: user.role,
        });
      });
    } catch {
      rejectUpgrade(socket, 401, 'Unauthorized');
    }
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, principal: AuthPrincipal) => {
    const connection: Connection = {
      id: randomUUID(),
      socket: ws,
      principal,
      rooms: new Set<number>(),
      isAlive: true,
      connectedAt: Date.now(),
    };

    ctx.hub.add(connection);

    // Auto-subscribe to rooms the user already belongs to, so a reconnect
    // resumes delivery without replaying every join.
    const rooms = ctx.roomService.list(connection.principal);
    for (const room of rooms) {
      if (room.myRole) ctx.hub.subscribe(connection, room.id);
    }

    send(connection.socket, {
      type: 'ready',
      data: {
        user: {
          id: principal.userId,
          username: principal.username,
          role: principal.role,
        },
        rooms,
      },
    });

    ws.on('pong', () => {
      connection.isAlive = true;
    });

    ws.on('message', (raw) => {
      handleMessage(ctx, connection, raw.toString());
    });

    ws.on('close', () => {
      const rooms = [...connection.rooms];
      ctx.hub.remove(connection);

      // Announce departure only when the user's *last* socket goes away.
      if (ctx.hub.connectionsForUser(principal.userId).length > 0) return;

      for (const roomId of rooms) {
        ctx.hub.broadcast(roomId, {
          type: 'room.presence',
          data: {
            roomId,
            userId: principal.userId,
            username: principal.username,
            event: 'left',
          },
        });
      }
    });

    ws.on('error', () => {
      // Surfaced as a close event; nothing extra to do, but an unhandled
      // 'error' on a socket would otherwise crash the process.
    });
  });

  // Liveness sweep. A TCP connection can stay "open" long after the peer is
  // gone (laptop lid closed, NAT timeout); without this those sockets linger
  // in the hub forever and keep receiving broadcasts nobody reads.
  const heartbeat = setInterval(() => {
    for (const connection of ctx.hub.all()) {
      if (!connection.isAlive) {
        connection.socket.terminate();
        continue;
      }
      connection.isAlive = false;
      try {
        connection.socket.ping();
      } catch {
        connection.socket.terminate();
      }
    }
    ctx.messageLimiter.sweep();
    ctx.connectionLimiter.sweep();
  }, config.heartbeatIntervalMs);

  // Don't hold the event loop open just for the sweep.
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    /* socket is going away */
  }
}

function handleMessage(ctx: AppContext, conn: Connection, raw: string): void {
  // Per-socket flood guard runs before parsing, so a client cannot burn CPU
  // on JSON parsing by firing garbage as fast as it can write.
  const budget = ctx.connectionLimiter.consume(`conn:${conn.id}`);
  if (!budget.allowed) {
    send(conn.socket, {
      type: 'error',
      code: 'rate_limited',
      message: 'Too many operations. Slow down.',
      retryAfterMs: budget.retryAfterMs,
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    send(conn.socket, {
      type: 'error',
      code: 'invalid_json',
      message: 'Frame must be valid JSON',
    });
    return;
  }

  const result = clientFrameSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.');
    send(conn.socket, {
      type: 'error',
      ...(typeof (parsed as { id?: unknown })?.id === 'string'
        ? { id: (parsed as { id: string }).id }
        : {}),
      code: 'invalid_request',
      message: issue ? `${path ? `${path}: ` : ''}${issue.message}` : 'Malformed frame',
    });
    return;
  }

  const frame = result.data;

  if (frame.type === 'ping') {
    send(conn.socket, { type: 'pong', ...(frame.id ? { id: frame.id } : {}) });
    return;
  }

  try {
    const data = dispatch(ctx, conn, frame);
    send(conn.socket, {
      type: 'ack',
      ...(frame.id ? { id: frame.id } : {}),
      op: frame.type,
      data,
    });
  } catch (err) {
    if (err instanceof AppError) {
      const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
      send(conn.socket, {
        type: 'error',
        ...(frame.id ? { id: frame.id } : {}),
        code: err.code,
        message: err.message,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
      return;
    }

    // Unexpected: log server-side, tell the client nothing useful to an attacker.
    console.error('[ws] unhandled error handling %s:', frame.type, err);
    send(conn.socket, {
      type: 'error',
      ...(frame.id ? { id: frame.id } : {}),
      code: 'internal_error',
      message: 'Something went wrong',
    });
  }
}

/**
 * Force-disconnects every socket a user holds.
 *
 * The close code distinguishes the two cases for the client: BANNED is
 * terminal and should drop the stored token, whereas DISCONNECTED is a kick
 * that the client may reconnect from.
 */
export function disconnectUser(
  ctx: AppContext,
  userId: number,
  reason: string,
  code: number = CloseCode.DISCONNECTED,
): number {
  const connections = ctx.hub.connectionsForUser(userId);
  for (const connection of connections) {
    send(connection.socket, { type: 'system', data: { event: 'disconnected', message: reason } });
    connection.socket.close(code, reason);
  }
  return connections.length;
}
