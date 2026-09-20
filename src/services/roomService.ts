import { config } from '../config.js';
import { type RoomRepository, type RoomSummary, slugify } from '../db/rooms.js';
import {
  type AuthPrincipal,
  type Room,
  type RoomMembership,
  type RoomRole,
  type RoomVisibility,
  errors,
} from '../types.js';

/** Ranking used for "may this member act on that member?" checks. */
const ROLE_RANK: Record<RoomRole, number> = { member: 0, moderator: 1, owner: 2 };

export class RoomService {
  constructor(private readonly rooms: RoomRepository) {}

  create(
    principal: AuthPrincipal,
    input: { name: string; visibility?: RoomVisibility },
  ): Room {
    const name = input.name.trim();
    if (!name || name.length > config.limits.roomNameMaxLength) {
      throw errors.invalid(`Room name must be 1-${config.limits.roomNameMaxLength} characters`);
    }

    const slug = slugify(name);
    if (!slug) {
      throw errors.invalid('Room name must contain at least one letter or digit');
    }
    if (this.rooms.findBySlug(slug)) {
      throw errors.conflict(`A room with the slug "${slug}" already exists`);
    }

    return this.rooms.create({
      slug,
      name,
      visibility: input.visibility ?? 'public',
      createdBy: principal.userId,
    });
  }

  getRoomOrThrow(ref: { roomId?: number; slug?: string }): Room {
    const room =
      ref.roomId !== undefined
        ? this.rooms.findById(ref.roomId)
        : ref.slug !== undefined
          ? this.rooms.findBySlug(ref.slug)
          : null;

    if (!room) throw errors.notFound('Room not found');
    return room;
  }

  list(principal: AuthPrincipal): RoomSummary[] {
    return this.rooms.listVisibleTo(principal.userId, false);
  }

  /**
   * Joining is the authorization boundary: public rooms are self-serve, private
   * rooms require an existing membership row (created by an owner/moderator via
   * invite, or by an admin). Everything downstream just checks membership.
   */
  join(principal: AuthPrincipal, ref: { roomId?: number; slug?: string }): {
    room: Room;
    membership: RoomMembership;
    alreadyMember: boolean;
  } {
    const room = this.getRoomOrThrow(ref);

    if (room.archivedAt !== null) {
      throw errors.forbidden('This room is archived');
    }

    const existing = this.rooms.getMembership(room.id, principal.userId);
    if (existing) return { room, membership: existing, alreadyMember: true };

    if (room.visibility === 'private' && principal.role !== 'admin') {
      // Deliberately the same shape as a missing room would give a stranger:
      // we do not confirm that a private room by this name exists.
      throw errors.forbidden('This room is invite-only');
    }

    return { room, membership: this.rooms.addMember(room.id, principal.userId), alreadyMember: false };
  }

  leave(principal: AuthPrincipal, roomId: number): Room {
    const room = this.getRoomOrThrow({ roomId });
    const membership = this.rooms.getMembership(roomId, principal.userId);
    if (!membership) throw errors.invalid('You are not a member of this room');

    // An owner leaving would strand a private room with nobody able to manage
    // it, so require a handover first.
    if (membership.role === 'owner') {
      const otherMembers = this.rooms
        .listMembers(roomId)
        .filter((m) => m.userId !== principal.userId);

      if (otherMembers.length > 0) {
        throw errors.invalid('Transfer ownership before leaving, or archive the room');
      }
    }

    this.rooms.removeMember(roomId, principal.userId);
    return room;
  }

  /** Membership required to read or post; admins bypass both checks. */
  requireMembership(principal: AuthPrincipal, roomId: number): RoomMembership | null {
    const room = this.getRoomOrThrow({ roomId });
    const membership = this.rooms.getMembership(roomId, principal.userId);

    // Checked before membership so an admin's access does not depend on
    // whether they happen to have joined the room.
    if (principal.role === 'admin') return membership;

    if (!membership) throw errors.forbidden('Join the room first');
    if (room.archivedAt !== null) throw errors.forbidden('This room is archived');

    return membership;
  }

  /** True if the principal can moderate the room (kick, invite, delete messages). */
  canModerate(principal: AuthPrincipal, roomId: number): boolean {
    if (principal.role === 'admin') return true;
    const membership = this.rooms.getMembership(roomId, principal.userId);
    return membership !== null && ROLE_RANK[membership.role] >= ROLE_RANK.moderator;
  }

  requireModerator(principal: AuthPrincipal, roomId: number): void {
    if (!this.canModerate(principal, roomId)) {
      throw errors.forbidden('Requires room moderator or owner');
    }
  }

  /** Adds another user to a room. Used for inviting into private rooms. */
  invite(principal: AuthPrincipal, roomId: number, userId: number, role: RoomRole = 'member'): RoomMembership {
    this.requireModerator(principal, roomId);
    if (role === 'owner' && principal.role !== 'admin') {
      throw errors.forbidden('Only an admin can grant ownership directly');
    }
    return this.rooms.addMember(roomId, userId, role);
  }

  kick(principal: AuthPrincipal, roomId: number, userId: number): void {
    this.requireModerator(principal, roomId);

    const target = this.rooms.getMembership(roomId, userId);
    if (!target) throw errors.notFound('That user is not in this room');
    if (target.role === 'owner') throw errors.forbidden('The room owner cannot be removed');

    // A moderator must not be able to remove a peer moderator; only an
    // owner/admin outranks one.
    if (target.role === 'moderator' && principal.role !== 'admin') {
      const actor = this.rooms.getMembership(roomId, principal.userId);
      if (!actor || actor.role !== 'owner') {
        throw errors.forbidden('Only the room owner can remove a moderator');
      }
    }

    this.rooms.removeMember(roomId, userId);
  }

  members(principal: AuthPrincipal, roomId: number) {
    this.requireMembership(principal, roomId);
    return this.rooms.listMembers(roomId);
  }
}
