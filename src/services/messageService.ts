import { config } from '../config.js';
import type { HistoryPage, MessageRepository } from '../db/messages.js';
import type { RoomRepository } from '../db/rooms.js';
import type { UserRepository } from '../db/users.js';
import { type AttachmentInput, parseAttachment } from '../lib/attachments.js';
import { parseMentions } from '../lib/mentions.js';
import type { TokenBucketRateLimiter } from '../lib/rateLimiter.js';
import { type AuthPrincipal, type Message, type MessageAttachment, errors } from '../types.js';
import type { RoomService } from './roomService.js';

export interface SendResult {
  message: Message;
  /** Members to notify individually, already filtered to room members. */
  mentionedUserIds: number[];
  everyone: boolean;
}

export class MessageService {
  constructor(
    private readonly messages: MessageRepository,
    private readonly rooms: RoomRepository,
    private readonly users: UserRepository,
    private readonly roomService: RoomService,
    private readonly rateLimiter: TokenBucketRateLimiter,
  ) {}

  /**
   * Resolves @names to user ids, keeping only people who are actually in the
   * room. Mentioning a non-member would otherwise leak the existence and
   * contents of a private room to an outsider.
   */
  private resolveMentions(roomId: number, body: string): { userIds: number[]; everyone: boolean } {
    const parsed = parseMentions(body);
    if (parsed.usernames.length === 0) return { userIds: [], everyone: parsed.everyone };

    const matched = this.users.findManyByUsernames(parsed.usernames);
    if (matched.length === 0) return { userIds: [], everyone: parsed.everyone };

    const memberIds = new Set(this.rooms.listMembers(roomId).map((m) => m.userId));
    return {
      userIds: matched.filter((u) => memberIds.has(u.id)).map((u) => u.id),
      everyone: parsed.everyone,
    };
  }

  /**
   * `rawBody` doubles as the caption when an attachment is present, so either
   * one alone is a valid message — but not neither.
   */
  send(
    principal: AuthPrincipal,
    roomId: number,
    rawBody: string,
    attachmentInput?: AttachmentInput | null,
  ): SendResult {
    this.roomService.requireMembership(principal, roomId);

    const body = rawBody.trim();
    // Validated before the rate limit is charged: a malformed attachment is a
    // client bug, and shouldn't cost the user a token.
    const attachment: MessageAttachment | null = attachmentInput
      ? parseAttachment(attachmentInput)
      : null;

    if (!body && !attachment) throw errors.invalid('Message must have a body or an attachment');
    if (body.length > config.limits.messageMaxLength) {
      throw errors.invalid(`Message exceeds ${config.limits.messageMaxLength} characters`);
    }

    // Keyed by user, not by socket: opening five tabs must not buy five times
    // the send budget.
    const decision = this.rateLimiter.consume(`user:${principal.userId}`);
    if (!decision.allowed) {
      const err = errors.rateLimited(
        `Sending too fast. Try again in ${Math.ceil(decision.retryAfterMs / 1000)}s`,
      );
      // Surfaced to the client so it can back off precisely.
      (err as { retryAfterMs?: number }).retryAfterMs = decision.retryAfterMs;
      throw err;
    }

    const { userIds, everyone } = this.resolveMentions(roomId, body);

    const stored = this.messages.insert({
      roomId,
      userId: principal.userId,
      username: principal.username,
      body,
      mentionUserIds: userIds,
      attachment,
    });

    // Re-read so the broadcast payload carries resolved mention usernames.
    const message = this.messages.findById(stored.id) ?? stored;

    // Don't notify yourself for your own @mention.
    return {
      message,
      mentionedUserIds: userIds.filter((id) => id !== principal.userId),
      everyone,
    };
  }

  /**
   * Only the author may edit. Moderators can delete, but rewriting someone
   * else's words under their name is a different and much worse power.
   *
   * An edit rewrites the caption only. The attachment is immutable: swapping
   * the image under an existing message would let an innocuous post that
   * people already reacted to turn into something else after the fact.
   */
  edit(principal: AuthPrincipal, messageId: number, rawBody: string): Message {
    const existing = this.messages.findById(messageId);
    if (!existing) throw errors.notFound('Message not found');
    if (existing.deletedAt !== null) throw errors.invalid('Cannot edit a deleted message');
    if (existing.userId !== principal.userId) {
      throw errors.forbidden('You can only edit your own messages');
    }

    this.roomService.requireMembership(principal, existing.roomId);

    const body = rawBody.trim();
    // Emptying the caption is fine when the GIF still carries the message;
    // emptying a text-only message would leave nothing at all.
    if (!body && !existing.attachment) throw errors.invalid('Message body cannot be empty');
    if (body.length > config.limits.messageMaxLength) {
      throw errors.invalid(`Message exceeds ${config.limits.messageMaxLength} characters`);
    }
    if (body === existing.body) return existing;

    const { userIds } = this.resolveMentions(existing.roomId, body);
    const updated = this.messages.updateBody(messageId, body, userIds);
    if (!updated) throw errors.invalid('Message could not be edited');

    return updated;
  }

  /** Author, room moderator/owner, or global admin. */
  delete(principal: AuthPrincipal, messageId: number): Message {
    const existing = this.messages.findById(messageId);
    if (!existing) throw errors.notFound('Message not found');
    if (existing.deletedAt !== null) return existing;

    const isAuthor = existing.userId === principal.userId;
    if (!isAuthor && !this.roomService.canModerate(principal, existing.roomId)) {
      throw errors.forbidden('You can only delete your own messages');
    }
    if (isAuthor) this.roomService.requireMembership(principal, existing.roomId);

    const deleted = this.messages.softDelete(messageId);
    if (!deleted) throw errors.invalid('Message could not be deleted');
    return deleted;
  }

  history(
    principal: AuthPrincipal,
    roomId: number,
    options: { before?: number; after?: number; limit?: number },
  ): HistoryPage {
    this.roomService.requireMembership(principal, roomId);

    const limit = Math.min(
      options.limit ?? config.limits.historyPageSize,
      config.limits.historyMaxPageSize,
    );

    return this.messages.listHistory(roomId, {
      ...(options.before !== undefined ? { before: options.before } : {}),
      ...(options.after !== undefined ? { after: options.after } : {}),
      limit,
    });
  }

  mentions(principal: AuthPrincipal, options: { before?: number; limit?: number }): HistoryPage {
    const limit = Math.min(
      options.limit ?? config.limits.historyPageSize,
      config.limits.historyMaxPageSize,
    );

    return this.messages.listMentionsForUser(principal.userId, {
      ...(options.before !== undefined ? { before: options.before } : {}),
      limit,
    });
  }
}
