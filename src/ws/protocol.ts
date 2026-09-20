import { z } from 'zod';
import { config } from '../config.js';
import type { Message, Room, RoomRole } from '../types.js';
import type { RoomSummary } from '../db/rooms.js';

const { messageMaxLength, roomNameMaxLength, historyMaxPageSize, historyPageSize } = config.limits;

/**
 * Optional client-supplied correlation id. Echoed back on the ack/error so a
 * client can resolve the promise for a specific request over a shared socket.
 */
const requestId = z.string().min(1).max(64).optional();

const roomId = z.number().int().positive();
const messageId = z.number().int().positive();

export const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({ id: requestId, type: z.literal('ping') }),

  z.object({ id: requestId, type: z.literal('room.list') }),

  z.object({
    id: requestId,
    type: z.literal('room.create'),
    data: z.object({
      name: z.string().trim().min(1).max(roomNameMaxLength),
      visibility: z.enum(['public', 'private']).default('public'),
    }),
  }),

  z.object({
    id: requestId,
    type: z.literal('room.join'),
    // Join by slug (what a user types) or by id (what a client already holds).
    data: z.object({ slug: z.string().trim().min(1).optional(), roomId: roomId.optional() }),
  }),

  z.object({
    id: requestId,
    type: z.literal('room.leave'),
    data: z.object({ roomId }),
  }),

  z.object({
    id: requestId,
    type: z.literal('message.send'),
    data: z.object({
      roomId,
      body: z.string().min(1).max(messageMaxLength),
    }),
  }),

  z.object({
    id: requestId,
    type: z.literal('message.edit'),
    data: z.object({ messageId, body: z.string().min(1).max(messageMaxLength) }),
  }),

  z.object({
    id: requestId,
    type: z.literal('message.delete'),
    data: z.object({ messageId }),
  }),

  z.object({
    id: requestId,
    type: z.literal('history.fetch'),
    data: z.object({
      roomId,
      before: z.number().int().positive().optional(),
      after: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(historyMaxPageSize).default(historyPageSize),
    }),
  }),

  z.object({
    id: requestId,
    type: z.literal('mentions.fetch'),
    data: z.object({
      before: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(historyMaxPageSize).default(historyPageSize),
    }),
  }),

  z.object({
    id: requestId,
    type: z.literal('typing'),
    data: z.object({ roomId, isTyping: z.boolean() }),
  }),
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;
export type ClientFrameType = ClientFrame['type'];

/** Server -> client frames. Everything the client can ever receive. */
export type ServerFrame =
  | { type: 'ready'; data: { user: { id: number; username: string; role: string }; rooms: RoomSummary[] } }
  | { type: 'pong'; id?: string }
  | { type: 'ack'; id?: string; op: ClientFrameType; data: unknown }
  | { type: 'error'; id?: string; code: string; message: string; retryAfterMs?: number }
  | { type: 'message.new'; data: { message: Message } }
  | { type: 'message.edited'; data: { message: Message } }
  | { type: 'message.deleted'; data: { messageId: number; roomId: number; deletedAt: number } }
  | {
      type: 'room.presence';
      data: {
        roomId: number;
        userId: number;
        username: string;
        event: 'joined' | 'left';
        role?: RoomRole;
      };
    }
  | { type: 'mention'; data: { message: Message } }
  | { type: 'typing'; data: { roomId: number; userId: number; username: string; isTyping: boolean } }
  | { type: 'room.created'; data: { room: Room } }
  | { type: 'system'; data: { event: string; message: string; roomId?: number } };

/** WebSocket close codes in the application-private 4000-4999 range. */
export const CloseCode = {
  UNAUTHORIZED: 4001,
  PROTOCOL_ERROR: 4002,
  /** Terminal: the client should discard its token and stop reconnecting. */
  BANNED: 4003,
  /** Kicked, but still a valid account — the client may reconnect. */
  DISCONNECTED: 4004,
  RATE_LIMITED: 4029,
  SERVER_SHUTDOWN: 4500,
} as const;
