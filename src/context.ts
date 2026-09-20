import type { Database } from 'better-sqlite3';
import { config } from './config.js';
import { MessageRepository } from './db/messages.js';
import { RoomRepository } from './db/rooms.js';
import { UserRepository } from './db/users.js';
import { TokenBucketRateLimiter } from './lib/rateLimiter.js';
import { AuthService } from './services/authService.js';
import { MessageService } from './services/messageService.js';
import { RoomService } from './services/roomService.js';
import { Hub } from './ws/hub.js';

export interface AppContext {
  db: Database;
  users: UserRepository;
  rooms: RoomRepository;
  messages: MessageRepository;
  hub: Hub;
  messageLimiter: TokenBucketRateLimiter;
  connectionLimiter: TokenBucketRateLimiter;
  auth: AuthService;
  roomService: RoomService;
  messageService: MessageService;
}

/**
 * Single composition root. Everything is constructed here and passed down, so
 * tests can build an isolated context over an in-memory database instead of
 * reaching for module-level singletons.
 */
export function createContext(db: Database): AppContext {
  const users = new UserRepository(db);
  const rooms = new RoomRepository(db);
  const messages = new MessageRepository(db);

  const messageLimiter = new TokenBucketRateLimiter(
    config.messageRateLimit.burst,
    config.messageRateLimit.refillPerSecond,
  );
  const connectionLimiter = new TokenBucketRateLimiter(
    config.connectionRateLimit.burst,
    config.connectionRateLimit.refillPerSecond,
  );

  const auth = new AuthService(users);
  const roomService = new RoomService(rooms);
  const messageService = new MessageService(messages, rooms, users, roomService, messageLimiter);

  return {
    db,
    users,
    rooms,
    messages,
    hub: new Hub(),
    messageLimiter,
    connectionLimiter,
    auth,
    roomService,
    messageService,
  };
}
