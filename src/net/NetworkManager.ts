import { NullTransport, WebSocketTransport } from './transports.ts';
import type {
  ConnectionState,
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
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  private readonly buffer: TimedState[] = [];

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  push(state: TimedState): void {
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

  private readonly INTERP_DELAY = 100; // ms
  private timeOffset = 0; // serverTime - clientTime estimate
  private inputSeq = 0;

  private joinHandlers = new Set<PlayerEvent>();
  private leaveHandlers = new Set<PlayerEvent>();
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

  private ingest(players: PlayerSnapshot[], t: number): void {
    for (const s of players) {
      if (s.id === this.localId) continue; // server reconciliation handled elsewhere
      let rp = this.remotePlayers.get(s.id);
      if (!rp) {
        rp = new RemotePlayer(s.id, s.name);
        this.remotePlayers.set(s.id, rp);
        for (const h of this.joinHandlers) h(rp);
      }
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

  join(name: string): void {
    this.transport.send({ type: 'join', name });
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
    };
    this.transport.send({ type: 'input', cmd });
  }

  /** Advance interpolation for all remote players. Call once per frame. */
  update(): void {
    const renderTime = performance.now() + this.timeOffset - this.INTERP_DELAY;
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
  onStateChange(h: (s: ConnectionState) => void): () => void {
    this.stateHandlers.add(h);
    return () => this.stateHandlers.delete(h);
  }

  dispose(): void {
    this.transport.close();
    this.remotePlayers.clear();
    this.joinHandlers.clear();
    this.leaveHandlers.clear();
    this.stateHandlers.clear();
  }
}
