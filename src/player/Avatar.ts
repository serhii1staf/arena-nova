import { Group, type Vector3 } from 'three';
import { CharacterModel, type LocomotionState } from './CharacterModel.ts';
// Type-only: erased at build time, so GLTFLoader stays out of the main bundle.
import type { CharacterManifest, GltfCharacter } from './GltfCharacter.ts';
import { savedSkin, skinModelPath } from './skins.ts';

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
  /** Stable container. Scenes add this once and toggle `visible` on it. */
  readonly object = new Group();

  private active: CharacterAvatar;
  private readonly procedural: CharacterModel;
  private disposed = false;
  private readonly skinId: string;

  /** True once an authored model has taken over. Surfaced for diagnostics. */
  gltfActive = false;

  /** `skinId` picks a model from the library; omit it for the saved choice. */
  constructor(skinId?: string) {
    this.skinId = skinId ?? savedSkin();
    this.procedural = new CharacterModel();
    this.active = this.procedural;
    this.object.add(this.procedural.object);
    void this.tryUpgrade();
  }

  private async tryUpgrade(): Promise<void> {
    let rig: GltfCharacter | null = null;
    try {
      const manifest = await loadManifest();
      if (!manifest || this.disposed) return;
      const mod = await import('./GltfCharacter.ts');
      rig = await mod.GltfCharacter.tryLoad(manifest, skinModelPath(this.skinId));
    } catch (err) {
      console.warn(`[avatar] authored model unavailable: ${String((err as Error)?.message ?? err)}`);
    }
    if (!rig) return;
    // The scene may have been torn down while the model was in flight.
    if (this.disposed) {
      rig.dispose();
      return;
    }

    this.object.remove(this.procedural.object);
    this.procedural.dispose();
    this.object.add(rig.object);
    this.active = rig;
    this.gltfActive = true;
  }

  update(pos: Vector3, yaw: number, s: LocomotionState, dt: number): void {
    // The active rig positions its own root; the container stays at the origin
    // so its transform never double-applies.
    this.active.update(pos, yaw, s, dt);
  }

  dispose(): void {
    this.disposed = true;
    this.active.dispose();
  }
}
