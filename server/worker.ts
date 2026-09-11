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
  /**
   * The admin password, as a Worker secret. Optional in the type because a
   * deployment that has not set it must still run — with nobody as admin.
   */
  ADMIN_PASSWORD?: string;
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
  /** Granted only by `claimName`, never by anything the client sends. */
  admin: boolean;
  /**
   * Latency the client reported for itself, in ms, clamped. Held here with the
   * rest of the player state so it survives hibernation like everything else —
   * an instance field would be lost the moment the room went idle.
   */
  ping: number;
}

/** Nothing sensible is above this, and it keeps the number printable. */
const MAX_REPORTED_PING = 5000;

/** Snapshots are broadcast at most this often (ms) — 20 Hz. */
const BROADCAST_INTERVAL = 50;
/** Hard cap per room, so one room cannot be used to burn the whole account. */
const MAX_PLAYERS = 16;
/**
 * The one name that cannot be taken twice, and which carries admin rights.
 *
 * Claimed by whoever asks for it first and recorded in durable storage, so it
 * survives the room hibernating. Comparison is case-insensitive: reserving only
 * the exact spelling would leave every other casing free to impersonate it.
 */
const RESERVED_NAME = 'Kairozun';
const OWNER_KEY = 'reserved:owner';
/**
 * How many installs may hold the reserved name at once.
 *
 * One was wrong, and not by a little: the owner plays on a laptop and a desktop,
 * and a name bound to a single install meant the second machine was refused from
 * a name it legitimately owned, with no way to move it across. Renaming is not a
 * workaround either — the name *is* the claim.
 *
 * A small cap rather than an unbounded list, because every slot is a way in for
 * somebody who knows the name. The honest description of this scheme is
 * first-come-first-served across a handful of devices, and the tradeoff is stated
 * plainly here so it is not mistaken for authentication: anyone who claims the
 * name before the owner does, on a room whose slots are free, gets it.
 */
const MAX_OWNERS = 3;
/**
 * Shortest value accepted as an owner token.
 *
 * This is also how a record written by the previous scheme is recognised. That
 * scheme stored the *connection* id, which is regenerated for every socket, so
 * the reserved name could be claimed once per room and never again — the owner
 * came back with a new id, failed to match the stored one, and was refused along
 * with everybody else. Any stored value shorter than this is therefore a dead
 * record from that scheme and is treated as unclaimed rather than as a rival.
 */
const MIN_OWNER_TOKEN = 32;

/**
 * Relay kinds the room will forward. An allow-list rather than a pass-through,
 * because the field is echoed to another client: without it this would be a way to
 * push arbitrary strings at other players through a server that never looks at them.
 */
const RELAY_KINDS = new Set<string>([
  'squadInvite',
  'squadAccept',
  'squadDecline',
  'squadLeave',
]);

