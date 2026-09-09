import {
  AnimationClip,
  AnimationMixer,
  Bone,
  Box3,
  Group,
  LoopOnce,
  LoopRepeat,
  MathUtils,
  Mesh,
  Object3D,
  SkinnedMesh,
  Vector3,
  type AnimationAction,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { GameConfig } from '../config.ts';
import type { LocomotionState } from './CharacterModel.ts';

/** Locomotion states the rig can be in. */
export type LocoState = 'idle' | 'walk' | 'run' | 'jump' | 'fall';

/**
 * `public/models/character.json` — optional manifest that sits next to the
 * model. Every field is optional; sensible defaults apply when it is absent.
 */
export interface CharacterManifest {
  /**
   * Master switch. The shipped manifest sets this to `false` so a clean install
   * never fires a request for a model that isn't there (a 404 in the console is
   * noise, and the smoke test treats console errors as failures). Set it to
   * `true` after dropping in a model. If the manifest is missing entirely we
   * assume `true` and just try.
   */
  enabled?: boolean;
  /** Model file, relative to `models/`. Default `character.glb`. */
  url?: string;
  /** Extra GLB/GLTF files containing *only* animation (the Mixamo workflow
   *  where each clip is downloaded separately). Bone names must match. */
  animationUrls?: string[];
  /** Target height in metres, feet to crown. Default 1.8. */
  height?: number;
  /** Rotation applied so the model faces its travel direction. Mixamo rigs
   *  face +Z, which needs 180. Default 180. */
  yawOffsetDeg?: number;
  /** Explicit clip names per state; overrides keyword matching. */
  clips?: Partial<Record<LocoState, string>>;
  /** Remove horizontal hip translation so the model can't slide away from the
   *  controller. Default true. */
  stripRootMotion?: boolean;
  /** Ground speed (m/s) the walk clip was authored for, used to sync stride to
   *  real speed. Default = config walkSpeed. */
  walkClipSpeed?: number;
  /** Same, for the run clip. Default = config sprintSpeed. */
  runClipSpeed?: number;
}

interface CharacterSource {
  /** Prototype scene: already scaled, footed and flagged. Cloned per instance. */
  prototype: Object3D;
  clips: AnimationClip[];
  manifest: CharacterManifest;
}

const KEYWORDS: Record<LocoState, string[]> = {
  idle: ['idle', 'breathing', 'stand', 'rest'],
  walk: ['walk'],
  run: ['run', 'sprint', 'jog'],
  jump: ['jump', 'leap'],
  fall: ['fall', 'airborne', 'inair'],
};

/** If a state has no clip of its own, try these instead, in order. */
const FALLBACKS: Record<LocoState, LocoState[]> = {
  idle: [],
  walk: ['run', 'idle'],
  run: ['walk', 'idle'],
  jump: ['fall', 'idle'],
  fall: ['jump', 'idle'],
};

const STATES: LocoState[] = ['idle', 'walk', 'run', 'jump', 'fall'];

/** Lowercase and drop the noise Mixamo/Blender bake into clip names. */
function normaliseName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/mixamo\.com/g, '')
    .replace(/^armature\|?/, '')
    .replace(/[\s_|.\-()]/g, '');
}

/**
 * Pins a clip's horizontal hip translation to its first frame. Vertical motion
 * survives (a jump still rises), but the model can no longer drift away from
 * the controller-driven position.
 */
function stripHorizontalRootMotion(clip: AnimationClip, rootNames: Set<string>): void {
  for (const track of clip.tracks) {
    if (!track.name.endsWith('.position')) continue;
    const node = track.name.slice(0, track.name.lastIndexOf('.'));
    let matches = rootNames.has(node);
    if (!matches) {
      for (const r of rootNames) {
        if (node.endsWith(r)) {
          matches = true;
          break;
        }
      }
    }
    if (!matches) continue;
    const v = track.values as unknown as Float32Array;
    if (v.length < 3) continue;
    const x0 = v[0]!;
    const z0 = v[2]!;
    for (let i = 0; i < v.length; i += 3) {
      v[i] = x0;
      v[i + 2] = z0;
    }
  }
}

function resolveAssetUrl(path: string): string {
  // Relative to the document, so the same build works over http(s) and from the
  // file:// origin used inside the native shell.
  return new URL(path, document.baseURI).href;
}

/** One prepared prototype per model file. */
const sources = new Map<string, Promise<CharacterSource | null>>();

/**
 * GltfCharacter
 * -------------
 * Wraps an authored, skinned GLTF/GLB avatar and drives it from the same
 * `LocomotionState` the procedural model uses. Clips are matched to
 * idle / walk / run / jump / fall by keyword (or explicit manifest names),
 * cross-faded on state changes, and time-scaled to the real ground speed so the
 * feet don't skate.
 *
 * Drop-in compatible with `CharacterModel`: same `object`, `update`, `dispose`.
 *
 * The parsed model is cached module-wide and cloned per instance
 * (`SkeletonUtils.clone`), so scene switches — and later, remote players — reuse
 * one download and one set of GPU buffers.
 */
