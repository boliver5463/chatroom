import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { errors } from '../../types.js';
import { disconnectUser } from '../../ws/server.js';
import { CloseCode } from '../../ws/protocol.js';
import { publishMessageDeleted } from '../../ws/publish.js';
import {
  asyncHandler,
  intParam,
  optionalIntQuery,
  principalOf,
  requireAdmin,
  requireAuth,
  validateBody,
} from '../middleware.js';

const banSchema = z.object({ banned: z.boolean() });
const roleSchema = z.object({ role: z.enum(['user', 'admin']) });
const archiveSchema = z.object({ archived: z.boolean() });

export function adminRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx), requireAdmin);

  router.get(
    '/stats',
    asyncHandler(async (_req, res) => {
      res.json({
        live: ctx.hub.stats,
        users: ctx.users.count(),
        rooms: ctx.rooms.listAll().length,
        rateLimiterKeys: {
          messages: ctx.messageLimiter.size,
          connections: ctx.connectionLimiter.size,
        },
        uptimeSeconds: Math.floor(process.uptime()),
      });
    }),
  );

  router.get(
    '/users',
    asyncHandler(async (req, res) => {
      const limit = optionalIntQuery(req, 'limit') ?? 50;
      const offset = Number(req.query['offset'] ?? 0);
      const search = typeof req.query['search'] === 'string' ? req.query['search'] : undefined;

      const { users, total } = ctx.users.list({
        limit: Math.min(limit, 200),
        offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
        ...(search ? { search } : {}),
      });

      // Annotate with live connection counts so the console shows who is on.
      res.json({
        total,
        users: users.map((user) => ({
          ...user,
          connections: ctx.hub.connectionsForUser(user.id).length,
        })),
      });
    }),
  );

  router.post(
    '/users/:userId/ban',
    validateBody(banSchema),
    asyncHandler(async (req, res) => {
      const principal = principalOf(req);
      const userId = intParam(req, 'userId');
      const { banned } = req.body as z.infer<typeof banSchema>;

      // Locking yourself out is never the intent, and there may be no other
      // admin left to undo it.
      if (userId === principal.userId) {
        throw errors.invalid('You cannot ban your own account');
      }
      if (!ctx.users.setBanned(userId, banned)) throw errors.notFound('User not found');

      // The ban has to reach an already-authenticated socket; JWTs are not
      // revocable, so we sever the connections instead.
      const dropped = banned
        ? disconnectUser(ctx, userId, 'Your account has been banned', CloseCode.BANNED)
        : 0;

      res.json({ ok: true, userId, banned, disconnectedSockets: dropped });
    }),
  );

  router.post(
    '/users/:userId/role',
    validateBody(roleSchema),
    asyncHandler(async (req, res) => {
      const principal = principalOf(req);
      const userId = intParam(req, 'userId');
      const { role } = req.body as z.infer<typeof roleSchema>;

      if (userId === principal.userId && role !== 'admin') {
        throw errors.invalid('You cannot demote your own account');
      }
      if (!ctx.users.setRole(userId, role)) throw errors.notFound('User not found');

      res.json({ ok: true, userId, role });
    }),
  );

  router.post(
    '/users/:userId/disconnect',
    asyncHandler(async (req, res) => {
      const userId = intParam(req, 'userId');
      const dropped = disconnectUser(ctx, userId, 'Disconnected by an administrator');
      res.json({ ok: true, disconnectedSockets: dropped });
    }),
  );

  router.get(
    '/rooms',
    asyncHandler(async (_req, res) => {
      res.json({
        rooms: ctx.rooms.listAll().map((room) => ({
          ...room,
          messageCount: ctx.messages.countInRoom(room.id),
          online: ctx.hub.presenceInRoom(room.id).length,
        })),
      });
    }),
  );

  router.post(
    '/rooms/:roomId/archive',
    validateBody(archiveSchema),
    asyncHandler(async (req, res) => {
      const roomId = intParam(req, 'roomId');
      const { archived } = req.body as z.infer<typeof archiveSchema>;

      if (!ctx.rooms.setArchived(roomId, archived)) throw errors.notFound('Room not found');

      if (archived) {
        ctx.hub.broadcast(roomId, {
          type: 'system',
          data: { event: 'room_archived', message: 'This room was archived', roomId },
        });
        // Stop delivering traffic for a room nobody may post to any more.
        ctx.hub.unsubscribeAll(roomId);
      }

      res.json({ ok: true, roomId, archived });
    }),
  );

  /**
   * Hard delete, cascading to messages. Archiving is the reversible option and
   * should be the default; this exists for content that must genuinely go.
   */
  router.delete(
    '/rooms/:roomId',
    asyncHandler(async (req, res) => {
      const roomId = intParam(req, 'roomId');

      ctx.hub.broadcast(roomId, {
        type: 'system',
        data: { event: 'room_deleted', message: 'This room was deleted', roomId },
      });
      ctx.hub.unsubscribeAll(roomId);

      if (!ctx.rooms.delete(roomId)) throw errors.notFound('Room not found');
      res.json({ ok: true, roomId });
    }),
  );

  router.delete(
    '/messages/:messageId',
    asyncHandler(async (req, res) => {
      // Admins pass canModerate for every room, so the normal service path
      // already covers this; going through it keeps the audit behaviour
      // (soft delete + revision history) identical.
      const message = ctx.messageService.delete(principalOf(req), intParam(req, 'messageId'));

      publishMessageDeleted(ctx, message);
      res.json({ ok: true, messageId: message.id });
    }),
  );

  return router;
}
