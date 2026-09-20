export type GlobalRole = 'user' | 'admin';
export type RoomRole = 'owner' | 'moderator' | 'member';
export type RoomVisibility = 'public' | 'private';

export interface User {
  id: number;
  username: string;
  role: GlobalRole;
  isBanned: boolean;
  createdAt: number;
}

/** What lands in a JWT and, after verification, on the socket/request. */
export interface AuthPrincipal {
  userId: number;
  username: string;
  role: GlobalRole;
}

export interface Room {
  id: number;
  slug: string;
  name: string;
  visibility: RoomVisibility;
  createdBy: number;
  createdAt: number;
  archivedAt: number | null;
}

export interface RoomMembership {
  roomId: number;
  userId: number;
  role: RoomRole;
  joinedAt: number;
}

export interface Message {
  id: number;
  roomId: number;
  userId: number;
  username: string;
  body: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  /** Usernames resolved from @mentions at write time. */
  mentions: string[];
}

/** Domain error carrying a stable machine-readable code for clients. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  unauthorized: (msg = 'Authentication required') => new AppError('unauthorized', msg, 401),
  forbidden: (msg = 'Not allowed') => new AppError('forbidden', msg, 403),
  notFound: (msg = 'Not found') => new AppError('not_found', msg, 404),
  conflict: (msg: string) => new AppError('conflict', msg, 409),
  invalid: (msg: string) => new AppError('invalid_request', msg, 400),
  rateLimited: (msg = 'Slow down') => new AppError('rate_limited', msg, 429),
};
