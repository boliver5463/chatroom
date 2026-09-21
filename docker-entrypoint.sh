#!/bin/sh
# Boot wrapper: restore the database if this volume is empty, then run the app
# under Litestream so every commit is replicated as it happens.
set -e

# Replication is optional, exactly like the Giphy key. Without a bucket the app
# still boots and still persists to the Fly volume — it just has no off-box
# copy. Failing hard here would mean a missing secret takes the whole app down.
if [ -z "$BUCKET_NAME" ]; then
  echo "[litestream] BUCKET_NAME is unset — starting without replication"
  exec node dist/index.js
fi

# Only fires when /data/chat.sqlite is absent *and* a replica exists, i.e. a
# brand-new volume after a host failure. A no-op on every ordinary boot, so it
# can run unconditionally.
echo "[litestream] checking for a replica to restore from"
litestream restore -if-db-not-exists -if-replica-exists /data/chat.sqlite

# `-exec` makes the app a child of Litestream: signals are forwarded, and on
# SIGTERM Litestream performs a final sync after the app closes the database.
# It also means the app cannot outlive the replicator and silently run
# unreplicated.
exec litestream replicate -exec "node dist/index.js"
