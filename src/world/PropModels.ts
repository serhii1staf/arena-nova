import {
  Box3,
  BufferAttribute,
  type BufferGeometry,
  Group,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * PropModels
 * ----------
 * The authored static props: houses, docks, a ship, barrels, bones. One shared
 * GLB, loaded once, cloned per placement.
 *
 * All fourteen models were merged into a single file before shipping. Converted
 * separately they came to 2.4 MB because each one embedded its own copy of the
 * pack's texture atlas; merged and deduplicated it is 420 kB with one atlas and
 * two materials, which also means every village in the world draws from the same
 * few materials instead of one set per building.
 *
 * Scale is applied globally rather than per model. The pack is internally
 * consistent, so normalising each prop to its own target height would quietly
 * destroy the proportions between a house, a barrel and a ship; one factor
 * derived from a reference building keeps them in agreement.
 *
 * Clones share geometry and materials with the prototype, so a streamer must not
 * dispose them on unload — every mesh is tagged `userData.shared` to make that
 * checkable from the outside.
 */

/** Where the merged pack lives, relative to the document. */
const MODEL_PATH = 'models/props/village.glb';

export type PropName =
  | 'Environment_House1'
  | 'Environment_House2'
  | 'Environment_House3'
  | 'Environment_Dock'
  | 'Environment_Dock_Broken'
  | 'Environment_Dock_Pole'
  | 'Environment_Sawmill'
  | 'Ship_Small'
  | 'Prop_Barrel'
  | 'Prop_Chest_Closed'
  | 'Environment_Skulls'
  | 'Environment_LargeBones'
  | 'Prop_Anchor'
  | 'Prop_Cannon';

/**
 * Height in metres each prop should end up, keyed by name.
 *
 * These have to be given per prop, not derived from one global factor. The pack
 * is authored with every model normalised into its own roughly two-unit box, so
 * the source files carry no shared sense of scale at all: a single factor tuned
 * to make a house the right size produced a half-metre sawmill and a pile of
 * skulls three metres tall. Aspect ratios inside each model are of course kept.
 */
const TARGET_HEIGHT: Record<PropName, number> = {
  Environment_House1: 4.6, // a wide longhouse — this height puts it at ~9 m across
  Environment_House2: 5.2,
  Environment_House3: 5.6,
  Environment_Sawmill: 2.6,
  Environment_Dock: 2.2,
  Environment_Dock_Broken: 2.2,
  Environment_Dock_Pole: 2.4,
  Ship_Small: 3.6,
  Prop_Barrel: 0.9,
  Prop_Chest_Closed: 0.7,
  Prop_Cannon: 0.8,
  Environment_Skulls: 0.5,
  Environment_LargeBones: 0.75,
  // Lies flat, so its height is a poor handle: this yields roughly 2 m of fluke.
  Prop_Anchor: 0.25,
};

export interface PropShape {
  /** Horizontal radius after scaling, for collider registration. */
  radius: number;
  /** Half-extents after scaling. Buildings here are long and shallow, so a single
   *  circle inscribed on the long axis blocks the player metres away from the
   *  short walls; callers need the real box to lay out a row of circles. */
  halfX: number;
  halfZ: number;
  /** Height after scaling. */
  height: number;
}

export interface PropSet {
  /** A fresh clone, base planted on y = 0 and centred horizontally. */
  instance(name: PropName): Object3D | null;
  /** Footprint of a prop, so callers can register collision without guessing. */
  shape(name: PropName): PropShape | null;
  has(name: PropName): boolean;
}

interface Prototype {
  object: Object3D;
  shape: PropShape;
}

/** Resolved once; `null` when the pack is missing, which is not an error. */
let pending: Promise<PropSet | null> | null = null;

/**
 * Converts quantised attributes back to plain floats, in place.
 *
 * Meshopt compression stores positions as normalised 16-bit integers and keeps
 * the real scale in the node's transform. `BufferGeometry.applyMatrix4` writes its
 * results back into whatever array the attribute already has, so baking a
 * metre-scale transform into a normalised integer attribute silently clamps every
 * coordinate into [-1, 1]. The symptom was a village whose geometry spanned
 * exactly minus one to one metre and therefore sat a metre through the ground,
 * while looking almost right because the clamp is proportional.
 *
 * Exported because every meshopt-compressed pack hits this, not just this one —
 * `GrassModels` loads a second pack and needs the same first step.
 */
export function dequantize(geo: BufferGeometry): void {
  for (const name of Object.keys(geo.attributes)) {
    const attr = geo.attributes[name] as BufferAttribute;
    if (!attr.normalized && attr.array instanceof Float32Array) continue;
    const items = attr.itemSize;
    const out = new Float32Array(attr.count * items);
    for (let i = 0; i < attr.count; i++) {
      // The getters apply the normalisation, which is exactly what has to be
      // baked out here.
      out[i * items] = attr.getX(i);
      if (items > 1) out[i * items + 1] = attr.getY(i);
      if (items > 2) out[i * items + 2] = attr.getZ(i);
      if (items > 3) out[i * items + 3] = attr.getW(i);
    }
    geo.setAttribute(name, new BufferAttribute(out, items));
  }
}

/** The attribute set every prop is normalised to, in this order. */
const KEEP = ['position', 'normal', 'uv', 'color'] as const;

/**
 * Gives every geometry exactly the same attributes, filling in any it lacks.
 *
 * Two separate problems, one fix. The pack's materials use vertex colours, so
 * dropping the `color` attribute leaves the shader reading an unbound attribute —
 * which comes through as zero, and the buildings render solid black. And the props
 * are not uniform: the houses carry colours while the docks do not, so merging a
 * mixed village by material fails outright unless the sets are made to match
 * first. Missing colours default to white and missing UVs to zero, both of which
 * are no-ops for the material.
 */
function conform(geo: BufferGeometry): void {
  const count = geo.attributes.position?.count ?? 0;
  for (const name of Object.keys(geo.attributes)) {
    if (!(KEEP as readonly string[]).includes(name)) geo.deleteAttribute(name);
  }
  if (count === 0) return;
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (!geo.attributes.color) {
    const white = new Float32Array(count * 3).fill(1);
    geo.setAttribute('color', new BufferAttribute(white, 3));
  }
}

function resolveUrl(path: string): string {
  // Relative to the document, so the same build works over http(s) and from the
  // file:// origin the native shell uses.
  return new URL(path, document.baseURI).href;
}

/**
 * Loads the pack, once per session. Resolves to `null` if it is not installed —
 * the world then simply has no villages rather than failing to build.
 */
export function loadPropModels(): Promise<PropSet | null> {
  pending ??= load();
  return pending;
}

async function load(): Promise<PropSet | null> {
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
    // The merge kept one scene per source file, each holding a single named root.
    scenes = gltf.scenes.length > 0 ? gltf.scenes : [gltf.scene];
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (!/404|Failed to fetch|NetworkError/i.test(message)) {
      console.warn(`[props] pack unavailable: ${message}`);
    }
    return null;
  }

  // Collect the named roots out of every scene.
  const raw = new Map<string, Object3D>();
  for (const scene of scenes) {
    for (const child of [...scene.children]) {
      if (child.name) raw.set(child.name, child);
    }
  }
  if (raw.size === 0) {
    console.warn('[props] pack contained no named roots');
    return null;
  }

  const box = new Box3();
  const size = new Vector3();
  // Reused across the loop; none of them outlive it.
  const normalise = new Matrix4();
  const scaleMatrix = new Matrix4();
  const baked = new Matrix4();
  const prototypes = new Map<string, Prototype>();
  for (const [name, node] of raw) {
    const target = TARGET_HEIGHT[name as PropName];
    if (target === undefined) continue; // a model we do not place
    node.updateMatrixWorld(true);
    box.setFromObject(node);
    box.getSize(size);
    const scale = size.y > 1e-3 ? target / size.y : 1;

    // Bake the normalisation straight into the geometry, once, and flatten the
    // model to a single level of meshes.
    //
    // Nesting transformed Groups looks equivalent and is not: the model arrives
    // with its own hierarchy of transforms, the bounding box is measured *through*
    // them, and anything that later reads the geometry has to compose the whole
    // chain correctly to agree with that box. Merging did not, and the result was
    // props sunk a metre into the ground. Baking removes the chain entirely, so a
    // clone carries nothing but its placement.
    normalise
      .makeTranslation(
        -(box.min.x + size.x / 2) * scale,
        -box.min.y * scale,
        -(box.min.z + size.z / 2) * scale,
      )
      .multiply(scaleMatrix.makeScale(scale, scale, scale));

    const wrapper = new Group();
    wrapper.name = name;
    node.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const geo = mesh.geometry.clone();
      dequantize(geo);
      conform(geo);
      geo.applyMatrix4(baked.multiplyMatrices(normalise, mesh.matrixWorld));
      const flat = new Mesh(geo, mesh.material);
      flat.castShadow = true;
      flat.receiveShadow = true;
      // Marks geometry and materials as the prototype's, so a chunk unloading a
      // clone knows not to dispose them out from under every other village.
      flat.userData.shared = true;
      wrapper.add(flat);
    });
    if (wrapper.children.length === 0) continue;

    prototypes.set(name, {
      object: wrapper,
      shape: {
        radius: (Math.max(size.x, size.z) * scale) / 2,
        halfX: (size.x * scale) / 2,
        halfZ: (size.z * scale) / 2,
        height: size.y * scale,
      },
    });
  }

  console.info(`[props] pack ready — ${prototypes.size} models`);

  return {
    instance(name) {
      const proto = prototypes.get(name);
      return proto ? proto.object.clone(true) : null;
    },
    shape(name) {
      return prototypes.get(name)?.shape ?? null;
    },
    has(name) {
      return prototypes.has(name);
    },
  };
}

