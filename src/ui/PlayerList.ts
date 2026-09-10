import { gameSession } from '../net/session.ts';
import { playerName } from '../net/identity.ts';
import { savedSkin, resolveSkin, SKINS } from '../player/skins.ts';
import { portraitFor } from './Portraits.ts';
import { t } from './i18n.ts';

/**
 * PlayerList
 * ----------
 * The panel that appears while Tab is held: who is here, which character they are,
 * and how good their connection is.
 *
 * Tab already released the mouse cursor so you could reach things on screen, and
 * this reuses that same hold rather than claiming a second key — the two belong
 * together, since the reason to look at the list is the reason to have a cursor.
 *
 * Rebuilt only while it is open, and only when something has actually changed. The
 * panel is closed almost all of the time, so the common case has to cost nothing:
 * a per-frame innerHTML rebuild of a hidden element is invisible and still burns
 * the frame.
 */

/**
 * A stable accent per character. Still used: it rings the portrait, and it is the
 * fallback chip's fill for the moment before a portrait has been rendered.
 */
const CHIP_COLOURS = [
  '#54be78',
  '#5aa9d8',
  '#c98ad8',
  '#d8b45a',
  '#d87a5a',
  '#8ad8bc',
  '#a8a8b8',
];

function chipColour(skinId: string): string {
  const index = SKINS.findIndex((s) => s.id === resolveSkin(skinId).id);
  return CHIP_COLOURS[Math.max(0, index) % CHIP_COLOURS.length]!;
}

/**
 * Latency to a bar count. Thresholds are generous on purpose: this is a game where
 * positions are interpolated over an 80 ms window, so 120 ms is genuinely fine and
 * showing it as a warning would just make players anxious about nothing.
 *
 * A ping of 0 means "not measured yet" — the first round trip takes about a second
 * and a player who has only just joined has not completed one. Those get an unlit
 * meter, not a full one: four bars for a connection nothing is known about is the
 * one reading that could actually mislead.
 */
function bars(ping: number, online: boolean): { lit: number; className: string } {
  if (!online) return { lit: 0, className: 'bars offline' };
  if (ping <= 0) return { lit: 0, className: 'bars' };
  const lit = ping < 70 ? 4 : ping < 140 ? 3 : ping < 260 ? 2 : 1;
  return { lit, className: `bars lit${lit}` };
}

interface Entry {
  id: string;
  name: string;
  skin: string;
  admin: boolean;
  /** Round-trip time in ms; 0 when it is not known yet. */
  ping: number;
  self: boolean;
  /** Rendered portrait, or null while it is still being drawn. */
  portrait: string | null;
}

export class PlayerList {
  private readonly panel: HTMLElement | null;
  private readonly list: HTMLElement | null;
  private readonly count: HTMLElement | null;
  private open = false;
  /** Last rendered signature, so an unchanged room is not re-rendered. */
  private signature = '';

  constructor() {
    this.panel = document.getElementById('players');
    this.list = document.getElementById('playersList');
    this.count = document.getElementById('playersCount');
  }

