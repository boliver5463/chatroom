import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createContext, type AppContext } from '../src/context.js';
import { openDatabase } from '../src/db/index.js';
import { createApp } from '../src/http/app.js';
import { attachWebSocketServer } from '../src/ws/server.js';

export interface TestServer {
  ctx: AppContext;
  baseUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
}

/** Boots the real HTTP + WS stack over an in-memory database on a free port. */
export async function startTestServer(): Promise<TestServer> {
  const db = openDatabase(':memory:');
  const ctx = createContext(db);
  const httpServer: Server = createServer(createApp(ctx));
  const wss = attachWebSocketServer(httpServer, ctx);

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    ctx,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of ctx.hub.all()) connection.socket.terminate();
        wss.close();
        httpServer.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function request(
  server: TestServer,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function registerUser(
  server: TestServer,
  username: string,
  password = 'password123',
): Promise<{ token: string; user: { id: number; username: string; role: string } }> {
  const res = await request(server, 'POST', '/api/auth/register', {
    body: { username, password },
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, user: res.body.user };
}

/**
 * Thin promise-based WebSocket client mirroring what the browser client does:
 * correlate requests by id, buffer unsolicited events for assertions.
 */
export class TestClient {
  private readonly pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly events: any[] = [];
  private readonly waiters: { predicate: (frame: any) => boolean; resolve: (f: any) => void }[] = [];
  private seq = 0;

  private constructor(readonly socket: WebSocket) {}

  static async connect(server: TestServer, token: string): Promise<TestClient> {
    const socket = new WebSocket(server.wsUrl, ['bearer', token]);
    const client = new TestClient(socket);

    socket.on('message', (raw) => client.onFrame(JSON.parse(raw.toString())));

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
      socket.once('unexpected-response', (_req, res) =>
        reject(new Error(`handshake rejected with ${res.statusCode}`)),
      );
    });

    // The server sends `ready` immediately; wait so tests start from a known point.
    await client.waitFor((frame) => frame.type === 'ready');
    return client;
  }

  private onFrame(frame: any): void {
    if (frame.id && this.pending.has(frame.id)) {
      const entry = this.pending.get(frame.id)!;
      this.pending.delete(frame.id);
      if (frame.type === 'error') entry.reject(Object.assign(new Error(frame.message), { code: frame.code }));
      else entry.resolve(frame.data ?? {});
      return;
    }

    this.events.push(frame);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i]!;
      if (waiter.predicate(frame)) {
        this.waiters.splice(i, 1);
        waiter.resolve(frame);
      }
    }
  }

  send(type: string, data?: unknown): Promise<any> {
    const id = `t${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, type, ...(data !== undefined ? { data } : {}) }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout waiting for ack of ${type}`));
      }, 5000);
    });
  }

  /** Sends a raw string, bypassing the frame builder (for malformed-input tests). */
  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  waitFor(predicate: (frame: any) => boolean, timeoutMs = 5000): Promise<any> {
    const buffered = this.events.find(predicate);
    if (buffered) return Promise.resolve(buffered);

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) {
          this.waiters.splice(index, 1);
          reject(new Error('timeout waiting for frame'));
        }
      }, timeoutMs);
    });
  }

  received(predicate: (frame: any) => boolean): any[] {
    return this.events.filter(predicate);
  }

  close(): void {
    this.socket.close();
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
