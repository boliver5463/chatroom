/**
 * End-to-end smoke test against a *running* server.
 *   node scripts/smoke.mjs [baseUrl]
 *
 * Exercises the same wire contract the browser client uses: REST auth, the
 * `bearer` subprotocol handshake, room join, broadcast, mention, edit, delete,
 * history pagination and the admin API.
 */
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://127.0.0.1:3111';
const wsBase = base.replace(/^http/, 'ws') + '/ws';
const stamp = Date.now().toString(36);

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function connect(token) {
  const socket = new WebSocket(wsBase, ['bearer', token]);
  const pending = new Map();
  const events = [];
  const waiters = [];
  let seq = 0;

  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.id && pending.has(frame.id)) {
      const entry = pending.get(frame.id);
      pending.delete(frame.id);
      frame.type === 'error' ? entry.reject(new Error(frame.message)) : entry.resolve(frame.data ?? {});
      return;
    }
    events.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(frame)) waiters.splice(i, 1)[0].resolve(frame);
    }
  });

  const client = {
    socket,
    events,
    send(type, data) {
      const id = `s${++seq}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, type, ...(data ? { data } : {}) }));
        setTimeout(() => pending.delete(id) && reject(new Error(`timeout: ${type}`)), 5000);
      });
    },
    waitFor(predicate, ms = 5000) {
      const hit = events.find(predicate);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i !== -1) waiters.splice(i, 1), reject(new Error('timeout waiting for frame'));
        }, ms);
      });
    },
    close: () => socket.close(),
  };

  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(client));
    socket.once('error', reject);
    socket.once('unexpected-response', (_q, res) =>
      reject(new Error(`handshake rejected ${res.statusCode}`)),
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\nSmoke test against ${base}\n`);

  const health = await api('/health');
  check('GET /health', health.status === 200 && health.body.ok === true);

  // --- auth -------------------------------------------------------------
  const alice = await api('/api/auth/register', {
    method: 'POST',
    body: { username: `alice-${stamp}`, password: 'password123' },
  });
  check('register alice', alice.status === 201, `status ${alice.status}`);

  const bob = await api('/api/auth/register', {
    method: 'POST',
    body: { username: `bob-${stamp}`, password: 'password123' },
  });
  check('register bob', bob.status === 201);

  const badLogin = await api('/api/auth/login', {
    method: 'POST',
    body: { username: `alice-${stamp}`, password: 'wrong-password' },
  });
  check('wrong password rejected', badLogin.status === 401);

  const noToken = await api('/api/rooms');
  check('unauthenticated /api/rooms rejected', noToken.status === 401);

  // --- rooms ------------------------------------------------------------
  const created = await api('/api/rooms', {
    method: 'POST',
    token: alice.body.token,
    body: { name: `Smoke ${stamp}` },
  });
  check('create room', created.status === 201, created.body?.room?.slug);
  const roomId = created.body.room.id;

  const privateRoom = await api('/api/rooms', {
    method: 'POST',
    token: alice.body.token,
    body: { name: `Private ${stamp}`, visibility: 'private' },
  });
  const privateId = privateRoom.body.room.id;

  const intruder = await api(`/api/rooms/${privateId}/join`, {
    method: 'POST',
    token: bob.body.token,
  });
  check('private room blocks self-join', intruder.status === 403);

  // --- websockets -------------------------------------------------------
  const aliceWs = await connect(alice.body.token);
  const bobWs = await connect(bob.body.token);
  check('websocket handshake via bearer subprotocol', true);

  const ready = await aliceWs.waitFor((f) => f.type === 'ready');
  check('ready frame on connect', ready.data.user.username === `alice-${stamp}`);

  await aliceWs.send('room.join', { roomId });
  const bobJoin = await bobWs.send('room.join', { roomId });
  check('join public room', bobJoin.room.id === roomId);
  check('join returns a first history page', Array.isArray(bobJoin.history.messages));

  const presence = await aliceWs.waitFor((f) => f.type === 'room.presence');
  check('presence broadcast on join', presence.data.username === `bob-${stamp}`);

  // --- broadcast + mention ---------------------------------------------
  const sent = await aliceWs.send('message.send', {
    roomId,
    body: `hello @bob-${stamp}, welcome`,
  });
  check('send message', sent.message.body.startsWith('hello'));
  check('mention resolved to a member', sent.message.mentions.includes(`bob-${stamp}`));

  const delivered = await bobWs.waitFor((f) => f.type === 'message.new');
  check('message broadcast to other member', delivered.data.message.id === sent.message.id);

  const mention = await bobWs.waitFor((f) => f.type === 'mention');
  check('targeted mention frame delivered', mention.data.message.id === sent.message.id);

  // --- edit / delete ----------------------------------------------------
  await aliceWs.send('message.edit', { messageId: sent.message.id, body: 'edited text' });
  const edited = await bobWs.waitFor((f) => f.type === 'message.edited');
  check('edit broadcast', edited.data.message.body === 'edited text');

  let rejected = false;
  await bobWs.send('message.edit', { messageId: sent.message.id, body: 'hijack' }).catch(() => {
    rejected = true;
  });
  check('non-author edit refused', rejected);

  await aliceWs.send('message.delete', { messageId: sent.message.id });
  const deleted = await bobWs.waitFor((f) => f.type === 'message.deleted');
  check('delete broadcast', deleted.data.messageId === sent.message.id);

  // --- rate limiting ----------------------------------------------------
  let limited = false;
  for (let i = 0; i < 12; i++) {
    await aliceWs.send('message.send', { roomId, body: `flood ${i}` }).catch((err) => {
      if (/too fast/i.test(err.message)) limited = true;
    });
    if (limited) break;
  }
  check('rate limiter engages on a flood', limited);

  // --- history ----------------------------------------------------------
  await sleep(200);
  const page = await bobWs.send('history.fetch', { roomId, limit: 3 });
  check('history page respects limit', page.messages.length <= 3);
  check(
    'history is ordered oldest -> newest',
    page.messages.every((m, i, arr) => i === 0 || arr[i - 1].id < m.id),
  );

  if (page.hasMore) {
    const older = await bobWs.send('history.fetch', { roomId, limit: 3, before: page.nextCursor });
    check(
      'keyset pagination returns strictly older rows',
      older.messages.every((m) => m.id < page.messages[0].id),
    );
  }

  // --- admin ------------------------------------------------------------
  const adminLogin = await api('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin12345' },
  });
  check('bootstrap admin can log in', adminLogin.status === 200);

  if (adminLogin.status === 200) {
    const adminToken = adminLogin.body.token;
    const stats = await api('/api/admin/stats', { token: adminToken });
    check('admin stats', stats.status === 200 && stats.body.live.connections >= 2);

    const forbidden = await api('/api/admin/stats', { token: bob.body.token });
    check('admin API refuses non-admins', forbidden.status === 403);

    const closed = new Promise((resolve) => bobWs.socket.once('close', (code) => resolve(code)));
    await api(`/api/admin/users/${bob.body.user.id}/ban`, {
      method: 'POST',
      token: adminToken,
      body: { banned: true },
    });
    check('banning disconnects the live socket', (await closed) === 4003);

    const afterBan = await api('/api/rooms', { token: bob.body.token });
    check('ban invalidates an existing token', afterBan.status === 403);

    await api(`/api/admin/users/${bob.body.user.id}/ban`, {
      method: 'POST',
      token: adminToken,
      body: { banned: false },
    });
  }

  // --- static assets ----------------------------------------------------
  for (const path of ['/', '/admin']) {
    const res = await fetch(base + path);
    const html = await res.text();
    check(`serves ${path}`, res.status === 200 && html.includes('</html>'));
  }

  // The old .html addresses stay reachable, as permanent redirects.
  for (const [from, to] of [
    ['/index.html', '/'],
    ['/admin.html', '/admin'],
  ]) {
    const res = await fetch(base + from, { redirect: 'manual' });
    check(
      `redirects ${from} -> ${to}`,
      res.status === 301 && res.headers.get('location') === to,
    );
  }

  aliceWs.close();
  bobWs.close();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
