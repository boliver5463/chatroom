import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import type { AppContext } from '../../context.js';
import { errors } from '../../types.js';
import {
  asyncHandler,
  intParam,
  optionalIntQuery,
  principalOf,
  requireAuth,
  validateBody,
} from '../middleware.js';
import {
  publishMessageDeleted,
  publishMessageEdited,
  publishNewMessage,
} from '../../ws/publish.js';

const createRoomSchema = z.object({
  name: z.string().trim().min(1).max(config.limits.roomNameMaxLength),
  visibility: z.enum(['public', 'private']).default('public'),
});

/**
 * Shape-only; lib/attachments.ts does the host allowlisting that matters, on
 * the same code path the WebSocket handler uses.
 */
const sendMessageSchema = z
  .object({
    body: z.string().max(config.limits.messageMaxLength).default(''),
    attachment: z
      .object({
        kind: z.literal('gif'),
        url: z.string().max(2048),
        width: z.number().int().positive().max(4096),
        height: z.number().int().positive().max(4096),
        alt: z.string().max(200).default(''),
      })
      .nullish(),
  })
  .refine((data) => data.body.trim().length > 0 || data.attachment != null, {
    message: 'Provide a body, an attachment, or both',
  });

/** An edit rewrites the caption; the attachment is immutable. */
const editMessageSchema = z.object({
  body: z.string().max(config.limits.messageMaxLength),
});

const inviteSchema = z.object({
  username: z.string().min(1).optional(),
  userId: z.number().int().positive().optional(),
  role: z.enum(['member', 'moderator']).default('member'),
});

