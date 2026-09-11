import { NullTransport, WebSocketTransport } from './transports.ts';
import { adminPassword, ownerToken } from './identity.ts';
import type {
  ConnectionState,
  RelayKind,
  InputCommand,
  PlayerSnapshot,
  Transport,
} from './types.ts';

interface TimedState extends PlayerSnapshot {
  t: number;
}

/**
 * A remote player with an entity-interpolation buffer. Rendering is delayed by
 * `INTERP_DELAY` ms so we always have two snapshots to blend between, hiding
 * jitter and packet loss — the standard approach for smooth online movement.
 */
export class RemotePlayer {
  readonly id: string;
  name: string;
  skin: string;
  /** Set by the server for the holder of the reserved name. */
  admin = false;
  /**
   * That player's round-trip time in ms, measured on their machine and relayed by
   * the server. 0 until they have reported one.
   */
  ping = 0;
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  private readonly buffer: TimedState[] = [];

  constructor(id: string, name: string, skin: string) {
    this.id = id;
    this.name = name;
    this.skin = skin;
  }

  push(state: TimedState): void {
    // Seed straight from the first snapshot instead of waiting for the first
    // interpolation pass. Snapshots arrive on the socket callback while the
    // exposed x/y/z are only written inside the frame loop, so a player was
    // briefly readable at the world origin — visible as a pop-in at (0, 0, 0)
    // when someone joins, and outright wrong for a client that is connected but
    // not yet rendering.
    if (this.buffer.length === 0) this.apply(state);
    this.buffer.push(state);
    if (this.buffer.length > 30) this.buffer.shift();
  }

  interpolate(renderTime: number): void {
    const buf = this.buffer;
    if (buf.length === 0) return;
    if (buf.length === 1) {
      this.apply(buf[0]!);
      return;
    }
    for (let i = 0; i < buf.length - 1; i++) {
      const a = buf[i]!;
      const b = buf[i + 1]!;
      if (renderTime >= a.t && renderTime <= b.t) {
        const span = b.t - a.t || 1;
        const f = (renderTime - a.t) / span;
        this.x = a.x + (b.x - a.x) * f;
        this.y = a.y + (b.y - a.y) * f;
        this.z = a.z + (b.z - a.z) * f;
        this.yaw = lerpAngle(a.yaw, b.yaw, f);
        return;
      }
    }
    this.apply(buf[buf.length - 1]!); // extrapolate: hold newest
  }

