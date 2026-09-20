import type { AppContext } from '../context.js';
import type { Message } from '../types.js';
import type { SendResult } from '../services/messageService.js';
import type { Connection } from './hub.js';

/**
 * Fan-out for message events, shared by the WebSocket handlers and the REST
 * routes. A message posted over HTTP must reach live sockets exactly as one
 * posted over the socket does, so both paths funnel through here.
 */
export function publishNewMessage(
  ctx: AppContext,
  result: SendResult,
  options: { excludeConnection?: Connection } = {},
): void {
  const { message, mentionedUserIds, everyone } = result;

  ctx.hub.broadcast(message.roomId, { type: 'message.new', data: { message } });

  for (const userId of mentionedUserIds) {
    ctx.hub.sendToUser(userId, { type: 'mention', data: { message } });
  }

  if (everyone) {
    ctx.hub.broadcast(
      message.roomId,
      { type: 'mention', data: { message } },
      options.excludeConnection ? { exclude: options.excludeConnection } : {},
    );
  }
}

export function publishMessageEdited(ctx: AppContext, message: Message): void {
  ctx.hub.broadcast(message.roomId, { type: 'message.edited', data: { message } });
}

export function publishMessageDeleted(ctx: AppContext, message: Message): void {
  ctx.hub.broadcast(message.roomId, {
    type: 'message.deleted',
    data: {
      messageId: message.id,
      roomId: message.roomId,
      deletedAt: message.deletedAt ?? Date.now(),
    },
  });
}