export function roomRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({ rooms: ctx.roomService.list(principalOf(req)) });
    }),
  );

  router.post(
    '/',
    validateBody(createRoomSchema),
    asyncHandler(async (req, res) => {
      const room = ctx.roomService.create(
        principalOf(req),
        req.body as z.infer<typeof createRoomSchema>,
      );

      if (room.visibility === 'public') {
        for (const connection of ctx.hub.all()) {
          ctx.hub.send(connection, { type: 'room.created', data: { room } });
        }
      }
      res.status(201).json({ room });
    }),
  );

  router.get(
    '/:roomId',
    asyncHandler(async (req, res) => {
      const principal = principalOf(req);
      const roomId = intParam(req, 'roomId');
      const room = ctx.roomService.getRoomOrThrow({ roomId });

      const membership = ctx.rooms.getMembership(roomId, principal.userId);
      if (!membership && room.visibility === 'private' && principal.role !== 'admin') {
        throw errors.forbidden('This room is invite-only');
      }

      res.json({
        room,
        membership,
        memberCount: ctx.rooms.listMembers(roomId).length,
        online: ctx.hub.presenceInRoom(roomId),
      });
    }),
  );

  router.post(
    '/:roomId/join',
    asyncHandler(async (req, res) => {
      const principal = principalOf(req);
      const { room, membership, alreadyMember } = ctx.roomService.join(principal, {
        roomId: intParam(req, 'roomId'),
      });

      // Subscribe any sockets this user already has open, so a REST join takes
      // effect on their live connection without a reconnect.
      for (const connection of ctx.hub.connectionsForUser(principal.userId)) {
        ctx.hub.subscribe(connection, room.id);
      }

      if (!alreadyMember) {
        ctx.hub.broadcast(room.id, {
          type: 'room.presence',
          data: {
            roomId: room.id,
            userId: principal.userId,
            username: principal.username,
            event: 'joined',
            role: membership.role,
          },
        });
      }

      res.json({ room, membership });
    }),
  );

  router.post(
    '/:roomId/leave',
    asyncHandler(async (req, res) => {
      const principal = principalOf(req);
      const roomId = intParam(req, 'roomId');
      ctx.roomService.leave(principal, roomId);

      for (const connection of ctx.hub.connectionsForUser(principal.userId)) {
        ctx.hub.unsubscribe(connection, roomId);
      }

      ctx.hub.broadcast(roomId, {
        type: 'room.presence',
        data: {
          roomId,
          userId: principal.userId,
          username: principal.username,
          event: 'left',
        },
      });

      res.json({ ok: true });
    }),
  );

  router.get(
    '/:roomId/members',
    asyncHandler(async (req, res) => {
      const roomId = intParam(req, 'roomId');
      res.json({
        members: ctx.roomService.members(principalOf(req), roomId),
        online: ctx.hub.presenceInRoom(roomId),
      });
    }),
  );

  router.post(
    '/:roomId/members',
    validateBody(inviteSchema),
    asyncHandler(async (req, res) => {
      const principal = principalOf(req);
      const roomId = intParam(req, 'roomId');
      const { username, userId, role } = req.body as z.infer<typeof inviteSchema>;

      const target =
        userId !== undefined
          ? ctx.users.findById(userId)
          : username !== undefined
            ? ctx.users.findByUsername(username)
            : null;

      if (!target) throw errors.notFound('User not found');

      const membership = ctx.roomService.invite(principal, roomId, target.id, role);

      // An invited user who is already connected gets the room immediately.
      for (const connection of ctx.hub.connectionsForUser(target.id)) {
        ctx.hub.subscribe(connection, roomId);
        ctx.hub.send(connection, {
          type: 'system',
          data: { event: 'invited', message: `You were added to a room`, roomId },
        });
      }

      res.status(201).json({ membership });
    }),
  );

  router.delete(
    '/:roomId/members/:userId',
    asyncHandler(async (req, res) => {
      const roomId = intParam(req, 'roomId');
      const userId = intParam(req, 'userId');

      ctx.roomService.kick(principalOf(req), roomId, userId);

      for (const connection of ctx.hub.connectionsForUser(userId)) {
        ctx.hub.unsubscribe(connection, roomId);
        ctx.hub.send(connection, {
          type: 'system',
          data: { event: 'removed', message: 'You were removed from a room', roomId },
        });
      }

      ctx.hub.broadcast(roomId, {
        type: 'room.presence',
        data: {
          roomId,
          userId,
          username: ctx.users.findById(userId)?.username ?? 'unknown',
          event: 'left',
        },
      });

      res.json({ ok: true });
    }),
  );

  /**
   * History fetch. Keyset pagination via `before` (older) / `after` (newer);
   * see docs/DESIGN.md for why this is not offset-based.
   */
  router.get(
    '/:roomId/messages',
    asyncHandler(async (req, res) => {
      const before = optionalIntQuery(req, 'before');
      const after = optionalIntQuery(req, 'after');
      const limit = optionalIntQuery(req, 'limit');

      const page = ctx.messageService.history(principalOf(req), intParam(req, 'roomId'), {
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });

      res.json(page);
    }),
  );

  /** Posting over REST is handy for bots/integrations; it fans out identically. */
  router.post(
    '/:roomId/messages',
    validateBody(sendMessageSchema),
    asyncHandler(async (req, res) => {
      const { body, attachment } = req.body as z.infer<typeof sendMessageSchema>;
      const result = ctx.messageService.send(
        principalOf(req),
        intParam(req, 'roomId'),
        body,
        attachment,
      );

      publishNewMessage(ctx, result);
      res.status(201).json({ message: result.message });
    }),
  );

  return router;
}

export function messageRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  router.patch(
    '/:messageId',
    validateBody(editMessageSchema),
    asyncHandler(async (req, res) => {
      const { body } = req.body as z.infer<typeof editMessageSchema>;
      const message = ctx.messageService.edit(principalOf(req), intParam(req, 'messageId'), body);

      publishMessageEdited(ctx, message);
      res.json({ message });
    }),
  );

  router.delete(
    '/:messageId',
    asyncHandler(async (req, res) => {
      const message = ctx.messageService.delete(principalOf(req), intParam(req, 'messageId'));

      publishMessageDeleted(ctx, message);
      res.json({ ok: true, messageId: message.id });
    }),
  );

  return router;
}

/** GET /api/mentions — the authenticated user's mention inbox. */
export function mentionRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const before = optionalIntQuery(req, 'before');
      const limit = optionalIntQuery(req, 'limit');

      res.json(
        ctx.messageService.mentions(principalOf(req), {
          ...(before !== undefined ? { before } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
    }),
  );

  return router;
}