export class GltfCharacter {
  readonly object = new Group();
  /** Which clip name ended up driving each state. Surfaced for diagnostics. */
  readonly clipMap: Partial<Record<LocoState, string>> = {};

  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<LocoState, AnimationAction>();
  private readonly root: Object3D;
  private current: AnimationAction | null = null;
  private currentState: LocoState | null = null;
  private readonly walkClipSpeed: number;
  private readonly runClipSpeed: number;

  constructor(source: CharacterSource) {
    const { manifest } = source;
    this.walkClipSpeed = manifest.walkClipSpeed ?? GameConfig.player.walkSpeed;
    this.runClipSpeed = manifest.runClipSpeed ?? GameConfig.player.sprintSpeed;

    this.root = cloneSkinned(source.prototype);
    this.object.add(this.root);

    this.mixer = new AnimationMixer(this.root);
    this.bindClips(source.clips, manifest.clips);
    this.play('idle', 0);
  }

  /** Matches clips to locomotion states: explicit manifest names, then keywords. */
  private bindClips(clips: AnimationClip[], explicit?: Partial<Record<LocoState, string>>): void {
    if (clips.length === 0) return;
    const used = new Set<AnimationClip>();

    const register = (state: LocoState, clip: AnimationClip): void => {
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      if (state === 'jump') {
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(LoopRepeat, Infinity);
      }
      this.actions.set(state, action);
      this.clipMap[state] = clip.name;
      used.add(clip);
    };

    for (const state of STATES) {
      const wanted = explicit?.[state];
      if (!wanted) continue;
      const hit =
        clips.find((c) => c.name === wanted) ??
        clips.find((c) => normaliseName(c.name) === normaliseName(wanted));
      if (hit) register(state, hit);
    }

    for (const state of STATES) {
      if (this.actions.has(state)) continue;
      const words = KEYWORDS[state];
      const hit = clips.find((c) => !used.has(c) && words.some((w) => normaliseName(c.name).includes(w)));
      if (hit) register(state, hit);
    }

    // Idle is the state the player sees most, and it has no sensible fallback
    // (standing still while the walk cycle plays looks broken). If no clip
    // matched by name, take the first one nobody else claimed — assets often
    // call it something unguessable like "Survey" or "A_Pose".
    if (!this.actions.has('idle')) {
      const spare = clips.find((c) => !used.has(c));
      if (spare) register('idle', spare);
    }

    // Single-clip models (common for free assets): use it for everything rather
    // than standing frozen in bind pose.
    if (this.actions.size === 0) register('idle', clips[0]!);
  }

  /** Walks the fallback chain and returns the state that actually has a clip. */
  private resolveState(state: LocoState): LocoState | null {
    if (this.actions.has(state)) return state;
    for (const alt of FALLBACKS[state]) if (this.actions.has(alt)) return alt;
    const first = this.actions.keys().next();
    return first.done ? null : first.value;
  }

  private play(state: LocoState, fade = 0.18): void {
    const resolved = this.resolveState(state);
    if (!resolved) return;
    const next = this.actions.get(resolved);
    if (!next || next === this.current) return;

    const prevState = this.currentState;
    next.enabled = true;
    next.reset();
    // Keep the stride in phase when swapping walk <-> run, otherwise the feet
    // visibly snap every time sprint is pressed or released.
    if (
      this.current &&
      ((prevState === 'walk' && resolved === 'run') || (prevState === 'run' && resolved === 'walk'))
    ) {
      const prevDur = this.current.getClip().duration || 1;
      const nextDur = next.getClip().duration || 1;
      next.time = (this.current.time / prevDur) * nextDur;
    }
    next.setEffectiveWeight(1).fadeIn(fade).play();
    if (this.current) this.current.fadeOut(fade);
    this.current = next;
    this.currentState = resolved;
  }

  update(pos: Vector3, yaw: number, s: LocomotionState, dt: number): void {
    this.object.position.copy(pos);
    this.object.rotation.y = yaw;

    let want: LocoState;
    if (!s.grounded) want = 'fall';
    else if (s.speed01 > 0.58) want = 'run';
    else if (s.speed01 > 0.06) want = 'walk';
    else want = 'idle';
    this.play(want, want === 'fall' ? 0.1 : 0.18);

    if (this.current) {
      if (this.currentState === 'walk' || this.currentState === 'run') {
        const speed = s.speed01 * GameConfig.player.sprintSpeed;
        const ref = this.currentState === 'run' ? this.runClipSpeed : this.walkClipSpeed;
        this.current.timeScale = MathUtils.clamp(speed / Math.max(0.5, ref), 0.55, 1.85);
      } else {
        this.current.timeScale = 1;
      }
    }

    this.mixer.update(dt);
  }

