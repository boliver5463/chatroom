import type { Database } from 'better-sqlite3';
import { type GlobalRole, type User } from '../types.js';

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: GlobalRole;
  is_banned: number;
  created_at: number;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    isBanned: row.is_banned === 1,
    createdAt: row.created_at,
  };
}

export class UserRepository {
  constructor(private readonly db: Database) {}

  create(username: string, passwordHash: string, role: GlobalRole = 'user'): User {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO users (username, password_hash, role, is_banned, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      )
      .run(username, passwordHash, role, now);

    return {
      id: Number(info.lastInsertRowid),
      username,
      role,
      isBanned: false,
      createdAt: now,
    };
  }

  findById(id: number): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  findByUsername(username: string): User | null {
    const row = this.db
      .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(username) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  /** Returns the stored password hash, or null if the user does not exist. */
  getPasswordHash(username: string): { user: User; passwordHash: string } | null {
    const row = this.db
      .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(username) as UserRow | undefined;
    return row ? { user: toUser(row), passwordHash: row.password_hash } : null;
  }

  /**
   * Resolves a batch of @mention names in one query. Unknown names are simply
   * absent from the result — a typo'd mention is plain text, not an error.
   */
  findManyByUsernames(usernames: string[]): User[] {
    if (usernames.length === 0) return [];
    const placeholders = usernames.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM users WHERE username IN (${placeholders}) COLLATE NOCASE`)
      .all(...usernames) as UserRow[];
    return rows.map(toUser);
  }

  list(options: { limit: number; offset: number; search?: string }): {
    users: User[];
    total: number;
  } {
    const { limit, offset, search } = options;
    const like = search ? `%${search}%` : null;

    const where = like ? 'WHERE username LIKE ? COLLATE NOCASE' : '';
    const params = like ? [like] : [];

    const total = this.db
      .prepare(`SELECT COUNT(*) AS n FROM users ${where}`)
      .get(...params) as { n: number };

    const rows = this.db
      .prepare(`SELECT * FROM users ${where} ORDER BY id ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as UserRow[];

    return { users: rows.map(toUser), total: total.n };
  }

  setBanned(userId: number, banned: boolean): boolean {
    const info = this.db
      .prepare('UPDATE users SET is_banned = ? WHERE id = ?')
      .run(banned ? 1 : 0, userId);
    return info.changes > 0;
  }

  setRole(userId: number, role: GlobalRole): boolean {
    const info = this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    return info.changes > 0;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }
}
