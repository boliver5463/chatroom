import BetterSqlite3, { type Database } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { migrate } from './migrations.js';

export function openDatabase(path: string = config.databasePath): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const db = new BetterSqlite3(path);

  // WAL lets readers (history fetches) run concurrently with the writer
  // (incoming messages) instead of blocking on it.
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  // NORMAL trades an fsync per commit for an fsync per checkpoint. With WAL
  // that is still crash-safe; only an OS-level crash can lose recent commits.
  db.pragma('synchronous = NORMAL');
  // Not on by default in SQLite, and every ON DELETE CASCADE above needs it.
  db.pragma('foreign_keys = ON');
  // Wait rather than throwing SQLITE_BUSY if a write is briefly in flight.
  db.pragma('busy_timeout = 5000');

  migrate(db);
  return db;
}

let singleton: Database | null = null;

/** Process-wide handle used by the HTTP and WebSocket layers. */
export function getDb(): Database {
  if (!singleton) singleton = openDatabase();
  return singleton;
}

export function closeDb(): void {
  singleton?.close();
  singleton = null;
}
