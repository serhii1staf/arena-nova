/**
 * Network protocol types — deliberately transport-agnostic and free of any
 * three.js/DOM imports so the exact same definitions can be shared with a
 * Node/Bun/Colyseus authoritative server later.
 */

/** Minimal per-player state broadcast to everyone. */
export interface PlayerSnapshot {
  id: string;
  name: string;
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
  | { type: 'join'; name: string }
  | { type: 'input'; cmd: InputCommand }
  | { type: 'leave' };

export type ServerMessage =
  | { type: 'welcome'; id: string; t: number }
  | { type: 'snapshot'; snapshot: WorldSnapshot }
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
