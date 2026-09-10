import {
  Bone,
  Box3,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Object3D,
  type SkinnedMesh,
} from 'three';
// `Avatar` is already in the main chunk (every scene imports it), so reading the
// manifest through it costs nothing here and guarantees the portrait is framed for
// the same rig the avatars use.
import { loadCharacterManifest } from '../player/Avatar.ts';
import { resolveSkin, skinModelPath } from '../player/skins.ts';

/**
 * Portraits
 * ---------
 * A front view of each character's head and shoulders, for the player list.
 *
 * The expensive part of a portrait is not the pixels, it is the model — and the
 * model is already there: `GltfCharacter.prepare` caches one prepared prototype
 * per file for the avatars, so a portrait costs a clone of an object graph that
 * has already been downloaded, decompressed and normalised.
 *
 * Everything here is arranged around one fact: a portrait never changes. There
 * are seven characters, each has exactly one correct picture, so each is rendered
 * **once** into a 64x64 PNG data URL and that string is then handed to every row
 * wearing that skin for the rest of the session. Nothing is rendered per frame,
 * per player, or per open of the panel.
 *
 * The render is done by a second, throwaway `WebGLRenderer` rather than by
 * borrowing the game's: the game's renderer is mid-frame, has a post-processing
 * composer bound to it, and its size, clear colour and render target would all
 * have to be saved and restored around a portrait — for seven one-off draws. A
 * private 64x64 context is built when the first portrait is asked for and torn
 * down the moment the queue drains, so the cost is bounded and temporary.
 *
 * Work is spread over idle callbacks, one character at a time, so someone joining
 * in a skin nobody has seen yet cannot stall the frame. Until a portrait exists,
 * callers get `null` and fall back to the coloured chip.
 */

/** Pixels, square. 30 CSS px in the list, so this covers a 2x display. */
const PORTRAIT_SIZE = 64;
/**
 * How much of the figure to show, as a multiple of the head's own height: 1 would
 * be the head exactly, 1.5 brings the shoulders with it.
 *
 * Expressed relative to the head rather than in metres because these characters
 * are stylised and their heads are not the same size — measured against the rigs
 * in this library, the head is anywhere from 26% to 36% of the total height. A
 * fixed metre figure that frames the pirate correctly cuts the shark off, and one
 * that suits the shark leaves the pirate a dot in the middle. Anchoring on the
 * head makes every face the same size in its 30 px square, which is the only thing
 * this picture has to communicate.
 */
const HEAD_AND_SHOULDERS = 1.32;
/**
 * Frame height as a fraction of the whole figure, used when the rig has no head
 * bone to measure — or when it has one that is nowhere near the head, as the
 * headless skeleton does.
 */
const FALLBACK_FRACTION = 0.48;
/** Gap above the crown, as a fraction of the frame height. */
const HEADROOM = 0.04;
/** Long-ish lens: a wide one this close distorts the face badly. */
const FOV_DEG = 26;

/** skin id -> finished PNG data URL. */
const ready = new Map<string, string>();
/** Skins with no model, or a render that failed. Never retried. */
const unavailable = new Set<string>();
const queue: string[] = [];
let draining = false;

/**
 * The portrait for a skin, or `null` if it is not ready yet — in which case the
 * render is queued and the caller should show its fallback. Safe and cheap to
 * call every frame: the hit path is one map lookup.
 */
export function portraitFor(skinId: string | undefined): string | null {
  const id = resolveSkin(skinId).id;
  const hit = ready.get(id);
  if (hit !== undefined) return hit;
  if (unavailable.has(id) || queue.includes(id)) return null;
  queue.push(id);
  drain();
  return null;
}

interface IdleWindow {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
}

/** Runs `fn` when the browser is not busy, without holding up a frame. */
function whenIdle(fn: () => void): void {
  const idle = (window as unknown as IdleWindow).requestIdleCallback;
  if (typeof idle === 'function') idle(fn, { timeout: 1200 });
  else window.setTimeout(fn, 32);
}

function drain(): void {
  if (draining) return;
  draining = true;
  whenIdle(() => void step());
}

/**
 * Renders exactly one queued portrait, then hands the thread back before taking
 * the next. One character per idle slot: the load is cached and the draw is a
 * single 64x64 pass, but seven of them back to back would still be a visible
 * hitch on a weak machine.
 */
async function step(): Promise<void> {
  const id = queue.shift();
  if (id === undefined) {
    draining = false;
    releaseRig();
    return;
  }
  try {
    const url = await render(id);
    if (url) ready.set(id, url);
    else unavailable.add(id);
  } catch (err) {
    unavailable.add(id);
    console.warn(`[portraits] ${id} could not be drawn: ${String((err as Error)?.message ?? err)}`);
  }
  whenIdle(() => void step());
}

// --- The one-off renderer -----------------------------------------------------

interface Rig {
  renderer: WebGLRenderer;
  scene: Scene;
}

let rig: Rig | null = null;
/** Set if the context could not be created at all, so we stop trying. */
let rigFailed = false;

