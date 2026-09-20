import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { signAccessToken } from '../src/auth/tokens.js';
import { registerUser, request, sleep, startTestServer, TestClient, type TestServer } from './helpers.js';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

/** Creates a user, a room they own, and a connected client. */
async function setupRoom(prefix: string): Promise<{
  token: string;
  userId: number;
  roomId: number;
  client: TestClient;
}> {
  const user = await registerUser(server, `${prefix}-owner`);
  const created = await request(server, 'POST', '/api/rooms', {
    token: user.token,
    body: { name: `${prefix} room` },
  });

  const client = await TestClient.connect(server, user.token);
  await client.send('room.join', { roomId: created.body.room.id });

  return {
    token: user.token,
    userId: user.user.id,
    roomId: created.body.room.id,
    client,
  };
}

describe('handshake authentication', () => {
  it('rejects an upgrade with no token', async () => {
    const socket = new WebSocket(server.wsUrl);
    const status = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      socket.once('open', () => reject(new Error('should not have connected')));
      socket.once('error', () => {});
    });

    expect(status).toBe(401);
  });

  it('rejects an upgrade with a forged token', async () => {
    const socket = new WebSocket(server.wsUrl, ['bearer', 'aaa.bbb.ccc']);
    const status = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      socket.once('open', () => reject(new Error('should not have connected')));
      socket.once('error', () => {});
    });

    expect(status).toBe(401);
  });

  it('rejects a well-signed token for a user that no longer exists', async () => {
    const token = signAccessToken({ userId: 999_999, username: 'ghost', role: 'user' });
    const socket = new WebSocket(server.wsUrl, ['bearer', token]);

    const status = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      socket.once('open', () => reject(new Error('should not have connected')));
      socket.once('error', () => {});
    });

    expect(status).toBe(401);
  });

  it('accepts a valid token and sends a ready frame', async () => {
    const user = await registerUser(server, 'handshake-ok');
    const client = await TestClient.connect(server, user.token);

    const ready = await client.waitFor((f) => f.type === 'ready');
    expect(ready.data.user.username).toBe('handshake-ok');
    expect(Array.isArray(ready.data.rooms)).toBe(true);

    client.close();
  });

  it('accepts a token in the query string too', async () => {
    const user = await registerUser(server, 'querystring-auth');
    const socket = new WebSocket(`${server.wsUrl}?token=${user.token}`);

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    socket.close();
  });
});

describe('protocol handling', () => {
  it('answers ping with pong', async () => {
    const user = await registerUser(server, 'pinger');
    const client = await TestClient.connect(server, user.token);

    client.sendRaw(JSON.stringify({ type: 'ping' }));
    const pong = await client.waitFor((f) => f.type === 'pong');
    expect(pong.type).toBe('pong');

    client.close();
  });

  it('rejects non-JSON without dropping the connection', async () => {
    const user = await registerUser(server, 'garbage-sender');
    const client = await TestClient.connect(server, user.token);

    client.sendRaw('<not json>');
    const error = await client.waitFor((f) => f.type === 'error');
    expect(error.code).toBe('invalid_json');

    // The socket must still be usable afterwards.
    expect(await client.send('room.list')).toHaveProperty('rooms');
    client.close();
  });

  it('rejects an unknown frame type', async () => {
    const user = await registerUser(server, 'unknown-op');
    const client = await TestClient.connect(server, user.token);

    client.sendRaw(JSON.stringify({ id: 'x1', type: 'drop.database' }));
    const error = await client.waitFor((f) => f.type === 'error' && f.id === 'x1');
    expect(error.code).toBe('invalid_request');

    client.close();
  });

  it('rejects a frame whose payload fails validation', async () => {
    const user = await registerUser(server, 'bad-payload');
    const client = await TestClient.connect(server, user.token);

    await expect(client.send('message.send', { roomId: -1, body: '' })).rejects.toThrow();
    client.close();
  });
});

