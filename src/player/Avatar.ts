import { Group, type Vector3 } from 'three';
import { CharacterModel, type LocomotionState } from './CharacterModel.ts';
// Type-only: erased at build time, so GLTFLoader stays out of the main bundle.
import type { CharacterManifest, GltfCharacter } from './GltfCharacter.ts';
import { onSkinChange, savedSkin, skinModelPath } from './skins.ts';
import { SkinSwap } from './SkinSwap.ts';

/** What a scene needs from a player avatar, procedural or authored. */
export interface CharacterAvatar {
  readonly object: Group;
  update(pos: Vector3, yaw: number, s: LocomotionState, dt: number): void;
  dispose(): void;
}

function manifestUrl(): string {
  // Relative to the document, so the same build works over http(s) and from the
  // file:// origin used inside the native shell.
  return new URL('models/character.json', document.baseURI).href;
}

let manifestPromise: Promise<CharacterManifest | null> | null = null;

/**
 * Reads `public/models/character.json`. Shipped with `enabled: false`, so a
 * clean install resolves to `null` here and never requests a model that isn't
 * there. Cached: the file is read once per session.
 */
function loadManifest(): Promise<CharacterManifest | null> {
  manifestPromise ??= (async () => {
    try {
      const res = await fetch(manifestUrl(), { cache: 'no-cache' });
      if (!res.ok) return {}; // no manifest, but try the default path anyway
      const m = (await res.json()) as CharacterManifest;
      return m.enabled === false ? null : m;
    } catch {
      return {};
    }
  })();
  return manifestPromise;
}

/**
 * Avatar
 * ------
 * The player's visible body. It starts as the built-in procedural
 * `CharacterModel`, so the game is playable on the first frame with no
 * downloads, then transparently swaps in an authored GLTF/GLB rig when one is
 * installed at `public/models/character.glb`.
 *
 * Scenes only touch `object` / `update` / `dispose`, so the swap is invisible to
 * them: the container group stays the same object, keeping the scene graph and
 * visibility flags intact.
 *
 * The GLTF path (loader + skeleton utils + meshopt decoder, ~135 kB) is behind a
 * dynamic import, so builds with no authored model never download it.
 */
export class Avatar implements CharacterAvatar {
  /** Body the swap effect should fill. Matches the manifest's character height. */
  private static readonly SWAP_HEIGHT = 1.8;
  private static readonly SWAP_RADIUS = 0.34;

  /** Stable container. Scenes add this once and toggle `visible` on it. */
  readonly object = new Group();

  private active: CharacterAvatar;
  private procedural: CharacterModel | null;
  private disposed = false;
  private skinId: string;
  private swap: SkinSwap | null = null;
  private readonly unsubscribe: (() => void) | null;
  /** Guards against an out-of-order load when the choice changes twice quickly. */
  private loadToken = 0;
  private installed: string | null = null;

  /** True once an authored model has taken over. Surfaced for diagnostics. */
  gltfActive = false;

  /**
   * `skinId` picks a model from the library. Omit it for the local player: the
   * avatar then follows the saved choice and keeps following it, so changing
   * character in the menu takes effect immediately instead of at the next area.
   * Remote avatars are constructed with an explicit id and never self-update —
   * their skin is whatever the network says it is.
   */
  constructor(skinId?: string) {
    const follows = skinId === undefined;
    this.skinId = skinId ?? savedSkin();
    this.procedural = new CharacterModel();
    this.active = this.procedural;
    this.object.add(this.procedural.object);
    this.unsubscribe = follows ? onSkinChange((id) => this.setSkin(id)) : null;
    void this.tryUpgrade(++this.loadToken);
  }

  /** The character that has been asked for. May still be loading. */
  get skin(): string {
    return this.skinId;
  }

  /**
   * The character actually on screen, or `null` while the procedural stand-in is
   * still up. Distinct from `skin` on purpose: a request is recorded immediately
   * but the model only appears once it has downloaded and the swap has run, and
   * conflating the two hides a change that never completed.
   */
  get installedSkin(): string | null {
    return this.installed;
  }

  /**
   * Changes character in place, covered by a burst of motes.
   *
   * The new rig is fully loaded *before* anything visible happens, so the body is
   * never missing for a frame while a few hundred kilobytes arrive — the swap
   * itself is instant and hidden inside the effect.
   */
  setSkin(id: string): void {
    if (id === this.skinId || this.disposed) return;
    this.skinId = id;
    void this.tryUpgrade(++this.loadToken, true);
  }

  private async tryUpgrade(token: number, animate = false): Promise<void> {
    const wanted = this.skinId;
    let rig: GltfCharacter | null = null;
    try {
      const manifest = await loadManifest();
      if (!manifest || this.disposed || token !== this.loadToken) return;
      const mod = await import('./GltfCharacter.ts');
      rig = await mod.GltfCharacter.tryLoad(manifest, skinModelPath(wanted));
    } catch (err) {
      console.warn(`[avatar] authored model unavailable: ${String((err as Error)?.message ?? err)}`);
    }
    if (!rig) return;
    // The scene may have been torn down, or the choice changed again, while the
    // model was in flight.
    if (this.disposed || token !== this.loadToken) {
      rig.dispose();
      return;
    }

    if (!animate) {
      this.install(rig, wanted);
      return;
    }

    // Hold the loaded rig until the cloud is thick enough to hide the exchange.
    this.swap?.dispose();
    const pending = rig;
    const effect = new SkinSwap(Avatar.SWAP_HEIGHT, Avatar.SWAP_RADIUS, () => {
      if (this.disposed || token !== this.loadToken) {
        pending.dispose();
        return;
      }
      this.install(pending, wanted);
    });
    this.swap = effect;
    this.object.add(effect.object);
  }

  /** Puts a loaded rig on screen and retires whatever was there. */
  private install(rig: GltfCharacter, id: string): void {
    const previous = this.active;
    this.object.add(rig.object);
    this.active = rig;
    this.gltfActive = true;
    this.installed = id;
    previous.dispose();
    if (previous === this.procedural) this.procedural = null;
  }

  update(pos: Vector3, yaw: number, s: LocomotionState, dt: number): void {
    // The active rig positions its own root; the container stays at the origin
    // so its transform never double-applies.
    this.active.update(pos, yaw, s, dt);

    if (this.swap) {
      this.swap.setCentre(pos);
      this.swap.update(dt);
      if (this.swap.finished) {
        this.swap.dispose();
        this.swap = null;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.swap?.dispose();
    this.swap = null;
    this.active.dispose();
  }
}
