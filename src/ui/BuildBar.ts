import {
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Engine } from '../core/Engine.ts';
import { gameSession } from '../net/session.ts';
import { BUILD_GRID, PIECES, type BuildSite, type PieceKind } from '../world/Building.ts';
import { t } from './i18n.ts';

/**
 * BuildBar
 * --------
 * The hotbar along the bottom of the screen: six pieces, each drawn as a small 3D
 * render of the thing it places, with the selected one lit up. Admin only, and
 * hidden entirely otherwise — a moderator tool should not take up screen space, or
 * advertise itself, for players who cannot use it.
 *
 * The icons are real geometry rather than drawings, so a slot can never disagree
 * with what it places: both read the same `BufferGeometry`. Each is rendered
 * **once** into a PNG data URL and then left alone for the rest of the session,
 * which is the same arrangement the player-list portraits use and for the same
 * reason — the picture never changes, so there is nothing to redraw.
 *
 * The render runs on a private 64x64 renderer, not the game's. The game's is
 * mid-frame with a post-processing composer bound to it, and borrowing it would
 * mean saving and restoring its size, clear colour and render target around six
 * one-off draws. The private context is created for those draws and released the
 * moment they finish, because browsers cap how many WebGL contexts a page can hold
 * and the game's own renderer should not be left competing with an abandoned one.
 */

/** Icon pixels, square. 34 CSS px in the bar, so this covers a 2x display. */
const ICON_SIZE = 64;

/**
 * The site currently accepting pieces, or `null` when the active scene has none.
 *
 * A module-level handle rather than a constructor argument because the bar is
 * built with the rest of the HUD, long before any scene exists, and the site
 * belongs to the scene and dies with it. The scene announces itself on entry and
 * withdraws on teardown, so the bar can never hold a pointer into a disposed world.
 */
let site: BuildSite | null = null;

export function setBuildSite(next: BuildSite | null): void {
  site = next;
}

export class BuildBar {
  /** The whole HUD block, shown and hidden as one. */
  private readonly root: HTMLElement | null;
  /** Just the row of slots. */
  private readonly bar: HTMLElement | null;
  private readonly slots: HTMLButtonElement[] = [];
  private readonly hint: HTMLElement | null;
  private readonly counter: HTMLElement | null;
  private allowed = false;
  private icons: string[] = [];
  private readonly engine: Engine;

  constructor(engine: Engine) {
    this.engine = engine;
    this.root = document.getElementById('buildHud');
    this.bar = document.getElementById('buildBar');
    this.hint = document.getElementById('buildHint');
    this.counter = document.getElementById('buildCount');
    if (this.bar) this.buildSlots();

    // Same gate as the admin panel, and a subscription rather than a read: the
    // password is checked on the server after the socket opens, so at construction
    // time nobody is an admin yet.
    gameSession().onAdminChange((admin: boolean) => {
      this.allowed = admin;
      if (!admin) {
        site?.setActive(false);
        this.setVisible(false);
      }
    });

    window.addEventListener('keydown', (e) => this.onKey(e));
    // Placement is on the primary button, and only counts while the game holds the
    // mouse — which also happens to be exactly when the hotbar is unreachable, so a
    // click meant for a slot can never place a piece as well.
    //
    // Gated on the engine's own capture flag rather than on
    // `document.pointerLockElement`: the desktop shell confines the cursor itself
    // and deliberately never enters Pointer Lock (so Chromium never shows its
    // "press Esc to exit" banner), which means that property is *always* null in
    // the installed app. Reading it here disabled building entirely outside the
    // browser. `input.locked` is the one flag both capture paths keep up to date.
    // `pointerdown`, which is the event this codebase already trusts at window
    // level (the audio unlock listens for the same one), and which arrives from
    // mouse, pen and touch alike.
    window.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !site?.active) return;
      // Either the game holds the mouse, or the click landed on the canvas — two
      // independent ways of saying "this click was aimed at the world". Neither can
      // match a click on a hotbar slot, so a slot press cannot also place a piece.
      const onCanvas = (e.target as HTMLElement | null)?.tagName === 'CANVAS';
      if (!this.engine.input.locked && !onCanvas) return;
      site.place();
      this.refresh();
    });
  }

  private buildSlots(): void {
    const root = this.bar;
    if (!root) return;
    PIECES.forEach((kind, i) => {
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'buildSlot';
      slot.dataset.kind = kind;
      slot.innerHTML =
        `<span class="buildIcon" data-slot="${i}"></span>` +
        `<span class="buildKey">${i + 1}</span>` +
        `<span class="buildName">${t(`build.${kind}`)}</span>`;
      // Selecting by mouse as well as by number key. The bar is only reachable with
      // a cursor while the game has released the mouse, which is exactly when the
      // keys are least convenient.
      slot.addEventListener('click', () => {
        this.select(kind);
        slot.blur();
      });
      root.appendChild(slot);
      this.slots.push(slot);
    });
  }

  /** True when the bar may be shown at all. */
  get available(): boolean {
    return this.allowed;
  }

  private select(kind: PieceKind): void {
    if (!site) return;
    if (!site.active) site.setActive(true);
    site.select(kind);
    void this.paintIcons();
    this.setVisible(true);
    this.refresh();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.allowed || !site) return;
    const target = e.target as HTMLElement | null;
    if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
    if (e.repeat) return;

    if (e.code === 'KeyB') {
      e.preventDefault();
      const on = !site.active;
      site.setActive(on);
      this.setVisible(on);
      if (on) void this.paintIcons();
      this.refresh();
      return;
    }
    if (!site.active) return;

    // Digits pick a piece. No clash with the squad invite keys: those only listen
    // while Tab is held, and the player list is not open in build mode.
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      const idx = Number(digit[1]) - 1;
      const kind = PIECES[idx];
      if (kind) {
        e.preventDefault();
        this.select(kind);
      }
      return;
    }
    // Enter places too. The mouse is the natural way to do it, but a keyboard path
    // costs nothing and means build mode is never stuck because of how a particular
    // shell delivers clicks.
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      site.place();
      this.refresh();
      return;
    }
    if (e.code === 'KeyR') {
      e.preventDefault();
      site.rotate();
      return;
    }
    if (e.code === 'KeyX') {
      e.preventDefault();
      site.removeAimed();
      this.refresh();
      return;
    }
    if (e.code === 'KeyC' && e.shiftKey) {
      e.preventDefault();
      site.clear();
      this.refresh();
    }
  }

  private setVisible(on: boolean): void {
    if (!this.root) return;
    this.root.hidden = !(on && this.allowed);
  }

  private refresh(): void {
    const selected = site?.selected;
    for (const slot of this.slots) {
      slot.classList.toggle('on', slot.dataset.kind === selected);
    }
    if (this.counter) this.counter.textContent = String(site?.count() ?? 0);
    if (this.hint) this.hint.textContent = t('build.hint');
  }

  /**
   * Called from the HUD's per-frame overlay pass. Deliberately almost nothing: the
   * bar's contents only change when the player presses a key, and those paths
   * refresh it themselves. This exists to catch admin rights arriving while the
   * bar is already on screen.
   */
  update(): void {
    if (!this.root) return;
    const shouldShow = this.allowed && site?.active === true;
    if (this.root.hidden === shouldShow) this.setVisible(shouldShow);
  }

  /**
   * Draws the six icons, once. Awaited by nobody: slots show their name until the
   * picture lands, which is within a frame or two of first opening the bar.
   */
  private async paintIcons(): Promise<void> {
    if (this.icons.length > 0 || !site) return;
    this.icons = renderIcons(site);
    for (let i = 0; i < this.slots.length; i++) {
      const url = this.icons[i];
      const box = this.slots[i]?.querySelector<HTMLElement>('.buildIcon');
      if (url && box) box.style.backgroundImage = `url(${url})`;
    }
    this.refresh();
  }
}

