import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { signAccessToken, verifyAccessToken, bearerFromHeader } from '../src/auth/tokens.js';
import { parseMentions } from '../src/lib/mentions.js';
import { TokenBucketRateLimiter } from '../src/lib/rateLimiter.js';
import { slugify } from '../src/db/rooms.js';
import { openDatabase } from '../src/db/index.js';
import { LATEST_SCHEMA_VERSION, migrate } from '../src/db/migrations.js';
import { createContext } from '../src/context.js';

describe('password hashing', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('secret-password');
    expect(await verifyPassword('secret-passworD', hash)).toBe(false);
  });

  it('produces a different hash each time (salted)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false);
  });
});

describe('access tokens', () => {
  it('round-trips a principal', () => {
    const token = signAccessToken({ userId: 7, username: 'ada', role: 'admin' });
    expect(verifyAccessToken(token)).toEqual({ userId: 7, username: 'ada', role: 'admin' });
  });

  it('rejects a tampered token', () => {
    const token = signAccessToken({ userId: 7, username: 'ada', role: 'user' });
    const tampered = `${token.slice(0, -3)}abc`;
    expect(() => verifyAccessToken(tampered)).toThrow(/Invalid or expired/);
  });

  it('rejects an unsigned "alg: none" token', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ sub: '1', username: 'x', role: 'admin' })).toString(
      'base64url',
    );
    expect(() => verifyAccessToken(`${header}.${claims}.`)).toThrow();
  });

  it('parses bearer headers', () => {
    expect(bearerFromHeader('Bearer abc')).toBe('abc');
    expect(bearerFromHeader('bearer abc')).toBe('abc');
    expect(bearerFromHeader('Basic abc')).toBeNull();
    expect(bearerFromHeader(undefined)).toBeNull();
  });
});

describe('mention parsing', () => {
  it('extracts distinct usernames', () => {
    expect(parseMentions('hi @ada and @grace and @ada again').usernames).toEqual(['ada', 'grace']);
  });

  it('ignores email addresses', () => {
    expect(parseMentions('mail me at bob@example.com').usernames).toEqual([]);
  });

  it('strips trailing punctuation', () => {
    expect(parseMentions('thanks @ada.').usernames).toEqual(['ada']);
  });

  it('flags @all style broadcasts separately', () => {
    const parsed = parseMentions('@here standup in 5, @ada');
    expect(parsed.everyone).toBe(true);
    expect(parsed.usernames).toEqual(['ada']);
  });

  it('matches a mention at the very start of a message', () => {
    expect(parseMentions('@ada hello').usernames).toEqual(['ada']);
  });
});

describe('token bucket rate limiter', () => {
  it('allows a burst then blocks', () => {
    const limiter = new TokenBucketRateLimiter(3, 1);
    expect(limiter.consume('k').allowed).toBe(true);
    expect(limiter.consume('k').allowed).toBe(true);
    expect(limiter.consume('k').allowed).toBe(true);

    const blocked = limiter.consume('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('keys are independent', () => {
    const limiter = new TokenBucketRateLimiter(1, 1);
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('b').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(false);
  });

  it('refills over time', async () => {
    const limiter = new TokenBucketRateLimiter(1, 20); // 20 tokens/sec = 50ms each
    expect(limiter.consume('k').allowed).toBe(true);
    expect(limiter.consume('k').allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 120));
    expect(limiter.consume('k').allowed).toBe(true);
  });
});

describe('slugify', () => {
  it('normalises room names', () => {
    expect(slugify('General Chat')).toBe('general-chat');
    expect(slugify('  Ops/Alerts!! ')).toBe('ops-alerts');
    expect(slugify('***')).toBe('');
  });
});