  /**
   * Releases this instance. Geometry and materials belong to the cached
   * prototype and are deliberately kept alive for the next scene / player.
   */
  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.object.removeFromParent();
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  /**
   * Downloads and prepares a prototype, once per file. Resolves to `null` when the
   * model is missing — the caller then keeps the procedural figure.
   *
   * Cached per path rather than globally: with a character library the same
   * session loads several different models, and every one of them still has to be
   * downloaded and parsed only once no matter how many players wear it.
   */
  static prepare(manifest: CharacterManifest, modelPath?: string): Promise<CharacterSource | null> {
    const key = modelPath ?? `models/${manifest.url ?? 'character.glb'}`;
    let pending = sources.get(key);
    if (!pending) {
      pending = GltfCharacter.load(manifest, key);
      sources.set(key, pending);
    }
    return pending;
  }

  /** Convenience: prepare + instantiate, or `null` if nothing is installed. */
  static async tryLoad(
    manifest: CharacterManifest,
    modelPath?: string,
  ): Promise<GltfCharacter | null> {
    const source = await GltfCharacter.prepare(manifest, modelPath);
    return source ? new GltfCharacter(source) : null;
  }

  private static async load(
    manifest: CharacterManifest,
    modelPath: string,
  ): Promise<CharacterSource | null> {
    if (manifest.enabled === false) return null;

    const loader = new GLTFLoader();
    try {
      // Bundled with three, wasm inlined — nothing extra to ship. Covers models
      // compressed with gltfpack / gltf-transform.
      loader.setMeshoptDecoder(MeshoptDecoder);
    } catch {
      /* uncompressed models still load */
    }

    let gltf: GLTF;
    try {
      gltf = await loader.loadAsync(resolveAssetUrl(modelPath));
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      // A missing file is expected; anything else is worth reporting.
      if (!/\b404\b|not found|failed to fetch|networkerror/i.test(msg)) {
        console.warn(`[character] ${modelPath} could not be loaded: ${msg}`);
      }
      return null;
    }

    const clips: AnimationClip[] = [...gltf.animations];
    for (const path of manifest.animationUrls ?? []) {
      try {
        const anim = await loader.loadAsync(resolveAssetUrl(`models/${path}`));
        for (const clip of anim.animations) {
          // Mixamo names every download "mixamo.com", so fall back to the file
          // name — that's what the keyword matcher needs.
          if (/^mixamo/i.test(clip.name) || clip.name.trim() === '') {
            clip.name = path.replace(/\.(glb|gltf)$/i, '');
          }
          clips.push(clip);
        }
      } catch (err) {
        console.warn(`[character] animation ${path} skipped: ${String((err as Error)?.message ?? err)}`);
      }
    }

    const prototype = gltf.scene;
    GltfCharacter.normalise(prototype, manifest.height ?? 1.8, manifest.yawOffsetDeg ?? 180);

    if (manifest.stripRootMotion !== false) {
      const rootNames = new Set<string>();
      prototype.traverse((o) => {
        if ((o as Bone).isBone && !(o.parent as Bone | null)?.isBone) rootNames.add(o.name);
        if (/hips|pelvis/i.test(o.name)) rootNames.add(o.name);
      });
      for (const clip of clips) stripHorizontalRootMotion(clip, rootNames);
    }

    const names = clips.map((c) => c.name).join(', ') || 'none';
    console.info(`[character] loaded ${modelPath} — clips: ${names}`);
    return { prototype, clips, manifest };
  }

  /**
   * Scales the model to `height` metres, plants its feet on y = 0, centres it on
   * the controller and applies the facing offset — all baked into the prototype
   * so clones need no per-instance fixing.
   *
   * The yaw offset is applied by wrapping the model in a parent, not by rotating
   * it: rotating the armature would also rotate the animation's root motion axes.
   */
  private static normalise(prototype: Object3D, height: number, yawOffsetDeg: number): void {
    prototype.updateMatrixWorld(true);
    const box = new Box3().setFromObject(prototype);
    const size = new Vector3();
    box.getSize(size);
    const scale = size.y > 1e-3 ? height / size.y : 1;

    prototype.traverse((o: Object3D) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      // A skinned mesh's bounding sphere is computed in bind pose, so an
      // animated limb can push it outside the frustum and pop the whole
      // character away. It's a single model — always draw it.
      if ((mesh as SkinnedMesh).isSkinnedMesh) mesh.frustumCulled = false;
    });

    // Re-parent under a normalising wrapper.
    const inner = new Group();
    inner.name = 'characterModel';
    while (prototype.children.length > 0) inner.add(prototype.children[0]!);
    inner.scale.setScalar(scale);
    inner.position.set(
      -(box.min.x + size.x / 2) * scale,
      -box.min.y * scale,
      -(box.min.z + size.z / 2) * scale,
    );

    const facing = new Group();
    facing.name = 'characterFacing';
    facing.rotation.y = MathUtils.degToRad(yawOffsetDeg);
    facing.add(inner);
    prototype.add(facing);
    prototype.position.set(0, 0, 0);
    prototype.rotation.set(0, 0, 0);
    prototype.scale.setScalar(1);
  }
}
