# Design notes — the "whys"

This document explains the decisions behind the implementation, with the
chat-history storage question (requirement 4) covered in depth.

---

## 1. Storing chat history

### The shape of the problem

Chat history has an unusual access profile, and the storage design follows from it:

| Property | Consequence for the design |
|---|---|
| Writes are small, constant, append-only | Optimise inserts; never update in place |
| Reads are almost always "the newest N in this room" | One composite index does nearly all the work |
| Older pages are read by scrolling *backwards* | Pagination must be anchored, not offset |
| Messages are edited and deleted, but rarely | Mutation can be slow; reads must not pay for it |
| Deletion must not corrupt what surrounds it | Soft delete, not `DELETE` |

### The schema

```sql
messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic: id order == time order
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,                   -- epoch ms
  edited_at  INTEGER,                            -- NULL until edited
  deleted_at INTEGER,                            -- NULL until deleted (tombstone)
  -- All NULL for a plain text message. `body` stays NOT NULL, so a GIF sent
  -- without a caption stores ''; the "body or attachment" rule is enforced in
  -- MessageService rather than by a CHECK constraint.
  attachment_kind   TEXT CHECK (attachment_kind IN ('gif')),
  attachment_url    TEXT,
  attachment_width  INTEGER,
  attachment_height INTEGER,
  attachment_alt    TEXT
);
CREATE INDEX idx_messages_room_id ON messages (room_id, id DESC);
```

**Why a monotonic integer id and not a timestamp cursor.** Two messages can share
a millisecond. A cursor on `created_at` therefore either skips or repeats rows at
a page boundary. The autoincrement id is unique and strictly increasing, so it is
a total order — it sorts identically to time while remaining an exact cursor.
(In a distributed setup this becomes a Snowflake/ULID: still sortable, but
generated without a single sequence. The pagination code does not change.)

**Why `(room_id, id DESC)` is the only index that matters.** Every read is
"messages in *this* room, newest first." That index makes the common query a
single seek into the leaf pages followed by a sequential scan of exactly the rows
being returned — no sort, no filter, no scan of other rooms' traffic.

### Keyset pagination, not `LIMIT/OFFSET`

```sql
SELECT * FROM messages
WHERE room_id = ? AND id < ?      -- ? = cursor from the previous page
ORDER BY id DESC
LIMIT ?;
```

Two reasons, and the second is the one that actually bites:

1. **`OFFSET` gets slower the further you scroll.** The database must walk and
   discard every skipped row: `OFFSET 10000` reads 10,000 rows to return 50. A
   keyset seek is O(log n) regardless of depth.
2. **`OFFSET` is *wrong* in a live chat.** Offsets are positions in a result set
   that is changing underneath the reader. If three messages arrive while a user
   is reading page 1, then page 2 at `OFFSET 50` re-serves three rows they have
   already seen. With a keyset cursor the anchor is a specific message, so
   concurrent writes cannot shift the window. Duplicates and skips become
   impossible rather than merely unlikely.

The server fetches `limit + 1` rows to compute `hasMore` without a second
`COUNT(*)` query, then returns the page oldest-first (the order a client renders)
while the index is still read newest-first.

`after` is the mirror image, for a client catching up after a dropped connection:
`WHERE id > ? ORDER BY id ASC`. The client remembers the last id it rendered, and
reconnect becomes one query instead of a full reload.

### Deletion is a tombstone

`deleted_at` is set; the row stays. Hard-deleting would:

- **break pagination cursors** — a client holding `before: 500` on a deleted row
  gets an empty or wrong page;
- **break referential context** — replies and quotes would dangle;
- **destroy the moderation trail** — "what did the message that got them banned
  actually say?" is the first question asked after any moderation action.

The body is withheld at read time (`hydrate()` returns `''` when `deleted_at` is
set), so deletion is *effective* even though the row survives. A separate
retention job can hard-purge tombstones after the legal window — that is a
deliberate, scheduled operation, not a side effect of a user tapping "delete."

The same applies to attachments: `hydrate()` returns a null attachment for a
tombstoned row. Withholding the body but leaving the image URL would make
"delete" a no-op for the one kind of message where the image *is* the content.

### Attachments are allowlisted, not just validated

A GIF is stored as five nullable columns on `messages` rather than a side
table — it is 0-or-1 per message and always read with it, so a join would buy
nothing.