describe('real-time broadcast', () => {
  it('delivers a message to every other member of the room', async () => {
    const alice = await registerUser(server, 'bc-alice');
    const bob = await registerUser(server, 'bc-bob');
    const carol = await registerUser(server, 'bc-carol');

    const created = await request(server, 'POST', '/api/rooms', {
      token: alice.token,
      body: { name: 'Broadcast Room' },
    });
    const roomId = created.body.room.id;

    const aliceClient = await TestClient.connect(server, alice.token);
    const bobClient = await TestClient.connect(server, bob.token);
    const carolClient = await TestClient.connect(server, carol.token);

    await aliceClient.send('room.join', { roomId });
    await bobClient.send('room.join', { roomId });
    await carolClient.send('room.join', { roomId });

    await aliceClient.send('message.send', { roomId, body: 'hello everyone' });

    const atBob = await bobClient.waitFor((f) => f.type === 'message.new');
    const atCarol = await carolClient.waitFor((f) => f.type === 'message.new');

    expect(atBob.data.message.body).toBe('hello everyone');
    expect(atBob.data.message.username).toBe('bc-alice');
    expect(atCarol.data.message.id).toBe(atBob.data.message.id);

    aliceClient.close();
    bobClient.close();
    carolClient.close();
  });

  it('does not leak a message to a room the user is not in', async () => {
    const insider = await setupRoom('isolation');
    const outsiderUser = await registerUser(server, 'isolation-outsider');
    const outsider = await TestClient.connect(server, outsiderUser.token);

    await insider.client.send('message.send', {
      roomId: insider.roomId,
      body: 'members only',
    });

    // Give any (incorrect) delivery time to arrive before asserting absence.
    await sleep(150);
    expect(outsider.received((f) => f.type === 'message.new')).toHaveLength(0);

    insider.client.close();
    outsider.close();
  });

  it('announces presence when someone joins', async () => {
    const host = await setupRoom('presence');
    const guestUser = await registerUser(server, 'presence-guest');
    const guest = await TestClient.connect(server, guestUser.token);

    await guest.send('room.join', { roomId: host.roomId });

    const event = await host.client.waitFor((f) => f.type === 'room.presence');
    expect(event.data.username).toBe('presence-guest');
    expect(event.data.event).toBe('joined');

    host.client.close();
    guest.close();
  });

  it('relays typing indicators to others but not the sender', async () => {
    const host = await setupRoom('typing');
    const guestUser = await registerUser(server, 'typing-guest');
    const guest = await TestClient.connect(server, guestUser.token);
    await guest.send('room.join', { roomId: host.roomId });

    await guest.send('typing', { roomId: host.roomId, isTyping: true });

    const event = await host.client.waitFor((f) => f.type === 'typing');
    expect(event.data.username).toBe('typing-guest');
    expect(guest.received((f) => f.type === 'typing')).toHaveLength(0);

    host.client.close();
    guest.close();
  });

  it('delivers to every socket a user has open', async () => {
    const user = await registerUser(server, 'multi-tab');
    const created = await request(server, 'POST', '/api/rooms', {
      token: user.token,
      body: { name: 'Multi Tab Room' },
    });
    const roomId = created.body.room.id;

    const tabOne = await TestClient.connect(server, user.token);
    const tabTwo = await TestClient.connect(server, user.token);
    await tabOne.send('room.join', { roomId });
    await tabTwo.send('room.join', { roomId });

    const sender = await registerUser(server, 'multi-tab-friend');
    const senderClient = await TestClient.connect(server, sender.token);
    await senderClient.send('room.join', { roomId });
    await senderClient.send('message.send', { roomId, body: 'seen twice' });

    expect((await tabOne.waitFor((f) => f.type === 'message.new')).data.message.body).toBe('seen twice');
    expect((await tabTwo.waitFor((f) => f.type === 'message.new')).data.message.body).toBe('seen twice');

    tabOne.close();
    tabTwo.close();
    senderClient.close();
  });
});

