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
import { BUILD_GRID, CATEGORIES, PIECES, type BuildSite, type PieceKind } from '../world/Building.ts';
import { t } from './i18n.ts';

/**
 * BuildBar
 * --------
 * The hotbar along the bottom of the screen: ten slots showing one category of the
 * library at a time, each drawn as a small 3D render of the thing it places, with
 * the piece in hand lit up and named above. Admin only, and hidden entirely
 * otherwise — a moderator tool should not take up screen space, or advertise itself,
 * for players who cannot use it.
 *
 * The library has twenty pieces, which is more than one row a hand can reach across,
 * so they are grouped and the tabs above the bar switch groups. Slots are rebuilt on
 * a switch rather than hidden, because a piece answers to its position in the row
 * and that has to stay 1 to 0 in every group.
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
  /** Name of the piece in hand, shown above the bar. */
  private readonly label: HTMLElement | null;
  private readonly hint: HTMLElement | null;
  private readonly counter: HTMLElement | null;
  /** Names the piece the crosshair is on, so removing is never a guess. */
  private readonly aim: HTMLElement | null;
  private lastAim = '';
  /** Which group's slots are currently on the bar. */
  private shownCategory = -1;
  private allowed = false;
  /**
   * Finished icon per kind, for the session. Keyed by kind rather than by slot index
   * because a slot index means something different in each category.
   */
  private readonly icons = new Map<PieceKind, string>();
  private readonly engine: Engine;

  constructor(engine: Engine) {
    this.engine = engine;
    this.root = document.getElementById('buildHud');
    this.bar = document.getElementById('buildBar');
    this.label = document.getElementById('buildLabel');
    this.aim = document.getElementById('buildAim');
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

    // The wheel steps through the current category, which is how you change what is
    // in hand without taking a finger off the movement keys.
    //
    // Capture phase, and propagation stopped. The camera zoom listens for `wheel` on
    // the canvas, so a bubble-phase listener here left both running: the piece
    // changed *and* the view pulled back. `preventDefault` does not help — it stops
    // the browser's own scrolling, not another listener. A capture listener on
    // `window` runs before the canvas is reached at all, so stopping there is what
    // actually keeps the zoom out of it.
    window.addEventListener(
      'wheel',
      (e) => {
        if (!site?.active || !this.allowed) return;
        e.preventDefault();
        e.stopPropagation();
        site.cycle(e.deltaY > 0 ? 1 : -1);
        void this.paintIcons();
        this.refresh();
      },
      { passive: false, capture: true },
    );
  }

  /**
   * Rebuilds the slot row for the current category.
   *
   * Twenty pieces will not fit on one bar a hand can reach across, so the bar shows
   * one category at a time and the tabs above switch between them. The slots are
   * rebuilt rather than hidden, because the key a piece answers to is its position in
   * the row and that has to stay 1 to 0 in every category.
   */
  private buildSlots(): void {
    const root = this.bar;
    if (!root) return;
    const cats = document.getElementById('buildCats');
    if (cats && cats.childElementCount === 0) {
      CATEGORIES.forEach((cat, ci) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'buildCat';
        tab.dataset.cat = String(ci);
        tab.textContent = t(`build.cat.${cat.id}`);
        tab.addEventListener('click', () => {
          site?.setCategory(ci);
          this.buildSlots();
          void this.paintIcons();
          this.refresh();
          tab.blur();
        });
        cats.appendChild(tab);
      });
    }

    root.replaceChildren();
    this.slots.length = 0;
    this.shownCategory = site?.category ?? 0;
    const pieces = CATEGORIES[this.shownCategory]?.pieces ?? CATEGORIES[0]!.pieces;
    pieces.forEach((kind, i) => {
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'buildSlot';
      slot.dataset.kind = kind;
      // Icon and key number only. The name lives above the bar, on one label that
      // shows whichever piece is in hand — six names crammed into six squares is
      // six times the text for one piece of information.
      slot.title = t(`build.${kind}`);
      slot.innerHTML =
        `<span class="buildIcon" data-slot="${i}"></span>` +
        `<span class="buildKey">${(i + 1) % 10}</span>`;
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
    // Icons are cached per kind for the session, so switching categories back and
    // forth costs a map lookup and a style write.
    this.applyIcons();
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

    // Digits pick a piece — 1 to 9 and then 0 for the tenth, the way a ten-slot
    // bar has always been keyed. No clash with the squad invite keys: those only
    // listen while Tab is held, and the player list is not open in build mode.
    const digit = /^Digit([0-9])$/.exec(e.code);
    if (digit) {
      const typed = Number(digit[1]);
      const idx = typed === 0 ? 9 : typed - 1;
      // Within the category on the bar, which is what the slot under that number
      // actually shows.
      const kind = CATEGORIES[site.category]?.pieces[idx];
      if (kind) {
        e.preventDefault();
        this.select(kind);
      }
      return;
    }
    // Square brackets step between categories, which keeps them off the letters the
    // hands are already using to move and build.
    if (e.code === 'BracketRight' || e.code === 'BracketLeft') {
      e.preventDefault();
      const delta = e.code === 'BracketRight' ? 1 : -1;
      site.setCategory(site.category + delta);
      this.buildSlots();
      this.refresh();
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
    // The row on screen has to be the row the selection lives in. Anything that
    // moves the selection across a group boundary — a tab, a bracket key, or code
    // selecting a piece directly — would otherwise leave the previous group's slots
    // on the bar, with nothing lit and a stale square still raised. Rebuilding here
    // rather than at each of those call sites means it cannot be forgotten at one.
    if (site && site.category !== this.shownCategory) this.buildSlots();
    for (const slot of this.slots) {
      slot.classList.toggle('on', slot.dataset.kind === selected);
    }
    if (this.label && selected) this.label.textContent = t(`build.${selected}`);
    const cat = String(site?.category ?? 0);
    for (const tab of document.querySelectorAll<HTMLElement>('.buildCat')) {
      tab.classList.toggle('on', tab.dataset.cat === cat);
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
    if (!shouldShow || !this.aim) return;
    // What X would take, named, and updated per frame because it changes as the
    // crosshair moves. One string comparison guards the DOM write.
    const kind = site?.aimedKind() ?? null;
    const text = kind ? `${t('build.remove')} ${t(`build.${kind}`)}` : '';
    if (text !== this.lastAim) {
      this.lastAim = text;
      this.aim.textContent = text;
    }
  }

  /**
   * Draws every icon in the library, once for the session.
   *
   * All twenty in one pass rather than per category: the whole set is twenty 64x64
   * draws on a throwaway context, which is cheaper than standing that context up
   * again each time somebody flicks between tabs.
   */
  private async paintIcons(): Promise<void> {
    if (this.icons.size > 0 || !site) return;
    const drawn = renderIcons(site);
    PIECES.forEach((kind, i) => {
      const url = drawn[i];
      if (url) this.icons.set(kind, url);
    });
    this.applyIcons();
    this.refresh();
  }

  /** Puts the cached pictures on whichever slots are currently on the bar. */
  private applyIcons(): void {
    for (const slot of this.slots) {
      const url = this.icons.get(slot.dataset.kind as PieceKind);
      const box = slot.querySelector<HTMLElement>('.buildIcon');
      if (url && box) box.style.backgroundImage = `url(${url})`;
    }
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
      color: 0xb07c46,
      roughness: 0.9,
      metalness: 0,
    });

    const half = BUILD_GRID * 0.72;
    const camera = new OrthographicCamera(-half, half, half, -half, 0.1, 100);
    camera.position.set(BUILD_GRID, BUILD_GRID * 0.85, BUILD_GRID);
    camera.lookAt(new Vector3(0, 0, 0));

    const urls: string[] = [];
    const mesh = new Mesh(undefined, material);
    scene.add(mesh);
    const centre = new Vector3();
    for (const kind of PIECES) {
      const geo = from.geometryFor(kind);
      mesh.geometry = geo;
      // Centred on its own bounds. Every piece is modelled with its underside on
      // the floor of its cell, and they are not the same height — a wall is four
      // metres and a floor is a third of one — so a shared offset would put some
      // of them out of frame.
      geo.boundingBox?.getCenter(centre);
      mesh.position.set(-centre.x, -centre.y, -centre.z);
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