The URL is checked against a host allowlist (`media*.giphy.com`, `i.giphy.com`,
https only) at write time, in `lib/attachments.ts`, on the one code path both
the REST and WebSocket senders funnel through. This is the part that matters.
An arbitrary attacker-chosen URL rendered in an `<img>` is not a cosmetic
problem: every member who opens the room silently issues a GET to it, which
turns a message into an IP and user-agent harvester aimed at a private room.
Checking the URL *parses* would not catch that; checking *who serves it* does.
A `Content-Security-Policy` with a matching `img-src` backs this up in the
browser, so a bad row that somehow got stored still would not load.

Attachments are also immutable. Edits rewrite the caption only — letting
someone swap the image under a message that people have already read and
reacted to is a straightforward abuse vector, and the revision trail that
covers edited *text* would not cover it.

### Edits keep an audit trail

`message_revisions` receives the previous body on every edit. Edited text is
otherwise unrecoverable, and "they edited it after I reported it" is a real
moderation scenario. The table is only written on the rare edit path, so the
common case pays nothing.

### Mentions are relational, not a `LIKE` scan

```sql
message_mentions (message_id, user_id, PRIMARY KEY (message_id, user_id));
CREATE INDEX idx_mentions_user ON message_mentions (user_id, message_id DESC);
```

Mentions are parsed **once at write time** and stored as rows. The alternative —
`WHERE body LIKE '%@ada%'` at read time — is a full table scan per query, cannot
use an index, and gets `@adam` wrong. With the table, "my mentions" is an index
seek on a column that is already sorted the way the inbox displays.

Resolution deliberately filters to **current room members**: mentioning a
non-member neither notifies them nor records a row, because doing so would leak
the existence and content of a private room to an outsider.

### Why SQLite here, and what changes at scale

SQLite is the right call for this deliverable: zero-configuration, the schema and
migrations are inspectable in one file, and the test suite runs against a real
database in memory rather than a mock. With WAL enabled, readers do not block the
writer, which is enough for a single-node server.

Its actual ceiling is **one writer process**. That is what forces a change, not
row count. Migration path, in the order the pressure appears:

| Pressure | Change |
|---|---|
| More than one app node | **PostgreSQL.** The schema ports as-is (`BIGSERIAL`, `TIMESTAMPTZ`); the repository layer is the only code that moves. |
| History outgrows working memory | **Partition `messages` by month.** Reads target recent partitions; old ones roll to cheap storage. Keyset pagination is partition-friendly — the cursor is still just `id`. |
| Room list / recent messages read-hot | **Cache the last ~100 messages per room in Redis** (a capped list). Hot reads stop touching Postgres entirely; the DB stays the system of record. |
| Write volume beyond one primary | **Shard by `room_id`.** A room is a natural shard key: all its traffic is co-located, and cross-room queries (the mentions inbox) are rare and can scatter-gather. |
| Search over history | A separate index (Postgres FTS, or OpenSearch). Never `LIKE` over the primary table. |

What I would *not* do early: reach for Cassandra/Scylla. They suit this write
pattern, but they trade away the transactional integrity that makes
"message + its mentions land atomically" a one-line guarantee here.

---

## 2. Real-time transport

**Auth happens during the HTTP upgrade**, before the WebSocket state machine
exists. An unauthenticated peer gets a `401` and a closed TCP connection, never a
socket that must be tracked and policed.

**Tokens travel via the `Sec-WebSocket-Protocol` header**, not a query string.
Browsers cannot set `Authorization` on a WebSocket handshake, so the common
workaround is `?token=` — but URLs land in proxy logs, server access logs, and
`Referer` headers. The subprotocol carries it out of band. Query-string tokens
still work, for `curl`/`wscat` convenience.

**The hub is the single fan-out seam.** Every server→client send goes through
`Hub.broadcast` / `Hub.sendToUser`. That is deliberate: the hub is in-memory and
single-process, so a second node would not see the first node's sockets. Because
all fan-out funnels through two methods, adding Redis pub/sub is a contained
change — publish to a channel per room, and have each node deliver only to its
local subscribers — rather than a rewrite.

**Heartbeats are not optional.** A TCP connection stays "open" long after the
peer is gone (closed laptop, NAT timeout). Without the ping/pong sweep those
sockets accumulate in the hub forever, consuming memory and receiving broadcasts
nobody reads. The sweep terminates anything that misses a round.

