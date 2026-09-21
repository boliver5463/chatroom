# Deploying to Fly.io

Target: <https://chatroom.brentonoliver.com>

## Shape of the deployment

One machine, one volume, no horizontal scaling — ever, until the architecture
changes. Two constraints force this:

- The WebSocket hub (`src/ws/hub.ts`) keeps connections and room membership in
  process memory. A second machine means two populations of users who cannot
  see each other's messages.
- SQLite is a single file on a single attached volume (`src/db/index.ts`). It
  cannot be shared between machines, and it must never live on a network
  filesystem — WAL mode needs real shared memory, which NFS does not provide.

Scaling past one machine requires moving the hub to Redis pub/sub and the
database to Postgres. Until then, `fly scale count` stays at 1.

Roughly $3–5/month: `shared-cpu-1x` with 512 MB plus a 1 GB volume.

## Prerequisites

Install the CLI (PowerShell):

```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

Then authenticate:

```bash
fly auth login
```

## 1. Create the app

The app name is the global Fly namespace, so it must be unique. `fly.toml` uses
`brentonoliver-chatroom`; change it there if you want something else.

```bash
fly apps create brentonoliver-chatroom
```

Do **not** run `fly launch` — it regenerates `fly.toml` and will discard the
single-machine and volume settings already committed here.

## 2. Create the volume

```bash
fly volumes create chatroom_data --region iad --size 1 --app brentonoliver-chatroom
```

## 3. Set secrets — BEFORE the first deploy

This ordering matters and is not recoverable later.

`ensureBootstrapAdmin` (`src/services/authService.ts:85`) creates the admin
account on first boot **only if the username is not already taken**. If the
first deploy happens without `ADMIN_PASSWORD`, the account is created with the
default `admin12345`, and setting the secret afterwards changes nothing — the
user already exists. You would have to reset the password through the app or
wipe the volume.

Generate a signing key and set both secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

```bash
fly secrets set \
  JWT_SECRET='<paste the generated key>' \
  ADMIN_USERNAME='brent' \
  ADMIN_PASSWORD='<a real password>' \
  --app brentonoliver-chatroom
```

`JWT_SECRET` is mandatory: `src/config.ts:49` throws on boot when
`NODE_ENV=production` and it is unset, so a missing key shows up as a crash
loop rather than a silent insecure default.

Changing `JWT_SECRET` later invalidates every issued token and logs everyone
out. That is the correct lever if a key ever leaks.

## 4. Deploy

```bash
fly deploy --app brentonoliver-chatroom
```

Docker is not required locally — Fly builds remotely. To build on your own
machine instead, start Docker Desktop and add `--local-only`.

Confirm it came up:

```bash
fly status --app brentonoliver-chatroom
fly logs --app brentonoliver-chatroom
curl https://brentonoliver-chatroom.fly.dev/health
```

Expect `{"ok":true,...}` and a `[boot] created bootstrap admin` line in the
logs on the very first deploy only.

## 5. Custom domain

Request the certificate first — Fly prints the exact DNS records it wants:

```bash
fly certs add chatroom.brentonoliver.com --app brentonoliver-chatroom
```

Then add this record at whatever manages DNS for `brentonoliver.com`:

| Type | Name | Value |
|---|---|---|
| CNAME | `chatroom` | `brentonoliver-chatroom.fly.dev` |

A CNAME covers both IPv4 and IPv6 and survives Fly changing its IPs, which is
why it beats A/AAAA records here.

Watch for issuance (usually under a minute, occasionally longer):

```bash
fly certs show chatroom.brentonoliver.com --app brentonoliver-chatroom
```

### If DNS is on Cloudflare

Set the record to **DNS only** (grey cloud), not proxied.

The orange-cloud proxy puts a second hop in front of Fly's proxy, and
`app.set('trust proxy', 1)` (`src/http/app.ts:19`) trusts exactly one. With two
hops `req.ip` resolves to Fly's edge rather than the real client, which
silently collapses the per-IP login throttle (`src/config.ts:83`) into a single
shared bucket — every visitor in the world competing for ten attempts. The
brute-force protection stops working and nothing logs an error.

Proxying also breaks certificate issuance until DNS resolves to Fly directly.

## 6. Verify end to end

```bash
curl -I https://chatroom.brentonoliver.com/            # 200, and a Strict-Transport-Security header
curl -I https://chatroom.brentonoliver.com/index.html  # 301 -> /
curl -s https://chatroom.brentonoliver.com/health
```

Then the full wire contract against production:

```bash
ADMIN_USERNAME='brent' ADMIN_PASSWORD='<the password you set>' \
  node scripts/smoke.mjs https://chatroom.brentonoliver.com
```

This registers throwaway accounts and exercises auth, the WebSocket handshake,
broadcast, mentions, edits, history pagination and the admin API. It leaves
test users and messages behind, so run it once and then clean up from
`/admin`, or accept the noise.

Finally, open the app in two browser profiles and confirm messages cross
between them — that is the one thing no curl check covers.

- Client: <https://chatroom.brentonoliver.com/>
- Admin: <https://chatroom.brentonoliver.com/admin>

## Operations

### Logs and shell

```bash
fly logs --app brentonoliver-chatroom
fly ssh console --app brentonoliver-chatroom
```

### Backups

Fly snapshots volumes daily with five-day retention. That is a floor, not a
backup strategy — snapshots of a live SQLite file can capture a mid-write
state.

For a consistent copy, use SQLite's own backup API, which is safe against a
running writer:

```bash
fly ssh console --app brentonoliver-chatroom
apt-get update && apt-get install -y sqlite3
sqlite3 /data/chat.sqlite ".backup '/data/backup.sqlite'"
exit

fly ssh sftp get /data/backup.sqlite ./chat-backup.sqlite --app brentonoliver-chatroom
```

Worth automating off-machine before this holds anything you would miss.

### Deploys

`strategy = 'immediate'` in `fly.toml`: one machine holding one volume cannot
roll over itself, so each deploy is a few seconds of downtime. Clients receive
a `SERVER_SHUTDOWN` close code (`src/index.ts:57`) and reconnect with backoff.

### Restarting

```bash
fly apps restart brentonoliver-chatroom
```

### Things that will break it

- `fly scale count 2` — splits users across two hubs and two databases.
- Removing the volume mount — the database silently becomes ephemeral, and
  every deploy wipes all history.
- Putting CloudFront, Cloudflare proxy, or any second proxy in front — breaks
  the login rate limit as described above.