/**
 * Collapses a built group of cloned props into one mesh per material.
 *
 * A hamlet is a dozen or so props, and cloned props are individual meshes — which
 * came to seventeen draw calls per village and pushed the world over its draw
 * budget with only a couple of them loaded. The pack ships two materials in total,
 * so baking every clone's transform into its geometry and merging by material
 * turns a whole village into two draws.
 *
 * The merged geometry is new and belongs to the caller: unlike the clones it
 * replaces, it must be disposed when the chunk unloads. Materials are still the
 * prototype's and must not be.
 */
export function mergeAuthored(root: Object3D): Mesh[] {
  root.updateMatrixWorld(true);

  const byMaterial = new Map<Material, BufferGeometry[]>();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const material = mesh.material as Material;
    if (Array.isArray(mesh.material)) return; // multi-material props would need splitting

    // Bake the placement. The prototypes were already dequantised and given a
    // uniform attribute set at load, so nothing here has to touch attributes.
    //
    // The index is kept. `mergeGeometries` merges indexed inputs by offsetting
    // their indices, so expanding each part with `toNonIndexed` first was
    // triplicating every vertex only to hand the result to something that did not
    // need it — and it is not a cheap triplication: an authored house is eight to
    // twelve thousand triangles, so a hamlet went through a few hundred thousand
    // vertices of allocate-and-copy, twice over, on the frame that built it. That
    // was measured as the single most expensive thing the world does, at over
    // 200 ms of CPU for one village, which is what made stepping out of the lobby
    // drop the frame rate.
    const geo = mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrixWorld);

    let list = byMaterial.get(material);
    if (!list) byMaterial.set(material, (list = []));
    list.push(geo);
  });

  const out: Mesh[] = [];
  for (const [material, parts] of byMaterial) {
    // `mergeGeometries` requires the parts to agree on whether they are indexed.
    // The pack is one file and comes out uniform, so this is normally free; the
    // fallback exists because a silent `null` here would delete a village.
    const indexed = parts.filter((p) => p.index !== null).length;
    if (indexed !== 0 && indexed !== parts.length) {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]!;
        if (p.index === null) continue;
        const flat = p.toNonIndexed();
        p.dispose();
        parts[i] = flat;
      }
    }

    const merged = parts.length === 1 ? parts[0]! : mergeGeometries(parts, false);
    if (parts.length > 1) {
      for (const p of parts) p.dispose();
    }
    if (!merged) continue;
    const mesh = new Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}