**A user is a set of sockets, not one socket.** Multiple tabs and devices are
normal, so the hub indexes connections by user. This drives real behaviour:
mentions reach every tab, presence "left" fires only when the *last* socket
closes, and the rate limiter is keyed by user so a second tab does not buy a
second budget.

---

## 3. Authentication and authorization

**JWT over server-side sessions.** The WebSocket handshake needs a credential
that can be checked in one step without a session round trip, and stateless
tokens let the server scale horizontally without shared session storage.

**The cost of stateless tokens is revocation**, and that cost is paid explicitly:
a JWT stays cryptographically valid until it expires, so a ban would otherwise
not take effect for up to 24 hours. Two mitigations, both tested:

1. Every authenticated entry point (`requireAuth`, the WS upgrade) re-reads the
   user from the database and rejects banned or deleted accounts. The token
   proves identity; the database decides current standing.
2. Banning force-closes the user's live sockets (code `4003`), because an
   already-established connection never passes through the upgrade check again.

**scrypt for passwords**, with self-describing parameters (`scrypt$N$r$p$salt$hash`)
so the cost can be raised later without invalidating existing hashes. Chosen over
bcrypt/argon2 only to avoid a second native dependency. Verification is
`timingSafeEqual`, and login runs a dummy hash for unknown users so response
timing does not reveal which accounts exist.

**Algorithm pinning** (`algorithms: ['HS256']`) on verification. Without it, a
forged header claiming `alg: none` lets the attacker choose how their own token
is validated. There is a test for this.

**Joining is the authorization boundary.** Public rooms are self-serve; private
rooms require a membership row created by an owner/moderator. Everything
downstream — posting, reading history, being mentioned — checks membership only.
One rule, enforced in one place, rather than a visibility check scattered across
every handler.

Edit and delete are deliberately asymmetric: **only the author may edit**, while
authors, room moderators and admins may delete. Moderation needs to remove
content; rewriting someone else's words under their own name is a different and
far more dangerous power.

---

## 4. Rate limiting

A **token bucket**, keyed by user, with a small burst and a steady refill.

Why a bucket rather than a fixed window: real chat is bursty — people paste three
lines at once, then go quiet. A fixed window either blocks that legitimate burst
or, if sized to allow it, permits double the intended rate across a window
boundary. A bucket allows the burst and still converges on the sustained rate,
which is the thing that actually stops a spammer.

Buckets are computed lazily on access, so there is no timer per user and idle
keys cost nothing until the periodic sweep collects them.

Four separate limits, because they defend against different things:

| Limit | Key | Defends against |
|---|---|---|
| `messageRateLimit` (5 burst, 1/s) | user id | Chat spam |
| `connectionRateLimit` (30 burst, 10/s) | socket id | Frame floods — checked **before** JSON parsing, so garbage cannot burn CPU |
| `authRateLimit` (10, then 1/6s) | IP address | Credential brute force |
| `giphyRateLimit` (15 burst, 1/s) | user id | Burning the Giphy API quota — each search is an upstream call someone else bills |

Keying messages by **user** rather than by socket matters: keying by socket would
let one account open five tabs and get five times the budget. There is a test for
exactly that.

---

## 5. What is deliberately not built

Honest scope boundaries rather than silent gaps:

- **No horizontal scaling.** Single-process hub. Section 2 describes the seam.
- **No refresh tokens.** One 24-hour access token. A production system wants
  short-lived access tokens plus rotating refresh tokens.
- **No delivery guarantees.** Broadcast is best-effort: a client offline at send
  time gets the message from history on reconnect (`after` cursor), not from a
  queue. Per-user delivery receipts would need an outbox table.
- **No TLS.** Terminate at a reverse proxy; `trust proxy` is already set so the
  auth throttle sees real client IPs.
- **No full-text search, threads, reactions, file uploads, or read receipts.**
  GIFs are *linked*, not uploaded — the bytes stay on Giphy's CDN and the row
  holds a URL. Accepting user uploads is a different problem (storage,
  scanning, quotas, content-type sniffing) and is not in scope.
- **`typing` is not persisted or rate-limited separately.** It is ephemeral and
  cheap, and the per-connection bucket already covers it. The client throttles to
  one frame per 2 s.
