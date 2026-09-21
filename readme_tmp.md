What's there

src/            ~2,400 lines TypeScript (strict)
  auth/         scrypt hashing, JWT sign/verify
  db/           migrations + user/room/message repositories
  services/     business rules shared by both transports
  ws/           upgrade auth, hub (fan-out), handlers, zod protocol
  http/         REST routes + middleware
public/         chat client + admin console (no build step)
test/           81 tests · docs/DESIGN.md · scripts/smoke.mjs

Verification: tsc --noEmit clean · 81/81 tests pass · 30/30 end-to-end smoke checks against the compiled server · history confirmed surviving a restart.

Requirements

All four met, plus all three bonuses: @mentions (with an inbox), edit/delete, rate
limiting, and an admin conserve) or private(invite-only), with owner/moderator/member per room and a global admin role.

The history storage question — the short version

Full reasoning in docs/DESIGN.md §1; the three decisions that drove the schema:

Keyset pagination, not LIMIT/OFFSET. The usual argument is speed (OFFSET 10000
reads 10,000 rows to returbites in chat iscorrectness: offsets index into a result set that's changing underneath the
reader, so three messages page 1 make page 2 re-serve rows they've already seen. A cursor anchored to a message id makes duplicates and
skips impossible rather thtoincrement id, not atimestamp — two messages can share a millisecond.

Deletion is a tombstone. Hard-deleting breaks pagination cursors, dangles
references, and destroys tid the message that gotthem banned actually say?" is the first question after any moderation action. The
body is withheld at read tective. Edits snapshot theprior body into message_revisions for the same reason.

Mentions are relational, parsed once at write time. The alternative, WHERE body
LIKE '%@ada%', is a full snd gets @adam wrong.Resolution filters to current room members — mentioning a non-member would leak a
private room's existence a

SQLite's real ceiling is ount; the doc lays out themigration path (Postgres → monthly partitions → Redis cache → shard by room_id)
and why Hub.broadcast is tb/sub goes for multi-node.

Two things worth flagging

- Stateless JWTs can't be wise take up to 24h tobite. Paid for explicitly: every entry point re-reads the user from the DB, and
  banning force-closes liv
- Test-suite friction was real config, not a workaround. The login throttle and
  message limiter both corade the auth throttleconfigurable (production default unchanged: 10 attempts, then 1/6s) and reset
  buckets per-test where tntics rather thanthrottling.

Run it

npm install && npm run dev

localhost:3000/ (open two browser profiles to see live broadcast) ·
/admin as admin / adm

I did not commit — say the I had no browserautomation available here, so the two frontend pages are verified by serving correctly and by the wire  fully exercised, not by me clicking through them.