import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerUser, request, startTestServer, type TestServer } from './helpers.js';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

describe('authentication', () => {
  it('registers a user and returns a token', async () => {
    const res = await request(server, 'POST', '/api/auth/register', {
      body: { username: 'alice', password: 'password123' },
    });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.user.username).toBe('alice');
    expect(res.body.user.role).toBe('user');
    // The hash must never leave the server.
    expect(JSON.stringify(res.body)).not.toContain('scrypt$');
  });

  it('rejects a duplicate username case-insensitively', async () => {
    const res = await request(server, 'POST', '/api/auth/register', {
      body: { username: 'ALICE', password: 'password123' },
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('rejects a short password', async () => {
    const res = await request(server, 'POST', '/api/auth/register', {
      body: { username: 'shorty', password: 'abc' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid username', async () => {
    const res = await request(server, 'POST', '/api/auth/register', {
      body: { username: 'bad name!', password: 'password123' },
    });
    expect(res.status).toBe(400);
  });

  it('reserves @all style names', async () => {
    const res = await request(server, 'POST', '/api/auth/register', {
      body: { username: 'everyone', password: 'password123' },
    });
    expect(res.status).toBe(409);
  });

  it('logs in with correct credentials', async () => {
    const res = await request(server, 'POST', '/api/auth/login', {
      body: { username: 'alice', password: 'password123' },
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
  });

  it('gives the same error for a wrong password and an unknown user', async () => {
    const wrongPassword = await request(server, 'POST', '/api/auth/login', {
      body: { username: 'alice', password: 'nope-wrong-one' },
    });
    const unknownUser = await request(server, 'POST', '/api/auth/login', {
      body: { username: 'ghost', password: 'nope-wrong-one' },
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
  });

  it('refuses protected routes without a token', async () => {
    const res = await request(server, 'GET', '/api/rooms');
    expect(res.status).toBe(401);
  });

  it('refuses a garbage token', async () => {
    const res = await request(server, 'GET', '/api/rooms', { token: 'not.a.jwt' });
    expect(res.status).toBe(401);
  });
});

describe('rooms', () => {
  it('creates, lists and joins a public room', async () => {
    const alice = await registerUser(server, 'roomowner');
    const bob = await registerUser(server, 'roomjoiner');

    const created = await request(server, 'POST', '/api/rooms', {
      token: alice.token,
      body: { name: 'Engineering' },
    });
    expect(created.status).toBe(201);
    expect(created.body.room.slug).toBe('engineering');

    const roomId = created.body.room.id;

    // The creator is seated as owner automatically.
    const listed = await request(server, 'GET', '/api/rooms', { token: alice.token });
    const mine = listed.body.rooms.find((r: any) => r.id === roomId);
    expect(mine.myRole).toBe('owner');

    // A public room is self-serve.
    const joined = await request(server, 'POST', `/api/rooms/${roomId}/join`, { token: bob.token });
    expect(joined.status).toBe(200);
    expect(joined.body.membership.role).toBe('member');
  });

  it('rejects a duplicate room slug', async () => {
    const user = await registerUser(server, 'dupe-maker');
    await request(server, 'POST', '/api/rooms', { token: user.token, body: { name: 'Unique Room' } });

    const again = await request(server, 'POST', '/api/rooms', {
      token: user.token,
      body: { name: 'unique room' },
    });
    expect(again.status).toBe(409);
  });

  it('keeps private rooms out of a stranger’s listing and refuses self-join', async () => {
    const owner = await registerUser(server, 'privateowner');
    const stranger = await registerUser(server, 'stranger');

    const created = await request(server, 'POST', '/api/rooms', {
      token: owner.token,
      body: { name: 'Secret Plans', visibility: 'private' },
    });
    const roomId = created.body.room.id;

    const listing = await request(server, 'GET', '/api/rooms', { token: stranger.token });
    expect(listing.body.rooms.find((r: any) => r.id === roomId)).toBeUndefined();

    const join = await request(server, 'POST', `/api/rooms/${roomId}/join`, {
      token: stranger.token,
    });
    expect(join.status).toBe(403);

    // ...and no reading it either.
    const history = await request(server, 'GET', `/api/rooms/${roomId}/messages`, {
      token: stranger.token,
    });
    expect(history.status).toBe(403);
  });

  it('lets an owner invite a user into a private room', async () => {
    const owner = await registerUser(server, 'inviter');
    const guest = await registerUser(server, 'guest');

    const created = await request(server, 'POST', '/api/rooms', {
      token: owner.token,
      body: { name: 'Invite Only', visibility: 'private' },
    });
    const roomId = created.body.room.id;

    const invited = await request(server, 'POST', `/api/rooms/${roomId}/members`, {
      token: owner.token,
      body: { username: 'guest' },
    });
    expect(invited.status).toBe(201);

    const listing = await request(server, 'GET', '/api/rooms', { token: guest.token });
    expect(listing.body.rooms.find((r: any) => r.id === roomId)).toBeDefined();
  });

  it('refuses an invite from a plain member', async () => {
    const owner = await registerUser(server, 'owner2');
    const member = await registerUser(server, 'member2');
    await registerUser(server, 'outsider2');

    const created = await request(server, 'POST', '/api/rooms', {
      token: owner.token,
      body: { name: 'Member Powers' },
    });
    const roomId = created.body.room.id;
    await request(server, 'POST', `/api/rooms/${roomId}/join`, { token: member.token });

    const attempt = await request(server, 'POST', `/api/rooms/${roomId}/members`, {
      token: member.token,
      body: { username: 'outsider2' },
    });
    expect(attempt.status).toBe(403);
  });

  it('stops an owner from stranding a room by leaving', async () => {
    const owner = await registerUser(server, 'stayowner');
    const member = await registerUser(server, 'staymember');

    const created = await request(server, 'POST', '/api/rooms', {
      token: owner.token,
      body: { name: 'Owned Room' },
    });
    const roomId = created.body.room.id;
    await request(server, 'POST', `/api/rooms/${roomId}/join`, { token: member.token });

    const leave = await request(server, 'POST', `/api/rooms/${roomId}/leave`, {
      token: owner.token,
    });
    expect(leave.status).toBe(400);
    expect(leave.body.error.message).toMatch(/Transfer ownership/);
  });

  it('requires membership before posting', async () => {
    const owner = await registerUser(server, 'poster-owner');
    const outsider = await registerUser(server, 'poster-outsider');

    const created = await request(server, 'POST', '/api/rooms', {
      token: owner.token,
      body: { name: 'Post Guard' },
    });

    const attempt = await request(server, 'POST', `/api/rooms/${created.body.room.id}/messages`, {
      token: outsider.token,
      body: { body: 'let me in' },
    });
    expect(attempt.status).toBe(403);
  });
});

describe('messages over REST', () => {
  let token: string;
  let otherToken: string;
  let authorId: number;
  let roomId: number;

  // The send limiter is deliberately tight in the test env (burst 3). These
  // cases are about message semantics, not throttling, so each starts with a
  // full bucket; the limiter itself is covered in its own test.
  beforeEach(() => {
    if (authorId) server.ctx.messageLimiter.reset(`user:${authorId}`);
  });

  beforeAll(async () => {
    const author = await registerUser(server, 'rest-author');
    const other = await registerUser(server, 'rest-other');
    token = author.token;
    otherToken = other.token;
    authorId = author.user.id;

    const created = await request(server, 'POST', '/api/rooms', {
      token,
      body: { name: 'REST Room' },
    });
    roomId = created.body.room.id;
    await request(server, 'POST', `/api/rooms/${roomId}/join`, { token: otherToken });
  });

  it('posts and reads back a message', async () => {
    const sent = await request(server, 'POST', `/api/rooms/${roomId}/messages`, {
      token,
      body: { body: 'hello over http' },
    });
    expect(sent.status).toBe(201);

    const history = await request(server, 'GET', `/api/rooms/${roomId}/messages`, { token });
    expect(history.body.messages.at(-1).body).toBe('hello over http');
  });

  it('records a resolved mention only for room members', async () => {
    const sent = await request(server, 'POST', `/api/rooms/${roomId}/messages`, {
      token,
      body: { body: 'ping @rest-other and @nobody-here' },
    });

    expect(sent.body.message.mentions).toEqual(['rest-other']);

    const inbox = await request(server, 'GET', '/api/mentions', { token: otherToken });
    expect(inbox.body.messages.at(-1).body).toContain('ping @rest-other');
  });

  it('lets the author edit, and records the edit', async () => {
    const sent = await request(server, 'POST', `/api/rooms/${roomId}/messages`, {
      token,
      body: { body: 'typo here' },
    });
    const messageId = sent.body.message.id;

    const edited = await request(server, 'PATCH', `/api/messages/${messageId}`, {
      token,
      body: { body: 'fixed now' },
    });

    expect(edited.status).toBe(200);
    expect(edited.body.message.body).toBe('fixed now');
    expect(edited.body.message.editedAt).toBeTypeOf('number');
  });

  it('refuses an edit by anyone but the author', async () => {
    const sent = await request(server, 'POST', `/api/rooms/${roomId}/messages`, {
      token,
      body: { body: 'my words' },
    });

    const attempt = await request(server, 'PATCH', `/api/messages/${sent.body.message.id}`, {
      token: otherToken,
      body: { body: 'not my words' },
    });
    expect(attempt.status).toBe(403);
  });

  it('lets the author delete, leaving a tombstone', async () => {
    const sent = await request(server, 'POST', `/api/rooms/${roomId}/messages`, {
      token,
      body: { body: 'delete me' },
    });
    const messageId = sent.body.message.id;

    const deleted = await request(server, 'DELETE', `/api/messages/${messageId}`, { token });
    expect(deleted.status).toBe(200);

    const history = await request(server, 'GET', `/api/rooms/${roomId}/messages`, { token });
    const tombstone = history.body.messages.find((m: any) => m.id === messageId);
    expect(tombstone.body).toBe('');
    expect(tombstone.deletedAt).toBeTypeOf('number');
  });

  it('rejects an over-long message', async () => {
    const res = await request(server, 'POST', `/api/rooms/${roomId}/messages`, {
      token,
      body: { body: 'x'.repeat(5000) },
    });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed JSON body', async () => {
    const res = await fetch(`${server.baseUrl}/api/rooms/${roomId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('admin interface', () => {
  let adminToken: string;
  let victimId: number;
  let victimToken: string;

  beforeAll(async () => {
    const admin = await registerUser(server, 'the-admin');
    server.ctx.users.setRole(admin.user.id, 'admin');

    // Re-login so the token carries the admin role.
    const relogin = await request(server, 'POST', '/api/auth/login', {
      body: { username: 'the-admin', password: 'password123' },
    });
    adminToken = relogin.body.token;

    const victim = await registerUser(server, 'the-victim');
    victimId = victim.user.id;
    victimToken = victim.token;
  });

  it('refuses non-admins', async () => {
    const res = await request(server, 'GET', '/api/admin/stats', { token: victimToken });
    expect(res.status).toBe(403);
  });

  it('serves stats', async () => {
    const res = await request(server, 'GET', '/api/admin/stats', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.users).toBeGreaterThan(0);
  });

  it('lists and searches users', async () => {
    const res = await request(server, 'GET', '/api/admin/users?search=victim', {
      token: adminToken,
    });
    expect(res.body.users.map((u: any) => u.username)).toContain('the-victim');
  });

  it('bans a user, and the ban takes effect on the existing token', async () => {
    const banned = await request(server, 'POST', `/api/admin/users/${victimId}/ban`, {
      token: adminToken,
      body: { banned: true },
    });
    expect(banned.status).toBe(200);

    // The JWT is still cryptographically valid; the DB check is what stops it.
    const blocked = await request(server, 'GET', '/api/rooms', { token: victimToken });
    expect(blocked.status).toBe(403);

    const loginBlocked = await request(server, 'POST', '/api/auth/login', {
      body: { username: 'the-victim', password: 'password123' },
    });
    expect(loginBlocked.status).toBe(403);
  });

  it('unbans a user', async () => {
    await request(server, 'POST', `/api/admin/users/${victimId}/ban`, {
      token: adminToken,
      body: { banned: false },
    });
    const ok = await request(server, 'GET', '/api/rooms', { token: victimToken });
    expect(ok.status).toBe(200);
  });

  it('refuses to let an admin ban themselves', async () => {
    const me = await request(server, 'GET', '/api/auth/me', { token: adminToken });
    const res = await request(server, 'POST', `/api/admin/users/${me.body.user.id}/ban`, {
      token: adminToken,
      body: { banned: true },
    });
    expect(res.status).toBe(400);
  });

  it('archives a room, blocking further posts', async () => {
    const owner = await registerUser(server, 'archive-owner');
    const created = await request(server, 'POST', '/api/rooms', {
      token: owner.token,
      body: { name: 'Doomed Room' },
    });
    const roomId = created.body.room.id;

    await request(server, 'POST', `/api/admin/rooms/${roomId}/archive`, {
      token: adminToken,
      body: { archived: true },
    });

    const post = await request(server, 'POST', `/api/rooms/${roomId}/messages`, {
      token: owner.token,
      body: { body: 'anyone there?' },
    });
    expect(post.status).toBe(403);
  });

  it('deletes a room and its messages', async () => {
    const owner = await registerUser(server, 'delete-owner');
    const created = await request(server, 'POST', '/api/rooms', {
      token: owner.token,
      body: { name: 'Delete Me Room' },
    });
    const roomId = created.body.room.id;

    await request(server, 'POST', `/api/rooms/${roomId}/messages`, {
      token: owner.token,
      body: { body: 'transient' },
    });

    const deleted = await request(server, 'DELETE', `/api/admin/rooms/${roomId}`, {
      token: adminToken,
    });
    expect(deleted.status).toBe(200);
    expect(server.ctx.rooms.findById(roomId)).toBeNull();
  });

  it('lets an admin delete someone else’s message', async () => {
    const author = await registerUser(server, 'moderated-author');
    const created = await request(server, 'POST', '/api/rooms', {
      token: author.token,
      body: { name: 'Moderated Room' },
    });
    const sent = await request(server, 'POST', `/api/rooms/${created.body.room.id}/messages`, {
      token: author.token,
      body: { body: 'something against the rules' },
    });

    const removed = await request(server, 'DELETE', `/api/admin/messages/${sent.body.message.id}`, {
      token: adminToken,
    });
    expect(removed.status).toBe(200);
    expect(server.ctx.messages.findById(sent.body.message.id)!.deletedAt).toBeTypeOf('number');
  });
});