function acquireRig(): Rig | null {
  if (rig) return rig;
  if (rigFailed) return null;
  try {
    const renderer = new WebGLRenderer({
      alpha: true,
      antialias: true,
      // The drawing buffer is read back with `toDataURL` immediately after the
      // draw. That is normally safe, but only until the compositor decides to
      // clear it; preserving it removes the timing question entirely, and at
      // 64x64 the memory is irrelevant.
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    });
    renderer.setPixelRatio(1);
    renderer.setSize(PORTRAIT_SIZE, PORTRAIT_SIZE, false);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);

    const scene = new Scene();
    // No environment map here, so light has to come from actual lights or the
    // standard materials resolve to black. Bright and frontal on purpose: this is
    // a 30 px thumbnail, and a moody key light reads as a smudge.
    scene.add(new HemisphereLight(0xdff0ff, 0x2b3a2c, 1.5));
    const key = new DirectionalLight(0xfff4e2, 2.2);
    key.position.set(0.5, 1.1, -1.5);
    scene.add(key);
    const fill = new DirectionalLight(0xa8c8ff, 0.8);
    fill.position.set(-1.2, 0.3, 0.9);
    scene.add(fill);

    rig = { renderer, scene };
    return rig;
  } catch (err) {
    rigFailed = true;
    console.warn(`[portraits] no offscreen context: ${String((err as Error)?.message ?? err)}`);
    return null;
  }
}

/**
 * Gives the context back. Called when the queue empties, which — because every
 * portrait is cached forever — happens once per session after at most seven
 * renders. The lights and the scene go with it; nothing in them is shared.
 */
function releaseRig(): void {
  if (!rig) return;
  rig.renderer.dispose();
  // `dispose` releases three's own resources but leaves the GL context alive for
  // the driver to reclaim whenever it feels like it. Browsers cap how many
  // contexts a page may hold, so the game's own renderer is not left competing
  // with an abandoned one.
  rig.renderer.forceContextLoss();
  rig = null;
}

async function render(skinId: string): Promise<string | null> {
  const manifest = await loadCharacterManifest();
  if (!manifest) return null; // no authored characters installed
  // Dynamic, exactly as `Avatar` does it: the loader, the meshopt decoder and the
  // skeleton utilities are ~135 kB that a build with no authored characters should
  // never download. Asked for only once a portrait is actually wanted.
  const [{ GltfCharacter }, { clone }] = await Promise.all([
    import('../player/GltfCharacter.ts'),
    import('three/examples/jsm/utils/SkeletonUtils.js'),
  ]);
  // Shares the avatars' cache, keyed by path: if anybody is wearing this skin the
  // model is already parsed, and if nobody is, this is the one download they would
  // have paid for anyway.
  const source = await GltfCharacter.prepare(manifest, skinModelPath(skinId));
  if (!source) return null;

  const acquired = acquireRig();
  if (!acquired) return null;
  const { renderer, scene } = acquired;

  // A clone, never the prototype itself: the prototype is the cache, and parenting
  // it into this scene would take it out of whatever else expected to clone it.
  //
  // Note what is *not* done here. The geometry is used exactly as the loader
  // produced it — no `applyMatrix4`, no attribute rewriting. Meshopt models keep
  // their positions as normalised Int16 with the real scale up in the node
  // transform, so baking a transform into such an attribute silently clamps the
  // whole mesh into a 1-metre cube (see `world/PropModels.ts`), and re-creating or
  // dropping attributes is how a vertex-coloured model ends up solid black.
  // Cloning the object graph and pointing a camera at it touches neither.
  const figure = clone(source.prototype);
  scene.add(figure);

  const box = new Box3().setFromObject(figure);
  if (box.isEmpty()) {
    detach(scene, figure);
    return null;
  }
  const centre = new Vector3();
  box.getCenter(centre);

  // Head and shoulders: hold the crown just under the top edge, and let the head's
  // own height decide how much of the body comes with it.
  const top = box.max.y;
  const headY = headBoneHeight(figure, top);
  const frame =
    headY !== null ? (top - headY) * HEAD_AND_SHOULDERS : (top - box.min.y) * FALLBACK_FRACTION;
  const eyeY = top + frame * HEADROOM - frame / 2;
  const distance = frame / 2 / Math.tan((FOV_DEG / 2) * (Math.PI / 180));
  const camera = new PerspectiveCamera(FOV_DEG, 1, 0.05, 40);
  // The rigs are normalised to face -Z (the manifest's yaw offset is baked into
  // the prototype), which is also the way a player faces at yaw 0 — so -Z is the
  // front, and this is the view you get walking towards them.
  camera.position.set(centre.x, eyeY, centre.z - distance);
  camera.lookAt(centre.x, eyeY, centre.z);

  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  detach(scene, figure);
  return url;
}

/**
 * World height of the rig's head bone, or `null` if it cannot be trusted.
 *
 * The bone is the base of the skull, so `crown - bone` is the head's height — the
 * one measurement that makes the framing work across characters built to different
 * proportions. Rejected when it lands at or above the crown, which is exactly what
 * the headless skeleton reports: the bone is still in the rig, the head it belongs
 * to is not, and its recorded position is above the top of the mesh.
 */
function headBoneHeight(figure: Object3D, top: number): number | null {
  let best: number | null = null;
  const at = new Vector3();
  figure.traverse((o) => {
    if (!(o as Bone).isBone || !/head/i.test(o.name)) return;
    o.getWorldPosition(at);
    // Far enough below the crown to actually be a head, and not the neck.
    if (at.y >= top - 0.08) return;
    if (best === null || at.y > best) best = at.y;
  });
  return best;
}

/**
 * Removes a rendered figure. Geometry, materials and textures belong to the cached
 * prototype and to every avatar cloned from it, so they are deliberately left
 * alone; the only GPU resource this clone owns is the bone texture its own
 * skeleton built on first draw.
 */
function detach(scene: Scene, figure: Object3D): void {
  figure.traverse((o) => {
    const skinned = o as SkinnedMesh;
    if (skinned.isSkinnedMesh) skinned.skeleton?.dispose();
  });
  scene.remove(figure);
}
