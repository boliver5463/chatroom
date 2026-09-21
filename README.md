# Chatroom

A real-time chat server in TypeScript: WebSocket messaging, multiple rooms,
authentication and authorization, persisted history with pagination, @mentions,
message editing and deletion, rate limiting, and an admin console.

Design rationale — including the chat-history storage decisions — is in
[`docs/DESIGN.md`](docs/DESIGN.md).

---

## Quick start

```bash
npm install
npm run dev
```

Then open:

| URL | What it is |
|---|---|
| <http://localhost:3000/> | Chat client (register an account and start talking) |
| <http://localhost:3000/admin> | Admin console — sign in as `admin` / `admin12345` |

On first boot the server creates the bootstrap admin and a public `#general`
room. Open the client in two browser profiles to watch messages broadcast live.

```bash
npm test          # 81 unit + integration tests (real HTTP + WebSocket stack)
npm run typecheck # strict tsc, no emit
npm run build     # compile to dist/
npm start         # run the compiled server
npm run smoke     # end-to-end checks against a running server
```

---

## What's implemented

**Required**

- WebSocket transport for real-time client↔server messaging, authenticated
  during the HTTP upgrade
- Multiple rooms/channels: create, join, leave, public and invite-only
- Username/password auth (scrypt) with JWTs, per-room membership and roles
  (`owner` / `moderator` / `member`) plus a global `admin` role
- Chat history persisted to SQLite, fetched by keyset pagination over both
  REST and the socket — see [`docs/DESIGN.md §1`](docs/DESIGN.md)

**Bonus**

- @mentions — parsed at write time, stored relationally, delivered as targeted
  frames to every tab the mentioned user has open, plus a mentions inbox.
  `@all` / `@here` / `@channel` broadcast to the room
- Message editing (author only, with a stored revision history) and deletion
  (author or moderator, as a tombstone)
- Rate limiting — three token buckets: per-user message sends, per-socket frame
  floods, per-IP credential attempts
- Admin console — live stats, user search, ban/unban, promote/demote, force
  disconnect, room archive/delete, message removal

---

## Architecture

```
src/
  index.ts              entry point: HTTP + WS + graceful shutdown
  config.ts             env parsing, defaults, limits
  context.ts            composition root — everything is constructed here
  types.ts              domain types + AppError
  auth/
    passwords.ts        scrypt hashing with self-describing parameters
    tokens.ts           JWT sign/verify (HS256, algorithm-pinned)
  db/
    index.ts            connection + pragmas (WAL, foreign_keys)
    migrations.ts       forward-only migrations keyed by user_version
    users.ts  rooms.ts  messages.ts      repositories
  services/
    authService.ts      register / login / ban enforcement
    roomService.ts      membership, visibility, moderation rules
    messageService.ts   send / edit / delete / history / mentions
  lib/
    mentions.ts         @mention parsing
    rateLimiter.ts      token bucket
  http/
    app.ts  middleware.ts  routes/{auth,rooms,admin}.ts
  ws/
    server.ts           upgrade auth, heartbeat, frame routing
    hub.ts              connection registry + fan-out
    handlers.ts         one handler per frame type
    protocol.ts         zod-validated wire contract
    publish.ts          broadcast helpers shared by REST and WS
public/                 chat client + admin console (no build step)
test/                   unit, HTTP, and WebSocket suites
```

Business rules live in `services/` and are shared by both transports, so a
message posted over REST behaves identically to one sent over the socket.

---

## WebSocket protocol

Connect to `/ws`. The token may be supplied three ways — `Authorization: Bearer`,
the `Sec-WebSocket-Protocol` header (`['bearer', token]`, what the browser client
uses), or `?token=`.

```js
const ws = new WebSocket('ws://localhost:3000/ws', ['bearer', token]);
```

Every frame is JSON. Client frames carry an optional `id`, echoed on the
matching `ack`/`error` so a client can correlate responses over one socket.

### Client → server

| `type` | `data` | Returns |
|---|---|---|
| `ping` | — | `pong` |
| `room.list` | — | `{ rooms }` |
| `room.create` | `{ name, visibility? }` | `{ room }` |
| `room.join` | `{ roomId }` or `{ slug }` | `{ room, membership, members, online, history }` |
| `room.leave` | `{ roomId }` | `{ roomId }` |
| `message.send` | `{ roomId, body }` | `{ message }` |
| `message.edit` | `{ messageId, body }` | `{ message }` |
| `message.delete` | `{ messageId }` | `{ messageId }` |
| `history.fetch` | `{ roomId, before?, after?, limit? }` | `{ messages, hasMore, nextCursor }` |
| `mentions.fetch` | `{ before?, limit? }` | `{ messages, hasMore, nextCursor }` |
| `typing` | `{ roomId, isTyping }` | `{ ok }` |

### Server → client

`ready` (on connect), `ack`, `error`, `message.new`, `message.edited`,
`message.deleted`, `mention`, `room.presence`, `room.created`, `typing`,
`system`, `pong`.