describe('migrations', () => {
  it('bring a fresh database to the latest version', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('are idempotent when re-run', () => {
    const db = openDatabase(':memory:');
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('enable foreign key cascades', () => {
    const db = openDatabase(':memory:');
    const ctx = createContext(db);

    const user = ctx.users.create('cascade-user', 'hash');
    const room = ctx.rooms.create({
      slug: 'r',
      name: 'r',
      visibility: 'public',
      createdBy: user.id,
    });
    ctx.messages.insert({
      roomId: room.id,
      userId: user.id,
      username: user.username,
      body: 'hello',
      mentionUserIds: [],
    });

    expect(ctx.messages.countInRoom(room.id)).toBe(1);
    ctx.rooms.delete(room.id);
    expect(ctx.messages.countInRoom(room.id)).toBe(0);

    db.close();
  });
});

describe('message repository pagination', () => {
  it('walks backwards through history without gaps or repeats', () => {
    const db = openDatabase(':memory:');
    const ctx = createContext(db);

    const user = ctx.users.create('paginator', 'hash');
    const room = ctx.rooms.create({
      slug: 'p',
      name: 'p',
      visibility: 'public',
      createdBy: user.id,
    });

    for (let i = 1; i <= 25; i++) {
      ctx.messages.insert({
        roomId: room.id,
        userId: user.id,
        username: user.username,
        body: `message ${i}`,
        mentionUserIds: [],
      });
    }

    const seen: string[] = [];
    let cursor: number | null | undefined;
    let pages = 0;

    do {
      const page = ctx.messages.listHistory(room.id, {
        ...(cursor ? { before: cursor } : {}),
        limit: 10,
      });
      // Each page is returned oldest -> newest.
      expect(page.messages.map((m) => m.id)).toEqual(
        [...page.messages].sort((a, b) => a.id - b.id).map((m) => m.id),
      );
      seen.unshift(...page.messages.map((m) => m.body));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe('message 1');
    expect(seen[24]).toBe('message 25');

    db.close();
  });

  it('serves a forward page via `after` for reconnect catch-up', () => {
    const db = openDatabase(':memory:');
    const ctx = createContext(db);

    const user = ctx.users.create('catcher', 'hash');
    const room = ctx.rooms.create({
      slug: 'c',
      name: 'c',
      visibility: 'public',
      createdBy: user.id,
    });

    const ids = Array.from({ length: 5 }, (_, i) =>
      ctx.messages.insert({
        roomId: room.id,
        userId: user.id,
        username: user.username,
        body: `m${i}`,
        mentionUserIds: [],
      }).id,
    );

    const page = ctx.messages.listHistory(room.id, { after: ids[1]!, limit: 10 });
    expect(page.messages.map((m) => m.body)).toEqual(['m2', 'm3', 'm4']);

    db.close();
  });

  it('keeps soft-deleted messages in the stream but withholds the body', () => {
    const db = openDatabase(':memory:');
    const ctx = createContext(db);

    const user = ctx.users.create('deleter', 'hash');
    const room = ctx.rooms.create({
      slug: 'd',
      name: 'd',
      visibility: 'public',
      createdBy: user.id,
    });
    const message = ctx.messages.insert({
      roomId: room.id,
      userId: user.id,
      username: user.username,
      body: 'oops, secret',
      mentionUserIds: [],
    });

    ctx.messages.softDelete(message.id);
    const page = ctx.messages.listHistory(room.id, { limit: 10 });

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.body).toBe('');
    expect(page.messages[0]!.deletedAt).toBeTypeOf('number');

    db.close();
  });

  it('records a revision when a message is edited', () => {
    const db = openDatabase(':memory:');
    const ctx = createContext(db);

    const user = ctx.users.create('editor', 'hash');
    const room = ctx.rooms.create({
      slug: 'e',
      name: 'e',
      visibility: 'public',
      createdBy: user.id,
    });
    const message = ctx.messages.insert({
      roomId: room.id,
      userId: user.id,
      username: user.username,
      body: 'first draft',
      mentionUserIds: [],
    });

    ctx.messages.updateBody(message.id, 'second draft', []);

    const revisions = db
      .prepare('SELECT body FROM message_revisions WHERE message_id = ?')
      .all(message.id) as { body: string }[];

    expect(revisions.map((r) => r.body)).toEqual(['first draft']);
    expect(ctx.messages.findById(message.id)!.body).toBe('second draft');
    expect(ctx.messages.findById(message.id)!.editedAt).toBeTypeOf('number');

    db.close();
  });
});