  /** Call once per frame with whether Tab is currently held. */
  update(shouldShow: boolean): void {
    if (shouldShow !== this.open) {
      this.open = shouldShow;
      this.panel?.classList.toggle('on', shouldShow);
      this.panel?.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
      // Force a rebuild on open: the room will have moved on since it closed.
      this.signature = '';
    }
    if (!this.open) return;

    const net = gameSession();
    const online = net.isOnline;
    const local = savedSkin();
    const entries: Entry[] = [
      {
        id: net.localId || 'self',
        name: playerName(),
        skin: local,
        admin: net.isAdmin,
        // Ours is measured here from the pong; everyone else's arrives in the
        // snapshot because each client reports its own. Same units, same meaning,
        // so the two are displayed identically.
        ping: Math.round(net.ping),
        self: true,
        portrait: portraitFor(local),
      },
    ];
    for (const p of net.remotePlayers.values()) {
      entries.push({
        id: p.id,
        name: p.name,
        skin: p.skin,
        admin: p.admin,
        ping: Math.round(p.ping),
        self: false,
        portrait: portraitFor(p.skin),
      });
    }
    entries.sort((a, b) => (a.self ? -1 : b.self ? 1 : a.name.localeCompare(b.name)));

    // Latency is deliberately *not* in the signature.
    //
    // It was, and it is the one field here that changes on its own: a smoothed
    // round trip rounded to milliseconds moves almost every second, for every
    // player in the room. So the whole list was torn down and rebuilt at that rate
    // while the panel was open — every row, every meter, and every portrait
    // `<img>`, which meant the browser decoded the same data URLs again and again.
    // Nothing was re-rendered in the 3D sense, but the DOM churn is what made the
    // pictures look like they were being redrawn.
    //
    // Structure is rebuilt only when the room's composition changes: who is here,
    // what they are called, which character they wear, whether they are admin, and
    // whether their portrait has arrived. Everything that ticks is patched in place
    // below, which is a handful of string writes on unchanged nodes.
    const signature = `${online}|${entries
      .map((e) => `${e.id}:${e.name}:${e.skin}:${e.admin}:${e.portrait ? 1 : 0}`)
      .join(',')}`;

    if (signature === this.signature) {
      this.patchVolatile(entries, online);
      return;
    }
    this.signature = signature;

    if (this.count) this.count.textContent = String(entries.length);
    if (!this.list) return;

    const rows = entries.map((e) => {
      const row = document.createElement('div');
      row.className = e.self ? 'playerRow self' : 'playerRow';

      const label = resolveSkin(e.skin).label;
      if (e.portrait) {
        // The character as they actually look, front on. One render per skin, done
        // off the frame loop and cached for the session — see `Portraits.ts`.
        const face = document.createElement('img');
        face.className = 'portrait';
        face.src = e.portrait;
        face.width = 34;
        face.height = 34;
        // Decorative: the name beside it already identifies the player, and the
        // character is named in the tooltip.
        face.alt = '';
        face.title = label;
        row.append(face);
      } else {
        // Fallback while the portrait is still being drawn, or if this build has no
        // authored models at all. Same size and position, so nothing jumps when the
        // picture arrives.
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.style.setProperty('--chip', chipColour(e.skin));
        chip.textContent = label.slice(0, 1);
        chip.title = label;
        row.append(chip);
      }

      const name = document.createElement('span');
      name.className = 'playerName';
      // textContent, never innerHTML: names come from other players.
      name.textContent = e.name;
      row.append(name);

      if (e.admin) {
        const tag = document.createElement('span');
        tag.className = 'adminTag';
        tag.textContent = t('players.admin');
        row.append(tag);
      }

      const ping = document.createElement('span');
      ping.className = 'playerPing';
      // Tagged with the player it belongs to, so the in-place update can find its
      // row again without the list having to remember any DOM itself.
      row.dataset.pid = e.id;
      // Everyone gets a real number now. A dash means only that this player has not
      // reported a round trip yet (they joined a moment ago, or they are on a build
      // that never sent one), which is a different thing from being offline.
      ping.textContent = !online
        ? t('players.offline')
        : e.ping > 0
          ? `${e.ping} ms`
          : '—';
      row.append(ping);

      const b = bars(e.ping, online);
      const meter = document.createElement('span');
      meter.className = b.className;
      meter.append(
        document.createElement('i'),
        document.createElement('i'),
        document.createElement('i'),
        document.createElement('i'),
      );
      row.append(meter);

      return row;
    });
    this.list.replaceChildren(...rows);
  }

  /**
   * Updates only the values that move: the latency figure and its meter.
   *
   * Cheap by construction — it touches existing nodes and writes a string only
   * when it differs, so a room where nothing has changed costs a few comparisons.
   * This is what lets the structural rebuild above be rare.
   */
  private patchVolatile(entries: Entry[], online: boolean): void {
    if (!this.list) return;
    for (const e of entries) {
      const row = this.list.querySelector<HTMLElement>(`[data-pid="${CSS.escape(e.id)}"]`);
      if (!row) continue;

      const ping = row.querySelector<HTMLElement>('.playerPing');
      if (ping) {
        const text = !online ? t('players.offline') : e.ping > 0 ? `${e.ping} ms` : '—';
        if (ping.textContent !== text) ping.textContent = text;
      }

      const meter = row.querySelector<HTMLElement>('.bars');
      if (meter) {
        const b = bars(e.ping, online);
        if (meter.className !== b.className) meter.className = b.className;
      }
    }
  }
}
