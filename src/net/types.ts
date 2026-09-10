/**
 * Network protocol types — deliberately transport-agnostic and free of any
 * three.js/DOM imports so the exact same definitions can be shared with a
 * Node/Bun/Colyseus authoritative server later.
 */

/** Minimal per-player state broadcast to everyone. */
export interface PlayerSnapshot {
  id: string;
  name: string;
  /** Chosen character from the library, so everyone sees the same figure. */
  skin: string;
  /** Set by the server for the holder of the reserved name. Never client-set. */
  admin?: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** A full or delta world snapshot stamped with the server time (ms). */
export interface WorldSnapshot {
  t: number;
  players: PlayerSnapshot[];
}

/** Local player intent sent up to the server. */
export interface InputCommand {
  seq: number;
  x: number;
  /** Height matters as soon as the world has hills — the lobby floor is flat. */
  y: number;
  z: number;
  yaw: number;
  t: number;
}

export type ClientMessage =
  | { type: 'join'; name: string; skin: string }
  | { type: 'input'; cmd: InputCommand }
  /**
   * Round-trip probe. `t` is the client's own clock and is echoed back untouched,
   * so latency is measured without the two clocks having to agree on anything.
   */
  | { type: 'ping'; t: number }
  | { type: 'leave' };

export type ServerMessage =
  /**
   * `admin` is decided by the server, once, from the name claimed at join. The
   * client is never asked and cannot assert it — a client-side flag would be a
   * suggestion, not a permission.
   */
  | { type: 'welcome'; id: string; t: number; admin: boolean }
  | { type: 'snapshot'; snapshot: WorldSnapshot }
  | { type: 'pong'; t: number }
  /** Sent when a claimed name was refused, so the UI can say why. */
  | { type: 'nameRejected'; name: string; reason: 'reserved' }
  | { type: 'playerLeft'; id: string };

export type ConnectionState = 'offline' | 'connecting' | 'online' | 'error';

/**
 * Pluggable transport. Swap NullTransport for WebSocketTransport (or a Colyseus
 * room adapter) without touching game code.
 */
export interface Transport {
  readonly state: ConnectionState;
  connect(): Promise<void>;
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): void;
  onState(handler: (state: ConnectionState) => void): void;
  close(): void;
}