  private apply(s: TimedState): void {
    this.x = s.x;
    this.y = s.y;
    this.z = s.z;
    this.yaw = s.yaw;
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

type PlayerEvent = (player: RemotePlayer) => void;

/**
 * NetworkManager
 * --------------
 * Transport-agnostic client session. Offline by default (NullTransport); call
 * `connect(url)` to go live against a WebSocket/authoritative server. The scene
 * subscribes to join/leave to spawn/despawn avatars and reads `remotePlayers`
 * each frame after `update()`.
 */
export class NetworkManager {
  private transport: Transport;
  readonly remotePlayers = new Map<string, RemotePlayer>();
  localId = '';

  /**
   * How far behind live the remote players are rendered, in ms. Has to exceed the
   * snapshot spacing (50 ms at 20 Hz) so there are always two samples to blend.
   */
  private readonly INTERP_DELAY = 80;

  /** Smoothed round-trip time in ms, 0 until the first pong. */
  ping = 0;
  /** True only if the server said so. */
  isAdmin = false;
  private lastPingAt = 0;
  private readonly adminHandlers = new Set<(admin: boolean) => void>();
  private readonly nameRejectedHandlers = new Set<(name: string) => void>();
  private readonly relayHandlers = new Set<
    (from: string, name: string, kind: RelayKind) => void
  >();
  private timeOffset = 0; // serverTime - clientTime estimate, for input stamps
  private inputSeq = 0;

  private joinHandlers = new Set<PlayerEvent>();
  private leaveHandlers = new Set<PlayerEvent>();
  /** Fired when a known player's chosen character turns out to differ. */
  private skinHandlers = new Set<PlayerEvent>();
  private stateHandlers = new Set<(s: ConnectionState) => void>();

  constructor(transport: Transport = new NullTransport()) {
    this.transport = transport;
    this.wire();
  }

  get state(): ConnectionState {
    return this.transport.state;
  }

  get isOnline(): boolean {
    return this.transport.state === 'online';
  }

  private wire(): void {
    this.transport.onState((s) => {
      for (const h of this.stateHandlers) h(s);
    });
    this.transport.onMessage((msg) => {
      switch (msg.type) {
        case 'welcome':
          this.localId = msg.id;
          this.timeOffset = msg.t - performance.now();
          // Sent a second time, with admin true, once a reserved name is claimed.
          this.isAdmin = msg.admin === true;
          for (const h of this.adminHandlers) h(this.isAdmin);
          break;

        case 'pong': {
          // Round trip measured against our own clock, so the two never have to
          // agree on anything. Smoothed, because a single sample swings widely and
          // a jittering number is harder to read than a slightly stale one.
          const rtt = performance.now() - msg.t;
          if (rtt >= 0 && rtt < 10_000) {
            this.ping = this.ping === 0 ? rtt : this.ping + (rtt - this.ping) * 0.25;
          }
          break;
        }

        case 'nameRejected':
          for (const h of this.nameRejectedHandlers) h(msg.name);
          break;
        case 'relayed':
          for (const h of this.relayHandlers) h(msg.from, msg.name, msg.kind);
          break;
        case 'snapshot':
          this.ingest(msg.snapshot.players, msg.snapshot.t);
          break;
        case 'playerLeft': {
          const p = this.remotePlayers.get(msg.id);
          if (p) {
            this.remotePlayers.delete(msg.id);
            for (const h of this.leaveHandlers) h(p);
          }
          break;
        }
      }
    });
  }

  /**
   * Buffers a snapshot against the *local* clock rather than the server's.
   *
   * Stamping with the server's time requires the two clocks to agree, and the
   * offset here is a single unsynchronised sample taken at connect — so any skew
   * between the two machines shifted every sample, pushing the interpolation
   * window off the buffered range. Interpolation then fell through to "hold the
   * newest sample", which is why remote players looked heavily delayed and
   * steppy. Arrival time needs no clock agreement at all: the spacing between
   * snapshots is what interpolation actually depends on, and that survives.
   */
  private ingest(players: PlayerSnapshot[], _serverTime: number): void {
    const t = performance.now();
    for (const s of players) {
      if (s.id === this.localId) continue; // server reconciliation handled elsewhere
      let rp = this.remotePlayers.get(s.id);
      if (!rp) {
        rp = new RemotePlayer(s.id, s.name, s.skin);
        rp.admin = s.admin === true;
        this.remotePlayers.set(s.id, rp);
        for (const h of this.joinHandlers) h(rp);
      } else if (s.skin !== rp.skin || s.name !== rp.name) {
        // Identity can arrive after the player does. A socket shows up in the
        // broadcast the moment it is accepted, which is often a round-trip before
        // its `join` lands, so the first snapshots carry the server's defaults.
        // Without this the character someone picked was pinned to the fallback for
        // the rest of the session, and only for whoever happened to see them early.
        rp.name = s.name;
        rp.admin = s.admin === true;
        const skinChanged = s.skin !== rp.skin;
        rp.skin = s.skin;
        if (skinChanged) for (const h of this.skinHandlers) h(rp);
      }
      // Outside the identity branch above: latency moves on its own, without the
      // name or the character ever changing.
      rp.ping = Number.isFinite(s.ping) ? (s.ping as number) : 0;
      rp.push({ ...s, t });
    }
  }

  /** Swap in a real transport and connect. Pass a `ws(s)://` URL. */
  async connect(url: string): Promise<void> {
    this.transport.close();
    this.transport = new WebSocketTransport(url);
    this.wire();
    await this.transport.connect();
  }

  /**
   * Announces identity. Also used as an update: the server treats a second `join`
   * as a change of name or character rather than a new player.
   *
   * The owner token rides along so the server can recognise the holder of the
   * reserved name across reconnects. It says nothing about rights — the server
   * still decides, and still answers in `welcome`.
   */
  join(name: string, skin: string): void {
    const pass = adminPassword();
    this.transport.send({
      type: 'join',
      name,
      skin,
      owner: ownerToken(),
      // Omitted entirely when empty, so an ordinary player's join frame carries no
      // trace of the field at all.
      ...(pass ? { pass } : {}),
    });
  }

  sendInput(x: number, y: number, z: number, yaw: number): void {
    if (!this.isOnline) return;
    const cmd: InputCommand = {
      seq: this.inputSeq++,
      x,
      y,
      z,
      yaw,
      t: performance.now() + this.timeOffset,
      // Our own measurement, piggybacked so the room can show everyone's latency
      // and not just their own. See `InputCommand.ping` for why it goes here and
      // not in a message of its own.
      ping: Math.round(this.ping),
    };
    this.transport.send({ type: 'input', cmd });
  }

  onAdminChange(h: (admin: boolean) => void): () => void {
    this.adminHandlers.add(h);
    // Fire immediately: the welcome may already have arrived before anyone
    // subscribed, and a listener that misses it would show the wrong state.
    h(this.isAdmin);
    return () => this.adminHandlers.delete(h);
  }

  onNameRejected(h: (name: string) => void): () => void {
    this.nameRejectedHandlers.add(h);
    return () => this.nameRejectedHandlers.delete(h);
  }

  /** Advance interpolation for all remote players. Call once per frame. */
  update(): void {
    // One probe a second. Latency does not change fast enough to justify more, and
    // this rides the same socket as the snapshots so it costs nothing to keep up.
    if (this.isOnline) {
      const now = performance.now();
      if (now - this.lastPingAt > 1000) {
        this.lastPingAt = now;
        this.transport.send({ type: 'ping', t: now });
      }
    }
    // Same clock the snapshots were stamped with in `ingest` — the local one.
    const renderTime = performance.now() - this.INTERP_DELAY;
    for (const rp of this.remotePlayers.values()) rp.interpolate(renderTime);
  }

  onPlayerJoin(h: PlayerEvent): () => void {
    this.joinHandlers.add(h);
    return () => this.joinHandlers.delete(h);
  }
  onPlayerLeave(h: PlayerEvent): () => void {
    this.leaveHandlers.add(h);
    return () => this.leaveHandlers.delete(h);
  }
  onPlayerSkinChange(h: PlayerEvent): () => void {
    this.skinHandlers.add(h);
    return () => this.skinHandlers.delete(h);
  }
  /** Sends a one-to-one message through the server. Silent when offline. */
  sendTo(id: string, kind: RelayKind): void {
    if (!this.isOnline || !id) return;
    this.transport.send({ type: 'relay', to: id, kind });
  }

  /**
   * Messages relayed from other players. The identity is the server's word, not the
   * sender's, so a handler can trust `from` and `name`.
   */
  onRelay(h: (from: string, name: string, kind: RelayKind) => void): () => void {
    this.relayHandlers.add(h);
    return () => this.relayHandlers.delete(h);
  }

  onStateChange(h: (s: ConnectionState) => void): () => void {
    this.stateHandlers.add(h);
    return () => this.stateHandlers.delete(h);
  }

  dispose(): void {
    this.transport.close();
    this.remotePlayers.clear();
    this.joinHandlers.clear();
    this.leaveHandlers.clear();
    this.skinHandlers.clear();
    this.stateHandlers.clear();
  }
}