/**
 * Renders one picture per piece and hands back their data URLs, then gives the
 * context straight back.
 *
 * Orthographic and from a fixed three-quarter angle: an icon has to read as a
 * *shape* at 34 px, and perspective at that size mostly just bends the silhouette.
 * The same camera for all six means their sizes are comparable, so the wall
 * genuinely looks like the tall one.
 */
function renderIcons(from: BuildSite): string[] {
  let renderer: WebGLRenderer | null = null;
  try {
    renderer = new WebGLRenderer({
      alpha: true,
      antialias: true,
      // Read back with `toDataURL` right after the draw; preserving the buffer
      // removes any question of the compositor having cleared it first.
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    });
    renderer.setPixelRatio(1);
    renderer.setSize(ICON_SIZE, ICON_SIZE, false);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);

    const scene = new Scene();
    scene.add(new HemisphereLight(0xdff0ff, 0x30281f, 1.35));
    const key = new DirectionalLight(0xfff2dc, 2.5);
    key.position.set(-0.6, 1.2, 0.9);
    scene.add(key);
    const rim = new DirectionalLight(0x9ec4ff, 0.9);
    rim.position.set(0.9, 0.2, -0.8);
    scene.add(rim);

    // Flat colour, no maps: the world texture is 512px of grain that turns to noise
    // at icon size, and the silhouette is the whole point.
    const material = new MeshStandardMaterial({
      color: 0xc08b52,
      roughness: 0.85,
      metalness: 0,
    });

    const half = BUILD_GRID * 0.72;
    const camera = new OrthographicCamera(-half, half, half, -half, 0.1, 100);
    camera.position.set(BUILD_GRID, BUILD_GRID * 0.85, BUILD_GRID);
    camera.lookAt(new Vector3(0, 0, 0));

    const urls: string[] = [];
    const mesh = new Mesh(undefined, material);
    scene.add(mesh);
    for (const kind of PIECES) {
      mesh.geometry = from.geometryFor(kind);
      // Walls and pillars are drawn standing on the floor of their cell, the way
      // they are placed, so the icon matches what appears in the world.
      mesh.position.y = kind === 'wall' || kind === 'pillar' ? -BUILD_GRID / 2 : 0;
      renderer.render(scene, camera);
      urls.push(renderer.domElement.toDataURL('image/png'));
    }
    scene.remove(mesh);
    material.dispose();
    return urls;
  } catch (err) {
    console.warn(`[buildbar] no icons: ${String((err as Error)?.message ?? err)}`);
    return [];
  } finally {
    if (renderer) {
      renderer.dispose();
      // `dispose` frees three's resources but leaves the GL context for the driver
      // to reclaim eventually. Contexts are a capped, page-wide resource.
      renderer.forceContextLoss();
    }
  }
}
