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
export const VILLAGER_MODELS = {
  Worker_Male: 1.8,
  Worker_Female: 1.75,
  Chef_Male: 1.8,
  Casual_Male: 1.8,
  Casual2_Female: 1.74,
  Viking_Male: 1.86,
  OldClassy_Male: 1.76,
  Cowboy_Female: 1.75,
  Cow: 1.5,
  Pug: 0.5,
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
    const [{ GLTFLoader }, { Box3, Vector3 }] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three'),
    ]);
    const gltf = await new GLTFLoader().loadAsync(resolveUrl(`${DIR}${name}.glb`));
    const scene = gltf.scene;
    // Measured before anything is scaled, so the factor is derived rather than guessed.
    const box = new Box3().setFromObject(scene);
    const size = new Vector3();
    box.getSize(size);
    const target = VILLAGER_MODELS[name];
    const scale = size.y > 1e-3 ? target / size.y : 1;
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
