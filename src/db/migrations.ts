import type { Database } from 'better-sqlite3';

/**
 * Forward-only migrations keyed by SQLite's `user_version` pragma.
 * Index i runs to move the schema from version i to version i+1, so entries
 * are append-only: never edit or reorder one that has shipped.
 */
const MIGRATIONS: string[] = [
  // 0 -> 1: initial schema
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    is_banned     INTEGER NOT NULL DEFAULT 0 CHECK (is_banned IN (0,1)),
    created_at    INTEGER NOT NULL
  );
  -- NOCASE unique index: "Alice" and "alice" are the same account.
  CREATE UNIQUE INDEX idx_users_username ON users (username COLLATE NOCASE);

  CREATE TABLE rooms (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT    NOT NULL COLLATE NOCASE,
    name        TEXT    NOT NULL,
    visibility  TEXT    NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
    created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE UNIQUE INDEX idx_rooms_slug ON rooms (slug COLLATE NOCASE);

  CREATE TABLE room_members (
    room_id   INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner','moderator','member')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );
  -- Powers "which rooms am I in?" without scanning the table.
  CREATE INDEX idx_room_members_user ON room_members (user_id);

  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at  INTEGER,
    deleted_at INTEGER
  );
  -- The one index that matters: keyset pagination reads (room_id, id DESC).
  CREATE INDEX idx_messages_room_id ON messages (room_id, id DESC);

  -- Mentions are extracted once at write time and stored relationally so that
  -- "show me my mentions" is an index seek instead of a LIKE '%@me%' scan.
  CREATE TABLE message_mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX idx_mentions_user ON message_mentions (user_id, message_id DESC);

  -- Append-only audit of edits, so moderation can see what a message said
  -- before it was changed. Written only when an edit actually happens.
  CREATE TABLE message_revisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    body        TEXT    NOT NULL,
    replaced_at INTEGER NOT NULL
  );
  CREATE INDEX idx_revisions_message ON message_revisions (message_id, id DESC);
  `,
];

export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;

  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    if (!sql) continue;
    // DDL + version bump in one transaction: a crash mid-migration rolls back
    // rather than leaving user_version out of sync with the actual schema.
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${version} -> ${version + 1} failed: ${String(err)}`);
    }
  }
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;
