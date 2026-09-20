import type { WebSocket } from 'ws';
import type { AuthPrincipal } from '../types.js';
import type { ServerFrame } from './protocol.js';

export interface Connection {
  readonly id: string;
  readonly socket: WebSocket;
  principal: AuthPrincipal;
  /** Rooms this socket is currently receiving events for. */
  readonly rooms: Set<number>;
  /** Set false by the heartbeat sweep, back to true by the pong handler. */
  isAlive: boolean;
  readonly connectedAt: number;
}

/**
 * In-memory registry of live sockets and their room subscriptions.
 *
 * Deliberately a single-process structure. The moment there are two server
 * instances, a socket on node A cannot see a message published on node B, so
 * `broadcast` is the seam where a Redis (or NATS) pub/sub adapter goes: publish
 * to a channel per room and have each node fan out to only its local sockets.
 * Keeping every send funnelled through this one method is what makes that a
 * contained change rather than a rewrite.
 */
export class Hub {
  private readonly connections = new Map<string, Connection>();
  /** One user may hold several sockets (multiple tabs or devices). */
  private readonly byUser = new Map<number, Set<Connection>>();
  private readonly byRoom = new Map<number, Set<Connection>>();

  add(connection: Connection): void {
    this.connections.set(connection.id, connection);

    let userSet = this.byUser.get(connection.principal.userId);
    if (!userSet) {
      userSet = new Set();
      this.byUser.set(connection.principal.userId, userSet);
    }
    userSet.add(connection);
  }

  remove(connection: Connection): void {
    this.connections.delete(connection.id);

    const userSet = this.byUser.get(connection.principal.userId);
    if (userSet) {
      userSet.delete(connection);
      if (userSet.size === 0) this.byUser.delete(connection.principal.userId);
    }

    for (const roomId of connection.rooms) {
      const roomSet = this.byRoom.get(roomId);
      if (!roomSet) continue;
      roomSet.delete(connection);
      if (roomSet.size === 0) this.byRoom.delete(roomId);
    }
    connection.rooms.clear();
  }

  subscribe(connection: Connection, roomId: number): void {
    connection.rooms.add(roomId);

    let roomSet = this.byRoom.get(roomId);
    if (!roomSet) {
      roomSet = new Set();
      this.byRoom.set(roomId, roomSet);
    }
    roomSet.add(connection);
  }

  unsubscribe(connection: Connection, roomId: number): void {
    connection.rooms.delete(roomId);

    const roomSet = this.byRoom.get(roomId);
    if (!roomSet) return;
    roomSet.delete(connection);
    if (roomSet.size === 0) this.byRoom.delete(roomId);
  }

  /** Drops every socket's subscription to a room (room archived or deleted). */
  unsubscribeAll(roomId: number): void {
    const roomSet = this.byRoom.get(roomId);
    if (!roomSet) return;
    for (const connection of roomSet) connection.rooms.delete(roomId);
    this.byRoom.delete(roomId);
  }

  send(connection: Connection, frame: ServerFrame): void {
    // 1 === WebSocket.OPEN. Writing to a closing socket throws, and a slow
    // client that has already gone away must not take down the broadcast loop.
    if (connection.socket.readyState !== 1) return;
    try {
      connection.socket.send(JSON.stringify(frame));
    } catch {
      // The 'close'/'error' handler will clean this connection up.
    }
  }

  /** Fan-out to every socket subscribed to a room. */
  broadcast(roomId: number, frame: ServerFrame, options: { exclude?: Connection } = {}): number {
    const roomSet = this.byRoom.get(roomId);
    if (!roomSet) return 0;

    // Serialize once; the payload is identical for every recipient.
    const payload = JSON.stringify(frame);
    let delivered = 0;

    for (const connection of roomSet) {
      if (connection === options.exclude) continue;
      if (connection.socket.readyState !== 1) continue;
      try {
        connection.socket.send(payload);
        delivered++;
      } catch {
        // Ignore; cleanup happens on the socket's own close event.
      }
    }
    return delivered;
  }

  /** Delivers to every socket a user has open, wherever they are subscribed. */
  sendToUser(userId: number, frame: ServerFrame): number {
    const userSet = this.byUser.get(userId);
    if (!userSet) return 0;

    const payload = JSON.stringify(frame);
    let delivered = 0;

    for (const connection of userSet) {
      if (connection.socket.readyState !== 1) continue;
      try {
        connection.socket.send(payload);
        delivered++;
      } catch {
        /* cleanup on close */
      }
    }
    return delivered;
  }

  connectionsForUser(userId: number): Connection[] {
    return [...(this.byUser.get(userId) ?? [])];
  }

  /** Distinct users currently subscribed to a room. */
  presenceInRoom(roomId: number): { userId: number; username: string }[] {
    const roomSet = this.byRoom.get(roomId);
    if (!roomSet) return [];

    const seen = new Map<number, string>();
    for (const connection of roomSet) {
      seen.set(connection.principal.userId, connection.principal.username);
    }
    return [...seen].map(([userId, username]) => ({ userId, username }));
  }

  all(): Connection[] {
    return [...this.connections.values()];
  }

  get stats(): { connections: number; users: number; rooms: number } {
    return {
      connections: this.connections.size,
      users: this.byUser.size,
      rooms: this.byRoom.size,
    };
  }
}
