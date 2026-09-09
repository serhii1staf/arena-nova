/**
 * Arena Nova — edge server
 * ------------------------
 * One Cloudflare Worker does two jobs: it serves the built game as static
 * assets, and it upgrades `/ws` to a WebSocket handled by a Durable Object that
 * owns one game room.
 *
 * Durable Objects are the right primitive here because a game room needs a
 * single authoritative place to hold state that every player in that room
 * connects to. Plain Workers are stateless and cannot hold a socket open.
 *
 * Types are declared locally rather than pulled from `@cloudflare/workers-types`
 * so the server stays a zero-dependency file and the game's own typecheck does
 * not have to know about the Workers runtime.
 */

import type { ClientMessage, PlayerSnapshot, ServerMessage } from '../src/net/types.ts';

// --- Minimal Workers runtime surface -----------------------------------------

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface CfWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface DurableObjectState {
  /** Hands the socket to the runtime so the object can hibernate while idle. */
  acceptWebSocket(ws: CfWebSocket): void;
  getWebSockets(): CfWebSocket[];
}

declare const WebSocketPair: {
  new (): { 0: CfWebSocket; 1: CfWebSocket };
};

interface ResponseInitWithSocket extends ResponseInit {
  webSocket?: CfWebSocket;
}

export interface Env {
  ASSETS: Fetcher;
  GAME_ROOM: DurableObjectNamespace;
}

// --- Room state --------------------------------------------------------------

/**
 * What we remember about a connected player. Stored on the socket itself via
 * `serializeAttachment`, not in a field: when the room hibernates, instance
 * fields are lost but socket attachments survive.
 */
interface Attached extends PlayerSnapshot {
  /** Last time this player sent anything, for idle cleanup. */
  seen: number;
}

/** Snapshots are broadcast at most this often (ms) — 20 Hz. */
const BROADCAST_INTERVAL = 50;
/** Hard cap per room, so one room cannot be used to burn the whole account. */
const MAX_PLAYERS = 16;

export class GameRoom {
  private readonly state: DurableObjectState;
  private lastBroadcast = 0;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    if (this.state.getWebSockets().length >= MAX_PLAYERS) {
      return new Response('Room is full', { status: 503 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernatable: the runtime holds the socket and wakes us on a message, so an
    // idle room costs nothing while players stand still.
    this.state.acceptWebSocket(server);

    const id = crypto.randomUUID().slice(0, 8);
    const attached: Attached = {
      id,
      name: 'Player',
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      seen: Date.now(),
    };
    server.serializeAttachment(attached);

    this.send(server, { type: 'welcome', id, t: Date.now() });
    // Give the newcomer the current world immediately rather than making them
    // wait for someone else to move.
    this.broadcast(true);

    return new Response(null, { status: 101, webSocket: client } as ResponseInitWithSocket);
  }

  webSocketMessage(ws: CfWebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string') return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return; // malformed frame, ignore
    }

    const attached = ws.deserializeAttachment() as Attached | null;
    if (!attached) return;

    switch (msg.type) {
      case 'join':
        // Names are player-supplied, so clamp the length and strip control
        // characters before they end up in everyone else's client.
        attached.name = String(msg.name ?? 'Player')
          .replace(/[\u0000-\u001f\u007f]/g, '')
          .slice(0, 24) || 'Player';
        attached.seen = Date.now();
        ws.serializeAttachment(attached);
        this.broadcast(true);
        break;

      case 'input': {
        const cmd = msg.cmd;
        if (!cmd || !Number.isFinite(cmd.x) || !Number.isFinite(cmd.z) || !Number.isFinite(cmd.yaw)) {
          return;
        }
        // This build relays positions rather than simulating them: the world is
        // generated identically on every client, so there is nothing for the
        // server to be authoritative about yet. Values are still range-checked so
        // a bad client cannot push others somewhere absurd.
        attached.x = clamp(cmd.x, -4000, 4000);
        attached.z = clamp(cmd.z, -4000, 4000);
        attached.y = clamp(Number.isFinite(cmd.y) ? cmd.y : attached.y, -200, 1200);
        attached.yaw = clamp(cmd.yaw, -100, 100);
        attached.seen = Date.now();
        ws.serializeAttachment(attached);
        this.broadcast(false);
        break;
      }

      case 'leave':
        ws.close(1000, 'left');
        break;
    }
  }

  webSocketClose(ws: CfWebSocket): void {
    this.announceDeparture(ws);
  }

  webSocketError(ws: CfWebSocket): void {
    this.announceDeparture(ws);
  }

  private announceDeparture(ws: CfWebSocket): void {
    const attached = ws.deserializeAttachment() as Attached | null;
    if (!attached) return;
    const notice: ServerMessage = { type: 'playerLeft', id: attached.id };
    for (const peer of this.state.getWebSockets()) {
      if (peer === ws) continue;
      this.send(peer, notice);
    }
  }

  /**
   * Sends the world to everyone. Throttled to `BROADCAST_INTERVAL`, and driven by
   * incoming traffic rather than by a timer — a room where nobody moves sends
   * nothing and stays hibernated.
   */
  private broadcast(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastBroadcast < BROADCAST_INTERVAL) return;
    this.lastBroadcast = now;

    const sockets = this.state.getWebSockets();
    const players: PlayerSnapshot[] = [];
    for (const peer of sockets) {
      const a = peer.deserializeAttachment() as Attached | null;
      if (!a) continue;
      players.push({ id: a.id, name: a.name, x: a.x, y: a.y, z: a.z, yaw: a.yaw });
    }

    const msg: ServerMessage = { type: 'snapshot', snapshot: { t: now, players } };
    for (const peer of sockets) this.send(peer, msg);
  }

  private send(ws: CfWebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket already gone */
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- Worker entry ------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      // One Durable Object per room name, so friends join by sharing a name.
      const room = (url.searchParams.get('room') ?? 'main').slice(0, 40).toLowerCase();
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(room));
      return stub.fetch(request);
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, t: Date.now() }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Everything else is the game itself.
    return env.ASSETS.fetch(request);
  },
};