Errors carry a stable machine-readable `code`: `unauthorized`, `forbidden`,
`not_found`, `conflict`, `invalid_request`, `invalid_json`, `rate_limited`
(with `retryAfterMs`), `internal_error`.

Close codes: `4001` unauthorized · `4002` protocol error · `4003` banned ·
`4029` rate limited · `4500` server shutdown.

### Example

```js
ws.send(JSON.stringify({ id: 'r1', type: 'room.join', data: { slug: 'general' } }));
ws.send(JSON.stringify({ id: 'r2', type: 'message.send',
                         data: { roomId: 1, body: 'morning @ada' } }));
```

---

## REST API

All routes except `/health` and `/api/auth/{register,login}` require
`Authorization: Bearer <token>`.

### Auth

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/auth/register` | `{ username, password }` |
| `POST` | `/api/auth/login` | `{ username, password }` |
| `GET` | `/api/auth/me` | — |

### Rooms and messages

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/rooms` | Public rooms + private rooms you belong to |
| `POST` | `/api/rooms` | `{ name, visibility? }` |
| `GET` | `/api/rooms/:id` | |
| `POST` | `/api/rooms/:id/join` \| `/leave` | |
| `GET` | `/api/rooms/:id/members` | |
| `POST` | `/api/rooms/:id/members` | Invite — `{ username \| userId, role? }` |
| `DELETE` | `/api/rooms/:id/members/:userId` | Kick (moderator+) |
| `GET` | `/api/rooms/:id/messages` | **History** — `?before=&after=&limit=` |
| `POST` | `/api/rooms/:id/messages` | `{ body }` — fans out to live sockets |
| `PATCH` | `/api/messages/:id` | `{ body }` — author only |
| `DELETE` | `/api/messages/:id` | Author or moderator |
| `GET` | `/api/mentions` | Your mention inbox — `?before=&limit=` |

### Admin (`role: admin`)

| Method | Path |
|---|---|
| `GET` | `/api/admin/stats` |
| `GET` | `/api/admin/users?search=&limit=&offset=` |
| `POST` | `/api/admin/users/:id/ban` · `/role` · `/disconnect` |
| `GET` | `/api/admin/rooms` |
| `POST` | `/api/admin/rooms/:id/archive` |
| `DELETE` | `/api/admin/rooms/:id` · `/api/admin/messages/:id` |

### Fetching previous messages

Pages are anchored to a message id, not an offset, so concurrent traffic cannot
shift the window ([why](docs/DESIGN.md#keyset-pagination-not-limitoffset)).

```bash
# newest 50
curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/rooms/1/messages

# the 50 before that — feed nextCursor back in as `before`
curl -H "Authorization: Bearer $TOKEN" \
     "localhost:3000/api/rooms/1/messages?before=812&limit=50"

# catch up after a dropped connection
curl -H "Authorization: Bearer $TOKEN" \
     "localhost:3000/api/rooms/1/messages?after=900"
```

Response: `{ messages: [...], hasMore: boolean, nextCursor: number | null }` —
`messages` is ordered oldest → newest.

---

## Configuration

Copy `.env.example` to `.env`. Every value has a development default except
`JWT_SECRET`, which the server refuses to guess when `NODE_ENV=production`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | |
| `JWT_SECRET` | dev-only fallback | HS256 signing key — **required in production** |
| `JWT_TTL_SECONDS` | `86400` | Access token lifetime |
| `DATABASE_PATH` | `./data/chat.sqlite` | `:memory:` for a throwaway DB |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin12345` | Bootstrap admin, first boot only |
| `RATE_LIMIT_BURST` / `RATE_LIMIT_REFILL_PER_SEC` | `5` / `1` | Message sends, per user |
| `CONNECTION_OPS_BURST` / `CONNECTION_OPS_REFILL_PER_SEC` | `30` / `10` | Frames, per socket |
| `AUTH_RATE_LIMIT_BURST` / `AUTH_RATE_LIMIT_REFILL_PER_SEC` | `10` / `0.167` | Login attempts, per IP |

### Before deploying

1. Set a real `JWT_SECRET` (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`).
2. Change the bootstrap admin password.
3. Terminate TLS at a reverse proxy — `trust proxy` is already set so the auth
   throttle sees real client IPs.

---

## Testing

```bash
npm test
```

81 tests across three suites, all against the real stack — no mocks, and an
in-memory SQLite database per suite:

- **`test/unit.test.ts`** — password hashing, JWT verification (including a
  rejected `alg: none` forgery), mention parsing, the token bucket, migrations,
  foreign-key cascades, and keyset pagination invariants
- **`test/api.test.ts`** — the HTTP surface: registration and login, private-room
  isolation, invites, edit/delete permissions, and the admin interface
- **`test/ws.test.ts`** — handshake rejection, malformed-frame handling,
  broadcast, cross-room isolation, presence, multi-tab delivery, mentions,
  history pagination, rate limiting, and live disconnection on ban

`scripts/smoke.mjs` runs 30 end-to-end checks against a running server
(`npm run smoke -- http://localhost:3000`).
