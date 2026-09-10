import { gameSession } from '../net/session.ts';
import { playerName } from '../net/identity.ts';
import { savedSkin, resolveSkin, SKINS } from '../player/skins.ts';
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

/** A stable accent per character, so the same face always has the same colour. */
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
 */
function bars(ping: number, online: boolean): { lit: number; className: string } {
  if (!online) return { lit: 0, className: 'bars offline' };
  const lit = ping <= 0 ? 4 : ping < 70 ? 4 : ping < 140 ? 3 : ping < 260 ? 2 : 1;
  return { lit, className: `bars lit${lit}` };
}

interface Entry {
  id: string;
  name: string;
  skin: string;
  admin: boolean;
  ping: number;
  self: boolean;
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
    const entries: Entry[] = [
      {
        id: net.localId || 'self',
        name: playerName(),
        skin: savedSkin(),
        admin: net.isAdmin,
        // Only our own latency is measurable from here; a remote player's ping to
        // the server is not something this client can observe, and inventing a
        // number for it would be a lie dressed as a feature.
        ping: Math.round(net.ping),
        self: true,
      },
    ];
    for (const p of net.remotePlayers.values()) {
      entries.push({
        id: p.id,
        name: p.name,
        skin: p.skin,
        admin: p.admin,
        ping: -1,
        self: false,
      });
    }
    entries.sort((a, b) => (a.self ? -1 : b.self ? 1 : a.name.localeCompare(b.name)));

    const signature = `${online}|${entries.map((e) => `${e.id}:${e.name}:${e.skin}:${e.admin}:${e.ping}`).join(',')}`;
    if (signature === this.signature) return;
    this.signature = signature;

    if (this.count) this.count.textContent = String(entries.length);
    if (!this.list) return;

    const rows = entries.map((e) => {
      const row = document.createElement('div');
      row.className = e.self ? 'playerRow self' : 'playerRow';

      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.style.setProperty('--chip', chipColour(e.skin));
      chip.textContent = resolveSkin(e.skin).label.slice(0, 1);
      chip.title = resolveSkin(e.skin).label;
      row.append(chip);

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
      ping.textContent = e.self ? (online ? `${e.ping} ms` : t('players.offline')) : '—';
      row.append(ping);

      const b = bars(e.self ? e.ping : 0, online);
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
}
