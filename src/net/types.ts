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
  /**
   * Round-trip time in ms, as measured by *that* player's client and relayed by
   * the server so everyone can see everyone's connection quality. A client cannot
   * observe anybody else's latency, so this is the only way the number can exist
   * at all; the server clamps it, because a client can claim whatever it likes.
   * Absent (or 0) means "not measured yet", not "0 ms" — the UI shows it as
   * unknown rather than inventing a perfect connection.
   */
  ping?: number;
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
  /**
   * The sender's own smoothed round-trip time in ms, so the server can hand it to
   * everyone else in the snapshot.
   *
   * It rides on `input` rather than getting a message of its own: input already
   * flows at 20 Hz for every connected client whether they move or not, the value
   * only changes about once a second, and the server has to touch this attachment
   * on every input anyway — so reporting latency costs one number in a frame that
   * was already being sent and parsed. A dedicated message would add a protocol
   * type, a second write of the same attachment and a second wake of the room, all
   * to carry less information than the field it replaces. Optional, so an older
   * client that never sends it is simply reported as unmeasured.
   */
  ping?: number;
}

export type ClientMessage =
  /**
   * `owner` is a stable per-install token. It is consulted for one purpose only —
   * recognising the claimant of the reserved name on a later connection — and is
   * ignored for every other name. Optional, so a client that never sends it
   * behaves exactly as before except that it cannot hold the reserved name.
   */
  | { type: 'join'; name: string; skin: string; owner?: string }
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
