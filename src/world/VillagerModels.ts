import {
  AnimationClip,
  AnimationMixer,
  Group,
  LoopRepeat,
  Object3D,
  type AnimationAction,
  type Mesh,
  type Object3DEventMap,
} from 'three';

/**
 * VillagerModels
 * --------------
 * The authored villager and farm-animal models, loaded once and cloned per body.
 *
 * Deliberately its own loader rather than going through `Avatar`. `Avatar` exists to carry the
 * *player*: it builds a forty-mesh procedural body immediately so there is something on screen
 * during the first frame, then swaps in a skinned model when the download finishes. For a crew
 * of villagers that first body is pure waste — it is forty meshes and a cloth simulation per
 * villager, discarded a moment later, and the villagers have no reason to exist before their
 * model does.
 *
 * So: nothing appears until the model is there, one parsed prototype per file for the whole
 * session, and each body is a skeleton clone sharing that prototype's geometry and materials.
 * The only per-body cost is the clone's object graph and one `AnimationMixer`.
 */

/** Where the pack lives, relative to the document. */
const DIR = 'models/villagers/';

/**
 * The models, and how tall each should end up in metres.
 *
 * The pack is authored around a two-unit character, so every model needs scaling to the game's
 * own sense of size — the player is about 1.8 m. Given per model rather than as one factor,
 * because a cow is not a scaled person.
 */
/**
 * Uniform scale per model, baked rather than measured at runtime.
 *
 * Measured offline from the vertex position extents in each GLB, which is exact and cannot
 * vary: the bare-headed characters stand 3.20 units in bind pose, so 0.562 puts them at 1.8 m.
 *
 * One factor for every human, deliberately, and not a per-model normalisation to a target
 * height. The pack is internally consistent, and the reason its total heights differ at all is
 * *hats*: the old gentleman measures 3.77 units and the viking 3.63 because of a top hat and a
 * helmet. Normalising each to the same height therefore shrinks the body of anyone wearing one —
 * which is the "some villagers are very small" report. With a shared factor the bodies agree and
 * the hats stick up, which is what a hat is for.
 *
 * Measuring at load was the previous approach and it is the thing being replaced: a skinned
 * bounding box is the bind pose, the pack's node hierarchies carry their own scales, and the
 * result was a number that varied per file for reasons that had nothing to do with how tall
 * anybody is.
 */
const HUMAN_SCALE = 1.8 / 3.204;

export const VILLAGER_MODELS = {
  Worker_Male: HUMAN_SCALE,
  Worker_Female: HUMAN_SCALE,
  Chef_Male: HUMAN_SCALE,
  Casual_Male: HUMAN_SCALE,
  Casual2_Female: HUMAN_SCALE,
  Viking_Male: HUMAN_SCALE,
  OldClassy_Male: HUMAN_SCALE,
  Cowboy_Female: HUMAN_SCALE,
  // Its own, because a cow is not a scaled person: 2.909 units in bind pose to 1.5 m at the
  // shoulder.
  Cow: 1.5 / 2.909,
  // A pug is knee-high. 2.835 units to 0.45 m.
  Pug: 0.45 / 2.835,
} as const;

export type VillagerModel = keyof typeof VILLAGER_MODELS;

/** A body: its own object graph, its own mixer, sharing the prototype's geometry. */
export interface VillagerBody {
  object: Object3D;
  /** Plays `walk` when moving and `idle` when not. Speed scales the walk's playback. */
  animate(moving: boolean, speed: number, dt: number): void;
  dispose(): void;
}

interface Prototype {
  scene: Object3D;
  clips: AnimationClip[];
  /** Uniform scale that puts the model at its target height. */
  scale: number;
}

/** One parsed prototype per file, for the session. Cloning is cheap; parsing is not. */
const protos = new Map<VillagerModel, Promise<Prototype | null>>();

function resolveUrl(path: string): string {
  const base = document.baseURI ?? `${location.origin}/`;
  return new URL(path, base).href;
}

async function load(name: VillagerModel): Promise<Prototype | null> {
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(resolveUrl(`${DIR}${name}.glb`));
    const scene = gltf.scene;
    const scale = VILLAGER_MODELS[name];
    // Shadows on, frustum culling off for skinned meshes: a skinned bounding box is the *bind
     // pose* box, so an animating character gets culled while still on screen.
    scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
    });
    return { scene, clips: gltf.animations ?? [], scale };
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (!/404|Failed to fetch|NetworkError/i.test(message)) {
      console.warn(`[villagers] ${name} unavailable: ${message}`);
    }
    return null;
  }
}

export function loadVillagerModel(name: VillagerModel): Promise<Prototype | null> {
  let p = protos.get(name);
  if (!p) protos.set(name, (p = load(name)));
  return p;
}

/**
 * A body from a loaded prototype.
 *
 * `SkeletonUtils.clone` is the only correct way to copy a skinned hierarchy: a plain `clone()`
 * shares the skeleton, so every villager built from one prototype would move as one body.
 */
export async function makeVillagerBody(name: VillagerModel): Promise<VillagerBody | null> {
  const proto = await loadVillagerModel(name);
  if (!proto) return null;
  const { clone } = await import('three/examples/jsm/utils/SkeletonUtils.js');

  const root = new Group() as Group<Object3DEventMap>;
  const body = clone(proto.scene);
  body.scale.setScalar(proto.scale);
  // The pack faces +Z; everything in this game faces -Z, the same convention the player and
  // the wildlife use, so the model is turned once here rather than at every call site.
  body.rotation.y = Math.PI;
  root.add(body);

  const mixer = new AnimationMixer(body);
  const find = (want: string): AnimationAction | null => {
    const clip = proto.clips.find((c) => c.name.toLowerCase() === want);
    if (!clip) return null;
    const action = mixer.clipAction(clip);
    action.loop = LoopRepeat;
    return action;
  };
  const idle = find('idle');
  const walk = find('walk');
  idle?.play();
  walk?.play();
  if (walk) walk.weight = 0;
  if (idle) idle.weight = 1;

  /** Eased blend, so a villager does not snap between standing and striding. */
  let blend = 0;

  return {
    object: root,
    animate(moving, speed, dt) {
      const want = moving ? 1 : 0;
      blend += (want - blend) * Math.min(1, dt * 6);
      if (idle) idle.weight = 1 - blend;
      if (walk) {
        walk.weight = blend;
        // Playback follows real speed so the feet do not skate. The clip is authored at
        // roughly walking pace, so the ratio is against that rather than against 1 m/s.
        walk.timeScale = Math.max(0.5, Math.min(1.7, speed / 1.1));
      }
      mixer.update(dt);
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(body);
      root.removeFromParent();
      // Geometry and materials belong to the prototype and are shared by every other body
      // cloned from it, so nothing here is disposed.
    },
  };
}