export class GameRoom {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private lastBroadcast = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    // Needed for the admin secret. A Durable Object is handed the environment by
    // the runtime, so this is the only way the room can read a binding.
    this.env = env;
  }

  /**
   * Whether a supplied password grants admin.
   *
   * Admin is a *secret*, not a name. It used to be granted to whoever claimed the
   * reserved name, which meant anybody who saw that name in the player list — it is
   * shown there, with a badge — could simply type it and take the panel. Names are
   * public by construction and can never be a credential.
   *
   * The secret lives in a Worker binding, so it exists only on the server: it is
   * not in the client bundle, not in this repository, and cannot be read back out
   * of Cloudflare. If the binding is unset, nobody is admin — failing closed is the
   * only safe direction for an authorisation check.
   *
   * Compared in constant time with respect to the *contents*. A plain `===` on
   * strings can return early at the first differing byte, which leaks how much of
   * a guess was correct and turns a search over the whole space into a search one
   * character at a time. Length is allowed to leak; that is not useful on its own.
   */
  private grantsAdmin(supplied: string): boolean {
    // Trimmed, both sides.
    //
    // Not defensiveness for its own sake: a secret is typed or piped in by hand
    // exactly once, and the ways of doing that mostly append a newline. Piping the
    // value into `wrangler secret put` from a shell stored a trailing newline, the
    // length check below then failed immediately, and the symptom was the password
    // being silently wrong with nothing anywhere saying so — the one failure mode an
    // authorisation check must not have. Whitespace around a password can never be
    // meaningful, so removing it costs nothing and removes the trap.
    const secret = (this.env.ADMIN_PASSWORD ?? '').trim();
    const given = supplied.trim();
    if (!secret || given.length === 0) return false;
    supplied = given;
    if (supplied.length !== secret.length) return false;
    let diff = 0;
    for (let i = 0; i < secret.length; i++) {
      diff |= supplied.charCodeAt(i) ^ secret.charCodeAt(i);
    }
    return diff === 0;
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
      skin: 'captain',
      admin: false,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      // Unmeasured, not "perfect": the client has not completed a round trip yet.
      ping: 0,
      seen: Date.now(),
    };
    server.serializeAttachment(attached);

    // Admin is granted on `join`, not here — the name has not been claimed yet.
    this.send(server, { type: 'welcome', id, t: Date.now(), admin: false });
    // Give the newcomer the current world immediately rather than making them
    // wait for someone else to move.
    this.broadcast(true);

    return new Response(null, { status: 101, webSocket: client } as ResponseInitWithSocket);
  }

  /**
   * Resolves the one reserved name.
   *
   * Whoever claims `RESERVED_NAME` first owns it for good and is the room's admin;
   * everyone else asking for it is refused and keeps the name they had. The owner
   * is recorded in durable storage rather than in memory, so it survives the room
   * hibernating and being evicted — an in-memory flag would hand the name to
   * whoever happened to reconnect first after an idle period.
   *
   * What is recorded is the claimant's *install* token, not their connection id.
   * The connection id is minted per socket, so recording it meant the owner could
   * never prove continuity: they reconnected, presented a new id, and were refused
   * from their own name. The token is the only thing on either side of the wire
   * that outlives a socket.
   *
   * Admin is decided here and only here. The client is never asked, and the token
   * grants nothing by itself — it is compared against a record the server wrote.
   */
  private async claimName(
    ws: CfWebSocket,
    attached: Attached,
    wanted: string,
    token: string | null,
  ): Promise<void> {
    if (wanted.toLowerCase() !== RESERVED_NAME.toLowerCase()) return;

    const refuse = (): void => {
      attached.name = `${wanted}_${attached.id.slice(0, 4)}`;
      attached.admin = false;
      ws.serializeAttachment(attached);
      this.send(ws, { type: 'nameRejected', name: wanted, reason: 'reserved' });
      this.broadcast(true);
    };

    // No usable token means no way to be recognised again, so there is nothing to
    // record and nothing to grant. Refusing is the safe direction: granting would
    // hand the name to any client that simply omitted the field.
    if (token === null) {
      refuse();
      return;
    }

    // The record is a list of install tokens. Older rooms hold a single string —
    // either a token from the previous scheme or a dead connection id from the one
    // before that — and both are normalised here rather than migrated separately,
    // so a room heals on the next claim whatever state it was left in.
    const raw = await this.state.storage.get<string | string[]>(OWNER_KEY);
    const owners = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(
      (t) => typeof t === 'string' && t.length >= MIN_OWNER_TOKEN,
    );

    if (!owners.includes(token)) {
      if (owners.length >= MAX_OWNERS) {
        refuse();
        return;
      }
      owners.push(token);
      await this.state.storage.put(OWNER_KEY, owners);
    }

    // The name is granted; rights are not, and are not touched here. Whatever the
    // password decided in the join handler stands.
    attached.name = wanted;
    ws.serializeAttachment(attached);
    this.broadcast(true);
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
      case 'relay': {
        // Forwarded verbatim to one recipient, with the sender's identity attached
        // by the server. The room does not interpret `kind` and holds no state for
        // it: squad membership lives on the two clients that agreed to it.
        //
        // `from` and `name` come from this socket's own attachment, never from the
        // message. A sender that could choose them could send an invite that appears
        // to come from somebody else.
        const to = String(msg.to ?? '').slice(0, 64);
        const kind = String(msg.kind ?? '');
        if (!to || !RELAY_KINDS.has(kind)) break;
        attached.seen = Date.now();
        for (const peer of this.state.getWebSockets()) {
          const a = peer.deserializeAttachment() as Attached | null;
          if (!a || a.id !== to) continue;
          this.send(peer, {
            type: 'relayed',
            from: attached.id,
            name: attached.name,
            kind: kind as RelayKind,
          });
          break;
        }
        break;
      }

      case 'join': {
        // Names are player-supplied, so clamp the length and strip control
        // characters before they end up in everyone else's client.
        const wanted =
          String(msg.name ?? 'Player')
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .slice(0, 24) || 'Player';
        // The install token, which is only ever consulted for the reserved name.
        // Constrained to a hex-ish shape and a sane length before it can be
        // written to storage or compared against it.
        const rawToken = String(msg.owner ?? '').replace(/[^a-z0-9]/gi, '');
        const token = rawToken.length >= MIN_OWNER_TOKEN ? rawToken.slice(0, 96) : null;
        attached.name = wanted;
        // Skins are ids from a fixed client-side list, so a short allow-listed
        // string is all that is needed; anything odd falls back on the client.
        attached.skin = String(msg.skin ?? 'captain').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'captain';
        attached.seen = Date.now();

        // Admin, decided here and only here, from the password and nothing else.
        //
        // The name is now irrelevant to it: any name with the right secret is
        // admin, and the reserved name without it is just a name. That is the whole
        // point of the change — the previous rule handed the panel to anyone who
        // read the badge in the player list and typed what it said.
        const wasAdmin = attached.admin === true;
        attached.admin = this.grantsAdmin(String(msg.pass ?? ''));
        ws.serializeAttachment(attached);
        // Tell the client, but only when the answer changed. `welcome` is what the
        // client watches for its rights, and re-sending it on every identity update
        // would have it re-running the grant path for no reason.
        if (attached.admin !== wasAdmin) {
          this.send(ws, {
            type: 'welcome',
            id: attached.id,
            t: Date.now(),
            admin: attached.admin,
          });
        }
        this.broadcast(true);

        // The reserved name, which is now purely about who may *be called* that —
        // it carries no rights. Claimed by up to a few installs and refused past
        // that, as before. Resolved asynchronously against durable storage, so the
        // rest of the join is already applied and delivered by the time the
        // decision is known.
        //
        // Fired *after* the writes above, not before: a refusal renames the player,
        // and some of its paths do not await anything at all. Started first, those
        // would be undone by the very assignments they were meant to override.
        void this.claimName(ws, attached, wanted, token);
        break;
      }

      case 'ping':
        // Echoed untouched. The client measures the round trip against its own
        // clock, so no clock agreement is needed and the server keeps no state.
        this.send(ws, { type: 'pong', t: Number(msg.t) || 0 });
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
        // Latency is self-reported — nobody else can measure it — so it is treated
        // like every other client-supplied number here: taken only if it is finite,
        // rounded, and clamped into a range that cannot be used to push nonsense
        // (NaN, Infinity, a negative or a nine-digit value) into every other
        // player's UI. An absent field leaves the last known value alone rather
        // than resetting it, so one odd frame does not blank the readout.
        if (Number.isFinite(cmd.ping)) {
          attached.ping = clamp(Math.round(cmd.ping as number), 0, MAX_REPORTED_PING);
        }
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
      players.push({
        id: a.id,
        name: a.name,
        skin: a.skin,
        admin: a.admin === true,
        x: a.x,
        y: a.y,
        z: a.z,
        yaw: a.yaw,
        // `?? 0` because an attachment written by an older build of this worker
        // has no such field, and those sockets survive a deploy.
        ping: a.ping ?? 0,
      });
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
