import type { AppContext } from '../context.js';
import { config } from '../config.js';
import { errors } from '../types.js';
import type { Connection } from './hub.js';
import type { ClientFrame } from './protocol.js';
import { publishMessageDeleted, publishMessageEdited, publishNewMessage } from './publish.js';

/**
 * One handler per client frame type. Each returns the payload to send back in
 * the `ack`, and performs its own fan-out through the hub. Throwing an
 * AppError is the normal way to reject a frame; the caller turns it into an
 * `error` frame carrying the same code.
 */
type Handler<T extends ClientFrame> = (
  ctx: AppContext,
  conn: Connection,
  frame: T,
) => unknown;

type HandlerMap = { [K in ClientFrame['type']]: Handler<Extract<ClientFrame, { type: K }>> };

const handlers: HandlerMap = {
  ping: () => ({ serverTime: Date.now() }),

  'room.list': (ctx, conn) => ({
    rooms: ctx.roomService.list(conn.principal),
  }),

  'room.create': (ctx, conn, frame) => {
    const room = ctx.roomService.create(conn.principal, frame.data);

    // The creator is seated as owner by the repository; subscribe their socket
    // so they receive traffic without a separate join.
    ctx.hub.subscribe(conn, room.id);

    if (room.visibility === 'public') {
      // Let every connected client refresh its room list.
      for (const other of ctx.hub.all()) {
        ctx.hub.send(other, { type: 'room.created', data: { room } });
      }
    }
    return { room };
  },

  'room.join': (ctx, conn, frame) => {
    const { slug, roomId } = frame.data;
    // Must be an AppError, or the client gets an opaque `internal_error`
    // instead of being told what was wrong with the frame.
    if (slug === undefined && roomId === undefined) {
      throw errors.invalid('Provide either slug or roomId');
    }

    const { room, membership, alreadyMember } = ctx.roomService.join(conn.principal, {
      ...(roomId !== undefined ? { roomId } : {}),
      ...(slug !== undefined ? { slug } : {}),
    });

    ctx.hub.subscribe(conn, room.id);

    // Announce only on a genuine first join, not on a second tab opening.
    if (!alreadyMember) {
      ctx.hub.broadcast(
        room.id,
        {
          type: 'room.presence',
          data: {
            roomId: room.id,
            userId: conn.principal.userId,
            username: conn.principal.username,
            event: 'joined',
            role: membership.role,
          },
        },
        { exclude: conn },
      );
    }

    // Ship a first page of history with the join so the client can render
    // immediately instead of making a second round trip.
    const history = ctx.messageService.history(conn.principal, room.id, {
      limit: config.limits.historyPageSize,
    });

    return {
      room,
      membership,
      members: ctx.rooms.listMembers(room.id),
      online: ctx.hub.presenceInRoom(room.id),
      history,
    };
  },

  'room.leave': (ctx, conn, frame) => {
    const room = ctx.roomService.leave(conn.principal, frame.data.roomId);

    // Every socket this user has open should stop receiving the room.
    for (const other of ctx.hub.connectionsForUser(conn.principal.userId)) {
      ctx.hub.unsubscribe(other, room.id);
    }

    ctx.hub.broadcast(room.id, {
      type: 'room.presence',
      data: {
        roomId: room.id,
        userId: conn.principal.userId,
        username: conn.principal.username,
        event: 'left',
      },
    });

    return { roomId: room.id };
  },

  'message.send': (ctx, conn, frame) => {
    const result = ctx.messageService.send(
      conn.principal,
      frame.data.roomId,
      frame.data.body,
      frame.data.attachment,
    );

    // A targeted mention reaches the author's recipients on every socket they
    // have open, even if none is currently viewing this room.
    publishNewMessage(ctx, result, { excludeConnection: conn });
    return { message: result.message };
  },

  'message.edit': (ctx, conn, frame) => {
    const message = ctx.messageService.edit(conn.principal, frame.data.messageId, frame.data.body);

    publishMessageEdited(ctx, message);
    return { message };
  },

  'message.delete': (ctx, conn, frame) => {
    const message = ctx.messageService.delete(conn.principal, frame.data.messageId);

    publishMessageDeleted(ctx, message);
    return { messageId: message.id };
  },

  'history.fetch': (ctx, conn, frame) =>
    ctx.messageService.history(conn.principal, frame.data.roomId, {
      ...(frame.data.before !== undefined ? { before: frame.data.before } : {}),
      ...(frame.data.after !== undefined ? { after: frame.data.after } : {}),
      limit: frame.data.limit,
    }),

  'mentions.fetch': (ctx, conn, frame) =>
    ctx.messageService.mentions(conn.principal, {
      ...(frame.data.before !== undefined ? { before: frame.data.before } : {}),
      limit: frame.data.limit,
    }),

  typing: (ctx, conn, frame) => {
    // Cheap and ephemeral: never stored, and silently ignored if the user is
    // not in the room rather than erroring on a stale client.
    if (!conn.rooms.has(frame.data.roomId)) return { ok: false };

    ctx.hub.broadcast(
      frame.data.roomId,
      {
        type: 'typing',
        data: {
          roomId: frame.data.roomId,
          userId: conn.principal.userId,
          username: conn.principal.username,
          isTyping: frame.data.isTyping,
        },
      },
      { exclude: conn },
    );
    return { ok: true };
  },
};

export function dispatch(ctx: AppContext, conn: Connection, frame: ClientFrame): unknown {
  const handler = handlers[frame.type] as Handler<ClientFrame>;
  return handler(ctx, conn, frame);
}
