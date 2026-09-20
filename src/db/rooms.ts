import type { Database } from 'better-sqlite3';
import { type Room, type RoomMembership, type RoomRole, type RoomVisibility } from '../types.js';

interface RoomRow {
  id: number;
  slug: string;
  name: string;
  visibility: RoomVisibility;
  created_by: number;
  created_at: number;
  archived_at: number | null;
}

interface MemberRow {
  room_id: number;
  user_id: number;
  role: RoomRole;
  joined_at: number;
}

function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    visibility: row.visibility,
    createdBy: row.created_by,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

function toMembership(row: MemberRow): RoomMembership {
  return {
    roomId: row.room_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: row.joined_at,
  };
}

/** URL/mention-safe room identifier derived from the display name. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export interface RoomSummary extends Room {
  memberCount: number;
  /** Present when the listing was requested in the context of a user. */
  myRole?: RoomRole | null;
}

export class RoomRepository {
  constructor(private readonly db: Database) {}

  create(input: {
    slug: string;
    name: string;
    visibility: RoomVisibility;
    createdBy: number;
  }): Room {
    const now = Date.now();
    // Creating a room and seating its owner must be atomic: a room with no
    // owner would be unmanageable and, if private, unjoinable.
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO rooms (slug, name, visibility, created_by, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.slug, input.name, input.visibility, input.createdBy, now);

      const roomId = Number(info.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO room_members (room_id, user_id, role, joined_at)
           VALUES (?, ?, 'owner', ?)`,
        )
        .run(roomId, input.createdBy, now);

      return roomId;
    });

    const id = tx();
    return {
      id,
      slug: input.slug,
      name: input.name,
      visibility: input.visibility,
      createdBy: input.createdBy,
      createdAt: now,
      archivedAt: null,
    };
  }

  findById(id: number): Room | null {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined;
    return row ? toRoom(row) : null;
  }

  findBySlug(slug: string): Room | null {
    const row = this.db.prepare('SELECT * FROM rooms WHERE slug = ? COLLATE NOCASE').get(slug) as
      | RoomRow
      | undefined;
    return row ? toRoom(row) : null;
  }

  /**
   * Rooms the user may see: every public room, plus private rooms they belong
   * to. Admins get everything (`includeAll`).
   */
  listVisibleTo(userId: number, includeAll = false): RoomSummary[] {
    const visibilityClause = includeAll
      ? '1 = 1'
      : "(r.visibility = 'public' OR m.user_id IS NOT NULL)";

    const rows = this.db
      .prepare(
        `SELECT r.*,
                (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) AS member_count,
                m.role AS my_role
         FROM rooms r
         LEFT JOIN room_members m ON m.room_id = r.id AND m.user_id = ?
         WHERE r.archived_at IS NULL AND ${visibilityClause}
         ORDER BY r.name COLLATE NOCASE ASC`,
      )
      .all(userId) as (RoomRow & { member_count: number; my_role: RoomRole | null })[];

    return rows.map((row) => ({
      ...toRoom(row),
      memberCount: row.member_count,
      myRole: row.my_role,
    }));
  }

  /** Admin listing: includes archived rooms and ignores visibility. */
  listAll(): RoomSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.*,
                (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) AS member_count
         FROM rooms r
         ORDER BY r.id ASC`,
      )
      .all() as (RoomRow & { member_count: number })[];

    return rows.map((row) => ({ ...toRoom(row), memberCount: row.member_count }));
  }

  getMembership(roomId: number, userId: number): RoomMembership | null {
    const row = this.db
      .prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?')
      .get(roomId, userId) as MemberRow | undefined;
    return row ? toMembership(row) : null;
  }

  /** Idempotent: re-joining a room you are already in keeps your existing role. */
  addMember(roomId: number, userId: number, role: RoomRole = 'member'): RoomMembership {
    this.db
      .prepare(
        `INSERT INTO room_members (room_id, user_id, role, joined_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (room_id, user_id) DO NOTHING`,
      )
      .run(roomId, userId, role, Date.now());

    // Non-null: the row either already existed or we just inserted it.
    return this.getMembership(roomId, userId)!;
  }

  removeMember(roomId: number, userId: number): boolean {
    const info = this.db
      .prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?')
      .run(roomId, userId);
    return info.changes > 0;
  }

  setMemberRole(roomId: number, userId: number, role: RoomRole): boolean {
    const info = this.db
      .prepare('UPDATE room_members SET role = ? WHERE room_id = ? AND user_id = ?')
      .run(role, roomId, userId);
    return info.changes > 0;
  }

  listMembers(roomId: number): (RoomMembership & { username: string })[] {
    const rows = this.db
      .prepare(
        `SELECT rm.*, u.username
         FROM room_members rm
         JOIN users u ON u.id = rm.user_id
         WHERE rm.room_id = ?
         ORDER BY rm.joined_at ASC`,
      )
      .all(roomId) as (MemberRow & { username: string })[];

    return rows.map((row) => ({ ...toMembership(row), username: row.username }));
  }

  setArchived(roomId: number, archived: boolean): boolean {
    const info = this.db
      .prepare('UPDATE rooms SET archived_at = ? WHERE id = ?')
      .run(archived ? Date.now() : null, roomId);
    return info.changes > 0;
  }

  /** Hard delete. Cascades to members, messages, mentions, and revisions. */
  delete(roomId: number): boolean {
    return this.db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId).changes > 0;
  }
}
