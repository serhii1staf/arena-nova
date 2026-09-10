import {
  Box3,
  BufferAttribute,
  type BufferGeometry,
  Color,
  Matrix4,
  Mesh,
  type Object3D,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { dequantize } from './PropModels.ts';

/**
 * GrassModels
 * -----------
 * The authored grass clumps, from the Ultimate Platformer Pack (CC0). One small
 * clump and one large one, loaded once and instanced everywhere by `Scatter`.
 *
 * These replace the procedural two-blade tuft in the near field. A tuft is six
 * triangles and reads as two flat cards from anywhere but straight on; a clump is
 * a modelled bunch of tapering blades leaning in every direction, which is what
 * makes the ground look like it is growing something. The cost is roughly ten
 * times the triangles per placement, so `Scatter` spends them on a small radius
 * around the player and keeps the cheap tufts for everything further out.
 *
 * The pack's own material is not used. Its base colour map turns out to be a pure
 * vertical gradient — dark green at the bottom of the image, bright yellow-green
 * at the top — and the blades are UV-mapped root-to-tip down it. So the whole
 * texture is baked into the `color` attribute by looking the gradient up per
 * vertex, and the clumps then share the world's existing wind-swaying,
 * vertex-coloured grass material instead of dragging in a second material and a
 * 1024² atlas worth 5.6 MB of VRAM to say "green".
 *
 * Everything returned here is shared by every clump in the world and must never
 * be disposed by a caller — tagged `userData.shared`, the same convention
 * `PropModels` uses.
 */

/** Where the converted pack lives, relative to the document. */
const MODEL_PATH = 'models/nature/grass.glb';

export type GrassName = 'Grass_Small' | 'Grass_Large';

/**
 * Height in metres each clump should end up.
 *
 * Set per model, not derived from one factor. The pack normalises every model
 * into its own roughly two-unit box, so the source files carry no shared sense of
 * scale: as authored these two are 0.39 m and 0.49 m tall, which is not the ratio
 * they should be drawn at. Measured and pinned here instead, close to the 0.72 m
 * procedural tuft they stand beside so the two layers agree about how tall grass
 * is. Aspect ratios inside each clump are of course kept.
 */
const TARGET_HEIGHT: Record<GrassName, number> = {
  Grass_Small: 0.46,
  Grass_Large: 0.7,
};

/**
 * The pack's gradient, read off its base colour map: the bottom of the image and
 * the top of it. `uv.y` runs 0 at the top (glTF's UV origin is top-left), and the
 * blades are mapped with their tips at the top — so tip colour is `TIP` and root
 * colour is `ROOT`, with everything between interpolated.
 *
 * Written in the same numeric convention as the rest of the flora palette in
 * `Flora.ts`, which these clumps sit among, and which happens to land within a
 * few percent of the pack's own colours anyway.
 */
const ROOT = new Color(0.16, 0.28, 0.07);
const TIP = new Color(0.5, 0.6, 0.16);

/**
 * A per-clump shift on the tip colour, for the same reason `Flora` builds its
 * second tuft variant with a different tint: two clumps in the same green look
 * like one clump stamped twice.
 */
const TIP_SHIFT: Record<GrassName, Color> = {
  Grass_Small: TIP,
  Grass_Large: new Color(0.54, 0.58, 0.19),
};

export interface GrassModels {
  /** Clump geometry, base planted on y = 0 and centred horizontally. */
  geometry(name: GrassName): BufferGeometry | null;
  /** Triangles per instance, for the frame budget. */
  triangles(name: GrassName): number;
}

/** Resolved once; `null` when the pack is missing, which is not an error. */
let pending: Promise<GrassModels | null> | null = null;

/**
 * The attribute set the grass material needs, in this order.
 *
 * `color` has to be here even though it is derived rather than authored: the
 * material has `vertexColors` on, and a geometry without a `color` attribute
 * leaves the shader reading an unbound attribute, which comes through as zero and
 * renders the grass solid black. `aSway` is the wind shader's compliance weight,
 * unbound in exactly the same way — grass that does not move at all in a gust,
 * with no error anywhere to explain it.
 */
const KEEP = ['position', 'normal', 'color', 'aSway'] as const;

/**
 * Bakes the pack's gradient into vertex colours, then brings the geometry to the
 * attribute set the grass material expects.
 *
 * Order matters: this reads `uv`, and then drops it — nothing downstream samples
 * a texture, and leaving it would make the attribute sets differ from the
 * procedural tufts these are merged and bucketed alongside.
 */
function conform(geo: BufferGeometry, tip: Color): void {
  const count = geo.attributes.position?.count ?? 0;
  if (count === 0) return;

  const uv = geo.attributes.uv as BufferAttribute | undefined;
  const colours = new Float32Array(count * 3);
  const sway = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // No UVs at all would mean a flat tip colour rather than solid black, which
    // is the failure worth defending against.
    const v = uv ? Math.min(1, Math.max(0, uv.getY(i))) : 0;
    colours[i * 3] = tip.r + (ROOT.r - tip.r) * v;
    colours[i * 3 + 1] = tip.g + (ROOT.g - tip.g) * v;
    colours[i * 3 + 2] = tip.b + (ROOT.b - tip.b) * v;
    // Grass gives to the wind along its whole length; there is no woody part to
    // hold anything still. The sway shader squares the height above the pivot, so
    // a flat weight of one still leaves the roots planted.
    sway[i] = 1;
  }

  for (const name of Object.keys(geo.attributes)) {
    if (!(KEEP as readonly string[]).includes(name)) geo.deleteAttribute(name);
  }
  geo.setAttribute('color', new BufferAttribute(colours, 3));
  geo.setAttribute('aSway', new BufferAttribute(sway, 1));
  if (!geo.attributes.normal) geo.computeVertexNormals();
}