describe('mentions', () => {
  it('sends a targeted mention frame to the mentioned member', async () => {
    const host = await setupRoom('mention');
    const targetUser = await registerUser(server, 'mention-target');
    const target = await TestClient.connect(server, targetUser.token);
    await target.send('room.join', { roomId: host.roomId });

    await host.client.send('message.send', {
      roomId: host.roomId,
      body: 'hey @mention-target could you look at this',
    });

    const mention = await target.waitFor((f) => f.type === 'mention');
    expect(mention.data.message.mentions).toContain('mention-target');

    host.client.close();
    target.close();
  });

  it('does not notify a mentioned user who is not in the room', async () => {
    const host = await setupRoom('mention-outsider');
    const outsiderUser = await registerUser(server, 'mention-outsider-user');
    const outsider = await TestClient.connect(server, outsiderUser.token);

    const ack = await host.client.send('message.send', {
      roomId: host.roomId,
      body: 'ping @mention-outsider-user',
    });

    // The @name stays as plain text; it is never resolved to a real mention.
    expect(ack.message.mentions).toEqual([]);
    await sleep(150);
    expect(outsider.received((f) => f.type === 'mention')).toHaveLength(0);

    host.client.close();
    outsider.close();
  });

  it('serves a mentions inbox', async () => {
    const host = await setupRoom('inbox');
    const targetUser = await registerUser(server, 'inbox-target');
    const target = await TestClient.connect(server, targetUser.token);
    await target.send('room.join', { roomId: host.roomId });

    await host.client.send('message.send', { roomId: host.roomId, body: 'yo @inbox-target' });
    await target.waitFor((f) => f.type === 'mention');

    const inbox = await target.send('mentions.fetch', { limit: 10 });
    expect(inbox.messages.at(-1).body).toContain('@inbox-target');

    host.client.close();
    target.close();
  });
});

describe('editing and deleting', () => {
  it('broadcasts an edit', async () => {
    const host = await setupRoom('edit');
    const watcherUser = await registerUser(server, 'edit-watcher');
    const watcher = await TestClient.connect(server, watcherUser.token);
    await watcher.send('room.join', { roomId: host.roomId });

    const sent = await host.client.send('message.send', {
      roomId: host.roomId,
      body: 'orignal typo',
    });
    await watcher.waitFor((f) => f.type === 'message.new');

    await host.client.send('message.edit', { messageId: sent.message.id, body: 'original, fixed' });

    const edited = await watcher.waitFor((f) => f.type === 'message.edited');
    expect(edited.data.message.body).toBe('original, fixed');
    expect(edited.data.message.editedAt).toBeTypeOf('number');

    host.client.close();
    watcher.close();
  });

  it('refuses an edit from someone who is not the author', async () => {
    const host = await setupRoom('edit-guard');
    const otherUser = await registerUser(server, 'edit-guard-other');
    const other = await TestClient.connect(server, otherUser.token);
    await other.send('room.join', { roomId: host.roomId });

    const sent = await host.client.send('message.send', { roomId: host.roomId, body: 'mine' });

    await expect(
      other.send('message.edit', { messageId: sent.message.id, body: 'hijacked' }),
    ).rejects.toThrow(/only edit your own/i);

    host.client.close();
    other.close();
  });

  it('broadcasts a deletion as a tombstone', async () => {
    const host = await setupRoom('delete');
    const watcherUser = await registerUser(server, 'delete-watcher');
    const watcher = await TestClient.connect(server, watcherUser.token);
    await watcher.send('room.join', { roomId: host.roomId });

    const sent = await host.client.send('message.send', { roomId: host.roomId, body: 'regret' });
    await watcher.waitFor((f) => f.type === 'message.new');

    await host.client.send('message.delete', { messageId: sent.message.id });

    const deleted = await watcher.waitFor((f) => f.type === 'message.deleted');
    expect(deleted.data.messageId).toBe(sent.message.id);

    // History keeps the row, without the body.
    const page = await watcher.send('history.fetch', { roomId: host.roomId, limit: 50 });
    const tombstone = page.messages.find((m: any) => m.id === sent.message.id);
    expect(tombstone.body).toBe('');

    host.client.close();
    watcher.close();
  });

  it('lets a room moderator delete another user’s message', async () => {
    const host = await setupRoom('moderation');
    const speakerUser = await registerUser(server, 'moderation-speaker');
    const speaker = await TestClient.connect(server, speakerUser.token);
    await speaker.send('room.join', { roomId: host.roomId });

    const sent = await speaker.send('message.send', {
      roomId: host.roomId,
      body: 'something the owner dislikes',
    });

    // host is the room owner, which outranks moderator.
    await host.client.send('message.delete', { messageId: sent.message.id });
    const deleted = await speaker.waitFor((f) => f.type === 'message.deleted');
    expect(deleted.data.messageId).toBe(sent.message.id);

    host.client.close();
    speaker.close();
  });
});

