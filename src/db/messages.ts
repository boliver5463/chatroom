import type { Database } from 'better-sqlite3';
import type { Message } from '../types.js';

interface MessageRow {
  id: number;
  room_id: number;
  user_id: number;
  username: string;
  body: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
}

export interface HistoryPage {
  /** Oldest -> newest, the order a client renders them in. */
  messages: Message[];
  /** True when older messages exist beyond this page. */
  hasMore: boolean;
  /** Pass back as `before` to fetch the next (older) page. Null when exhausted. */
  nextCursor: number | null;
}

export class MessageRepository {
  constructor(private readonly db: Database) {}

  /**
   * Writes the message and its mention rows atomically, so a reader can never
   * observe a message whose mentions have not landed yet.
   */
  insert(input: {
    roomId: number;
    userId: number;
    username: string;
    body: string;
    mentionUserIds: number[];
  }): Message {
    const now = Date.now();

    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare('INSERT INTO messages (room_id, user_id, body, created_at) VALUES (?, ?, ?, ?)')
        .run(input.roomId, input.userId, input.body, now);

      const messageId = Number(info.lastInsertRowid);

      if (input.mentionUserIds.length > 0) {
        const stmt = this.db.prepare(
          'INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)',
        );
        for (const userId of input.mentionUserIds) stmt.run(messageId, userId);
      }

      return messageId;
    });

    const id = tx();
    return {
      id,
      roomId: input.roomId,
      userId: input.userId,
      username: input.username,
      body: input.body,
      createdAt: now,
      editedAt: null,
      deletedAt: null,
      mentions: [],
    };
  }

  findById(id: number): Message | null {
    const row = this.db
      .prepare(
        `SELECT m.*, u.username FROM messages m
         JOIN users u ON u.id = m.user_id
         WHERE m.id = ?`,
      )
      .get(id) as MessageRow | undefined;

    if (!row) return null;
    const [message] = this.hydrate([row]);
    return message ?? null;
  }

  /**
   * Replaces the body, snapshots the previous one into message_revisions, and
   * rewrites the mention set (an edit can add or remove @mentions).
   */
  updateBody(id: number, body: string, mentionUserIds: number[]): Message | null {
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT body, deleted_at FROM messages WHERE id = ?').get(id) as
        | { body: string; deleted_at: number | null }
        | undefined;

      if (!existing || existing.deleted_at !== null) return false;

      const now = Date.now();
      this.db
        .prepare('INSERT INTO message_revisions (message_id, body, replaced_at) VALUES (?, ?, ?)')
        .run(id, existing.body, now);

      this.db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, now, id);

      this.db.prepare('DELETE FROM message_mentions WHERE message_id = ?').run(id);
      if (mentionUserIds.length > 0) {
        const stmt = this.db.prepare(
          'INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)',
        );
        for (const userId of mentionUserIds) stmt.run(id, userId);
      }
      return true;
    });

    return tx() ? this.findById(id) : null;
  }

  /**
   * Soft delete. The row stays so that pagination cursors, reply references,
   * and moderation history remain valid; the body is withheld on read.
   */
  softDelete(id: number): Message | null {
    const info = this.db
      .prepare('UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(Date.now(), id);

    return info.changes > 0 ? this.findById(id) : null;
  }

  /**
   * Keyset ("seek") pagination rather than LIMIT/OFFSET: the index on
   * (room_id, id DESC) turns each page into a single seek, and pages do not
   * shift or duplicate when new messages arrive mid-scroll.
   */
  listHistory(
    roomId: number,
    options: { before?: number; after?: number; limit: number },
  ): HistoryPage {
    const { before, after, limit } = options;

    // Fetch one extra row to learn whether another page exists without a COUNT.
    const probe = limit + 1;

    let rows: MessageRow[];
    if (after !== undefined) {
      // Forward fill, e.g. a client catching up after a dropped connection.
      rows = this.db
        .prepare(
          `SELECT m.*, u.username FROM messages m
           JOIN users u ON u.id = m.user_id
           WHERE m.room_id = ? AND m.id > ?
           ORDER BY m.id ASC LIMIT ?`,
        )
        .all(roomId, after, probe) as MessageRow[];

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        messages: this.hydrate(page),
        hasMore,
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      };
    }

    rows = this.db
      .prepare(
        `SELECT m.*, u.username FROM messages m
         JOIN users u ON u.id = m.user_id
         WHERE m.room_id = ? AND (? IS NULL OR m.id < ?)
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(roomId, before ?? null, before ?? null, probe) as MessageRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    // Query runs newest-first so the index is usable; clients want oldest-first.
    const ordered = page.slice().reverse();

    return {
      messages: this.hydrate(ordered),
      hasMore,
      nextCursor: hasMore ? (ordered[0]?.id ?? null) : null,
    };
  }

  /** "My mentions" inbox across every room the user can still see. */
  listMentionsForUser(userId: number, options: { before?: number; limit: number }): HistoryPage {
    const { before, limit } = options;
    const probe = limit + 1;

    const rows = this.db
      .prepare(
        `SELECT m.*, u.username FROM message_mentions mm
         JOIN messages m ON m.id = mm.message_id
         JOIN users u ON u.id = m.user_id
         JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = ?
         WHERE mm.user_id = ? AND m.deleted_at IS NULL AND (? IS NULL OR m.id < ?)
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(userId, userId, before ?? null, before ?? null, probe) as MessageRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const ordered = page.slice().reverse();

    return {
      messages: this.hydrate(ordered),
      hasMore,
      nextCursor: hasMore ? (ordered[0]?.id ?? null) : null,
    };
  }

  countInRoom(roomId: number): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND deleted_at IS NULL')
        .get(roomId) as { n: number }
    ).n;
  }

  /**
   * Attaches mention usernames to a page of rows with one extra query rather
   * than one per message, and blanks the body of soft-deleted messages so a
   * deletion is effective even though the row survives.
   */
  private hydrate(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const mentionRows = this.db
      .prepare(
        `SELECT mm.message_id, u.username FROM message_mentions mm
         JOIN users u ON u.id = mm.user_id
         WHERE mm.message_id IN (${placeholders})`,
      )
      .all(...ids) as { message_id: number; username: string }[];

    const byMessage = new Map<number, string[]>();
    for (const row of mentionRows) {
      const list = byMessage.get(row.message_id);
      if (list) list.push(row.username);
      else byMessage.set(row.message_id, [row.username]);
    }

    return rows.map((row) => ({
      id: row.id,
      roomId: row.room_id,
      userId: row.user_id,
      username: row.username,
      body: row.deleted_at === null ? row.body : '',
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
      mentions: byMessage.get(row.id) ?? [],
    }));
  }
}