function resolveUrl(path: string): string {
  // Relative to the document, so the same build works over http(s) and from the
  // file:// origin the native shell uses.
  return new URL(path, document.baseURI).href;
}

/**
 * Loads the clumps, once per session. Resolves to `null` if the pack is not
 * installed — the near field then keeps the procedural tufts rather than the
 * world failing to build.
 */
export function loadGrassModels(): Promise<GrassModels | null> {
  pending ??= load();
  return pending;
}

async function load(): Promise<GrassModels | null> {
  let scenes: Object3D[];
  try {
    const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three/examples/jsm/libs/meshopt_decoder.module.js'),
    ]);
    const loader = new GLTFLoader();
    try {
      loader.setMeshoptDecoder(MeshoptDecoder);
    } catch {
      /* an uncompressed pack still loads */
    }
    const gltf = await loader.loadAsync(resolveUrl(MODEL_PATH));
    // The conversion kept one scene per source file, each holding a single named
    // root.
    scenes = gltf.scenes.length > 0 ? gltf.scenes : [gltf.scene];
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (!/404|Failed to fetch|NetworkError/i.test(message)) {
      console.warn(`[grass] pack unavailable: ${message}`);
    }
    return null;
  }

  const raw = new Map<string, Object3D>();
  for (const scene of scenes) {
    for (const child of scene.children) {
      if (child.name) raw.set(child.name, child);
    }
  }

  const box = new Box3();
  const size = new Vector3();
  // Reused across the loop; neither outlives it.
  const normalise = new Matrix4();
  const scaleMatrix = new Matrix4();
  const baked = new Matrix4();
  const built = new Map<GrassName, BufferGeometry>();

  for (const name of Object.keys(TARGET_HEIGHT) as GrassName[]) {
    const node = raw.get(name);
    if (!node) continue;
    node.updateMatrixWorld(true);
    box.setFromObject(node);
    box.getSize(size);
    const scale = size.y > 1e-4 ? TARGET_HEIGHT[name] / size.y : 1;

    // Centre horizontally and plant the base on y = 0, then bake that straight
    // into the geometry along with the node's own transform. Instancing composes
    // one matrix per clump and reads nothing else, so anything left in a node
    // hierarchy here would simply be lost.
    normalise
      .makeTranslation(
        -(box.min.x + size.x / 2) * scale,
        -box.min.y * scale,
        -(box.min.z + size.z / 2) * scale,
      )
      .multiply(scaleMatrix.makeScale(scale, scale, scale));

    const parts: BufferGeometry[] = [];
    node.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const geo = mesh.geometry.clone();
      // Before any `applyMatrix4`, always. The pack is meshopt-compressed, so
      // positions arrive as normalised Int16 with the real scale up in the node
      // transform — see `dequantize` in PropModels for what baking a metre-scale
      // matrix into that array does.
      dequantize(geo);
      conform(geo, TIP_SHIFT[name]);
      geo.applyMatrix4(baked.multiplyMatrices(normalise, mesh.matrixWorld));
      parts.push(geo);
    });
    if (parts.length === 0) continue;

    const merged = parts.length === 1 ? parts[0]! : mergeGeometries(parts, false);
    if (parts.length > 1) {
      for (const p of parts) p.dispose();
    }
    if (!merged) continue;
    merged.computeBoundingSphere();
    // Shared by every clump in the world: a chunk unloading its instanced meshes
    // must not dispose this out from under all the others.
    merged.userData.shared = true;
    merged.userData.authored = true;
    built.set(name, merged);
  }

  if (built.size === 0) {
    console.warn('[grass] pack contained no usable clumps');
    return null;
  }

  const triangleCount = (geo: BufferGeometry): number =>
    (geo.index ? geo.index.count : geo.attributes.position.count) / 3;

  console.info(
    `[grass] pack ready — ${[...built]
      .map(([n, g]) => `${n} ${triangleCount(g)} tris`)
      .join(', ')}`,
  );

  return {
    geometry: (name) => built.get(name) ?? null,
    triangles: (name) => {
      const geo = built.get(name);
      return geo ? triangleCount(geo) : 0;
    },
  };
}
