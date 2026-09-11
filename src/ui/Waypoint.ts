import type { Engine } from '../core/Engine.ts';
import { t } from './i18n.ts';

/**
 * Waypoint
 * --------
 * Where you are, and which way a place is.
 *
 * Two halves that belong together. A readout of the player's own position, toggled
 * with F3, so a coordinate can be read off and passed to somebody; and a target,
 * typed in, with an arrow across the top of the screen pointing at it and the
 * distance beside it. That is the whole loop the request described: one player reads
 * their coordinates out, another types them in and is shown the way.
 *
 * Deliberately not networked. A shared marker would need a protocol message, a
 * server relay and a rule for who may place one — and none of that is needed for
 * two people reading numbers to each other, which already works between any two
 * players on any two machines, including ones in different rooms.
 *
 * The cost is a handful of DOM writes on frames where a value actually changed. The
 * readout is rounded to whole metres, so standing still writes nothing at all, and
 * the arrow only rotates when the angle moves by a degree.
 */

/** What the HUD needs from whichever scene is running. */
interface Located {
  player?: {
    feetPosition: { x: number; y: number; z: number };
    viewYaw: number;
  };
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

export class Waypoint {
  private readonly engine: Engine;
  private readonly panel = $('coords');
  private readonly readout = $('coordsRead');
  private readonly input = $<HTMLInputElement>('coordsInput');
  private readonly compass = $('compass');
  private readonly needle = $('compassNeedle');
  private readonly range = $('compassRange');

  private open = false;
  private target: { x: number; z: number } | null = null;
  /** Last values written to the DOM, so an unchanged frame costs nothing. */
  private wrote = { text: '', deg: 999, range: '' };

  constructor(engine: Engine) {
    this.engine = engine;
    this.wireKeys();
    this.wireInput();
  }

  private wireKeys(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      if (e.code !== 'F3' || e.repeat) return;
      // F3 is a browser search shortcut; the game wants it more.
      e.preventDefault();
      this.setOpen(!this.open);
    });
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.panel?.classList.toggle('on', open);
    this.panel?.setAttribute('aria-hidden', open ? 'false' : 'true');
    // Force the next frame to write, since the panel's contents are stale.
    this.wrote.text = '';
  }

  private wireInput(): void {
    this.input?.addEventListener('keydown', (e) => {
      // Stop movement keys and the panel toggles reaching the game while typing.
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      this.setTarget(this.input?.value ?? '');
    });
  }

  /**
   * Reads a target out of whatever the player pasted.
   *
   * Forgiving on purpose: coordinates get passed between people over voice and
   * chat, so `120 -340`, `120, -340`, `x=120 z=-340` and a three-number form with
   * the height in the middle all have to work. The height is discarded — the arrow
   * is a compass bearing, and altitude has nothing to say about which way to walk.
   */
  private setTarget(raw: string): void {
    const numbers = raw.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    if (numbers.length < 2) {
      this.target = null;
      this.compass?.classList.remove('on');
      return;
    }
    const x = numbers[0]!;
    const z = numbers.length >= 3 ? numbers[2]! : numbers[1]!;
    this.target = { x, z };
    this.compass?.classList.add('on');
    this.wrote.deg = 999;
    this.input?.blur();
  }

  /** Called once per frame from the UI's overlay pass. */
  update(): void {
    const scene = this.engine.scenes.current as unknown as Located | null;
    const player = scene?.player;
    if (!player) return;
    const p = player.feetPosition;

    if (this.open && this.readout) {
      // Whole metres. A readout that jitters in the third decimal is unreadable and
      // is also a DOM write on every single frame.
      const text = `X ${Math.round(p.x)}   Y ${Math.round(p.y)}   Z ${Math.round(p.z)}`;
      if (text !== this.wrote.text) {
        this.readout.textContent = text;
        this.wrote.text = text;
      }
    }

    if (!this.target) return;

    const dx = this.target.x - p.x;
    const dz = this.target.z - p.z;
    const distance = Math.hypot(dx, dz);

    // Bearing relative to where the player is looking, so the arrow points the way
    // to turn rather than to a compass north nobody can see. At yaw 0 the camera
    // looks down -Z, which is why the target bearing is measured the same way.
    const bearing = Math.atan2(dx, -dz);
    const relative = bearing - -player.viewYaw;
    const deg = Math.round(((relative * 180) / Math.PI) % 360);

    if (this.needle && deg !== this.wrote.deg) {
      this.needle.style.transform = `rotate(${deg}deg)`;
      this.wrote.deg = deg;
    }
    if (this.range) {
      const text =
        distance < 12 ? t('coords.arrived') : `${distance < 1000 ? Math.round(distance) : (distance / 1000).toFixed(1) + 'k'} m`;
      if (text !== this.wrote.range) {
        this.range.textContent = text;
        this.wrote.range = text;
      }
    }
  }
}