describe('history over the socket', () => {
  it('returns a first page on join and paginates backwards', async () => {
    const host = await setupRoom('history');

    for (let i = 1; i <= 12; i++) {
      server.ctx.messageLimiter.reset(`user:${host.userId}`);
      await host.client.send('message.send', { roomId: host.roomId, body: `line ${i}` });
    }

    const firstPage = await host.client.send('history.fetch', {
      roomId: host.roomId,
      limit: 5,
    });
    expect(firstPage.messages).toHaveLength(5);
    expect(firstPage.messages.at(-1).body).toBe('line 12');
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await host.client.send('history.fetch', {
      roomId: host.roomId,
      limit: 5,
      before: firstPage.nextCursor,
    });
    expect(secondPage.messages.map((m: any) => m.body)).toEqual([
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
    ]);

    host.client.close();
  });
});

describe('rate limiting', () => {
  it('blocks a burst of messages and recovers after a refill', async () => {
    const host = await setupRoom('flood');
    server.ctx.messageLimiter.reset(`user:${host.userId}`);

    // Test config: burst 3, refill 1/sec.
    await host.client.send('message.send', { roomId: host.roomId, body: '1' });
    await host.client.send('message.send', { roomId: host.roomId, body: '2' });
    await host.client.send('message.send', { roomId: host.roomId, body: '3' });

    await expect(
      host.client.send('message.send', { roomId: host.roomId, body: '4' }),
    ).rejects.toMatchObject({ code: 'rate_limited' });

    // One token returns per second.
    await sleep(1100);
    const recovered = await host.client.send('message.send', {
      roomId: host.roomId,
      body: 'after cooldown',
    });
    expect(recovered.message.body).toBe('after cooldown');

    host.client.close();
  });

  it('counts the budget per user, not per socket', async () => {
    const user = await registerUser(server, 'two-socket-flood');
    const created = await request(server, 'POST', '/api/rooms', {
      token: user.token,
      body: { name: 'Flood Two Room' },
    });
    const roomId = created.body.room.id;
    server.ctx.messageLimiter.reset(`user:${user.user.id}`);

    const tabOne = await TestClient.connect(server, user.token);
    const tabTwo = await TestClient.connect(server, user.token);
    await tabOne.send('room.join', { roomId });
    await tabTwo.send('room.join', { roomId });

    await tabOne.send('message.send', { roomId, body: 'a' });
    await tabOne.send('message.send', { roomId, body: 'b' });
    await tabTwo.send('message.send', { roomId, body: 'c' });

    // A second tab must not buy a second budget.
    await expect(tabTwo.send('message.send', { roomId, body: 'd' })).rejects.toMatchObject({
      code: 'rate_limited',
    });

    tabOne.close();
    tabTwo.close();
  });
});

describe('administrative effects on live sockets', () => {
  it('disconnects a banned user immediately', async () => {
    const admin = await registerUser(server, 'ws-admin');
    server.ctx.users.setRole(admin.user.id, 'admin');
    const relogin = await request(server, 'POST', '/api/auth/login', {
      body: { username: 'ws-admin', password: 'password123' },
    });

    const victim = await registerUser(server, 'ws-victim');
    const victimClient = await TestClient.connect(server, victim.token);

    const closed = new Promise<number>((resolve) =>
      victimClient.socket.once('close', (code) => resolve(code)),
    );

    await request(server, 'POST', `/api/admin/users/${victim.user.id}/ban`, {
      token: relogin.body.token,
      body: { banned: true },
    });

    expect(await closed).toBe(4003);
  });
});
