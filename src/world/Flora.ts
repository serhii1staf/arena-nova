import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Flora
 * -----
 * Procedural plant geometry, one merged vertex-coloured mesh per species so each
 * can be instanced thousands of times with a single material. Every builder is
 * seeded, so the same seed always yields the same plant.
 */

export type TreeKind = 'jungle' | 'palm' | 'sakura' | 'pine' | 'acacia' | 'dead';

function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967295);
}

/**
 * How much wind a woody part gives to. Trunks and branches keep a little so a
 * tree reads as bending rather than as a rigid pole with a wobbling hat, but
 * nothing like the foliage. Before this existed the sway was masked by height
 * alone, so the bare trunk above the pivot swung as hard as the leaves — which
 * is exactly the "the sticks are moving, not the leaves" complaint.
 */
const WOOD_SWAY = 0.22;

/**
 * Attaches a flat vertex colour so parts can share one material when merged,
 * plus the wind-compliance weight the sway shader reads. Every part goes through
 * here, which is what guarantees the attribute sets match at merge time.
 */
function paint(geo: BufferGeometry, c: Color, sway = 1): BufferGeometry {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const swayArr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
    swayArr[i] = sway;
  }
  geo.setAttribute('color', new BufferAttribute(arr, 3));
  geo.setAttribute('aSway', new BufferAttribute(swayArr, 1));
  return geo;
}

function mergeParts(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(
    parts.map((p) => (p.index ? p.toNonIndexed() : p)),
    false,
  );
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('Flora: geometry merge failed (mismatched attributes)');
  return merged;
}

/**
 * A smooth tapering trunk swept along a gently curved spine. Building it as one
 * tube avoids the "stacked boxes" look that separate cylinder segments produce
 * wherever the trunk leans.
 */
function buildTrunk(
  height: number,
  baseRadius: number,
  lean: number,
  leanDir: number,
  taper: number,
  radialSegments = 7,
): { geo: BufferGeometry; top: Vector3 } {
  const spine: Vector3[] = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bend = lean * t * t * height * 0.3;
    spine.push(new Vector3(Math.cos(leanDir) * bend, t * height, Math.sin(leanDir) * bend));
  }
  const curve = new CatmullRomCurve3(spine, false, 'catmullrom', 0.5);
  // Few rings along the trunk: it is instanced thousands of times, and the
  // silhouette barely changes above ~6 segments.
  const geo = new TubeGeometry(curve, 6, baseRadius, radialSegments, false);

  // Narrow the tube toward the crown by pulling each ring in to its centre.
  const p = geo.attributes.position;
  const tmp = new Vector3();
  for (let i = 0; i < p.count; i++) {
    tmp.set(p.getX(i), p.getY(i), p.getZ(i));
    const t = Math.min(1, Math.max(0, tmp.y / height));
    const c = curve.getPointAt(t);
    const k = 1 - t * taper;
    p.setXYZ(i, c.x + (tmp.x - c.x) * k, tmp.y, c.z + (tmp.z - c.z) * k);
  }
  geo.computeVertexNormals();
  return { geo, top: spine[spine.length - 1]! };
}

/** Irregular, squashed canopy lobe. */
function canopyLobe(radius: number, rng: () => number, flatten: number): BufferGeometry {
  const lobe = new IcosahedronGeometry(radius, 0);
  const p = lobe.attributes.position;
  for (let v = 0; v < p.count; v++) {
    const k = 0.82 + rng() * 0.36;
    p.setXYZ(v, p.getX(v) * k, p.getY(v) * k * flatten, p.getZ(v) * k);
  }
  lobe.computeVertexNormals();
  return lobe;
}

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------

/** Broadleaf jungle giant: buttress roots, forked branches, dense canopy. */
export function buildJungleTree(seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const bark = new Color(0.26, 0.2, 0.14);
  const leaves = [
    new Color(0.13, 0.31, 0.12),
    new Color(0.18, 0.4, 0.15),
    new Color(0.24, 0.47, 0.18),
  ];

  const h = 11 + rng() * 7;
  const { geo: trunk, top } = buildTrunk(h, 0.78, 0.06 + rng() * 0.1, rng() * 6.28, 0.58, 5);
  parts.push(paint(trunk, bark, WOOD_SWAY));

  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + rng() * 0.4;
    const root = new ConeGeometry(0.36, 2.1, 4);
    root.rotateX(Math.PI);
    root.translate(Math.cos(a) * 0.58, 1.05, Math.sin(a) * 0.58);
    parts.push(paint(root, bark, WOOD_SWAY));
  }

  const branches = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + rng() * 0.5;
    const bl = 2.6 + rng() * 1.8;
    const br = new CylinderGeometry(0.12, 0.26, bl, 4, 1);
    br.translate(0, bl / 2, 0);
    br.rotateZ(0.75 + rng() * 0.25);
    br.rotateY(a);
    br.translate(top.x, h * 0.76, top.z);
    parts.push(paint(br, bark, WOOD_SWAY));
  }

  // Overlapping lobes clustered around the crown, reaching down toward the
  // branches so the canopy and trunk read as one tree.
  const blobs = 7 + Math.floor(rng() * 3);
  for (let i = 0; i < blobs; i++) {
    const lobe = canopyLobe(2.1 + rng() * 1.6, rng, 0.78);
    const a = (i / blobs) * Math.PI * 2 + rng() * 0.8;
    const rad = 0.5 + rng() * 2.6;
    lobe.translate(
      top.x + Math.cos(a) * rad,
      h * 0.82 + rng() * 2.8,
      top.z + Math.sin(a) * rad,
    );
    parts.push(paint(lobe, leaves[i % leaves.length]!));
  }
  return mergeParts(parts);
}

/** Coastal palm: leaning trunk, crown of drooping fronds. */
export function buildPalm(seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const bark = new Color(0.33, 0.26, 0.17);
  const leafA = new Color(0.19, 0.4, 0.14);
  const leafB = new Color(0.3, 0.53, 0.2);

  const h = 8 + rng() * 4;
  const { geo: trunk, top } = buildTrunk(h, 0.3, 0.12 + rng() * 0.18, rng() * 6.28, 0.5, 6);
  parts.push(paint(trunk, bark, WOOD_SWAY));

  const crown = new IcosahedronGeometry(0.36, 0);
  crown.translate(top.x, h, top.z);
  parts.push(paint(crown, bark, WOOD_SWAY));

  const fronds = 8;
  for (let i = 0; i < fronds; i++) {
    const len = 3.2 + rng() * 1.5;
    const blade = new ConeGeometry(0.5, len, 4, 2);
    blade.scale(1, 1, 0.1);
    blade.translate(0, len / 2, 0);
    const p = blade.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const t = p.getY(v) / len;
      p.setY(v, p.getY(v) - t * t * len * 0.5);
      p.setZ(v, p.getZ(v) + t * t * 0.25);
    }
    blade.computeVertexNormals();
    blade.rotateX(Math.PI * 0.44);
    blade.rotateY((i / fronds) * Math.PI * 2 + rng() * 0.3);
    blade.translate(top.x, h + 0.15, top.z);
    parts.push(paint(blade, i % 2 ? leafA : leafB));
  }
  return mergeParts(parts);
}

/** Cherry blossom: dark twisting trunk under a broad pink cloud. */
export function buildSakura(seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const bark = new Color(0.22, 0.16, 0.15);
  // Saturated enough to still read as pink after the sun and tonemapping wash
  // it out — the earlier near-white values looked like grey cauliflower.
  const blossom = [
    new Color(0.93, 0.55, 0.68),
    new Color(0.86, 0.42, 0.58),
    new Color(0.98, 0.72, 0.8),
  ];

  const h = 6.5 + rng() * 3.5;
  const { geo: trunk, top } = buildTrunk(h, 0.44, 0.16 + rng() * 0.16, rng() * 6.28, 0.5);
  parts.push(paint(trunk, bark, WOOD_SWAY));

  // Wide, low branches — the classic sakura silhouette. They are kept short and
  // angled up so the blossom cloud below can swallow their tips; longer, flatter
  // branches used to stick out of the canopy as dark shards.
  const branches = 4 + Math.floor(rng() * 3);
  const branchBase = h * 0.62;
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + rng() * 0.6;
    const bl = 1.7 + rng() * 1.4;
    const br = new CylinderGeometry(0.08, 0.2, bl, 5, 1);
    br.translate(0, bl / 2, 0);
    br.rotateZ(0.72 + rng() * 0.3);
    br.rotateY(a);
    br.translate(top.x, branchBase, top.z);
    parts.push(paint(br, bark, WOOD_SWAY));
  }

  // A full, rounded blossom cloud that sits down *onto* the branches — a thin
  // disc floating above a bare trunk reads as a lollipop, not a cherry tree.
  // The lowest blobs start below the branch roots so nothing brown shows through.
  const blobs = 10 + Math.floor(rng() * 4);
  for (let i = 0; i < blobs; i++) {
    const lobe = canopyLobe(1.8 + rng() * 1.3, rng, 0.8);
    const a = (i / blobs) * Math.PI * 2 + rng() * 0.7;
    const rad = 0.5 + rng() * 2.1;
    lobe.translate(
      top.x + Math.cos(a) * rad,
      branchBase + 0.35 + rng() * 2.2,
      top.z + Math.sin(a) * rad,
    );
    parts.push(paint(lobe, blossom[i % blossom.length]!));
  }
  return mergeParts(parts);
}

/** Conifer: straight trunk with stacked, narrowing skirts of needles. */
export function buildPine(seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const bark = new Color(0.25, 0.18, 0.13);
  const needles = [new Color(0.11, 0.24, 0.15), new Color(0.15, 0.31, 0.18)];

  const h = 12 + rng() * 9;
  const { geo: trunk, top } = buildTrunk(h, 0.36, 0.02 + rng() * 0.04, rng() * 6.28, 0.7, 6);
  parts.push(paint(trunk, bark, WOOD_SWAY));

  const tiers = 5 + Math.floor(rng() * 3);
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const radius = 3.4 * (1 - t * 0.78) * (0.85 + rng() * 0.3);
    const tierH = 3.2 * (1 - t * 0.4);
    const cone = new ConeGeometry(radius, tierH, 7, 1);
    cone.translate(top.x, h * (0.3 + t * 0.66) + tierH * 0.2, top.z);
    parts.push(paint(cone, needles[i % 2]!));
  }
  return mergeParts(parts);
}

/** Savanna acacia: bare trunk with a flat, umbrella-shaped crown. */
export function buildAcacia(seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const bark = new Color(0.34, 0.27, 0.18);
  const leaves = [new Color(0.32, 0.4, 0.2), new Color(0.4, 0.46, 0.24)];

  const h = 7 + rng() * 3;
  const { geo: trunk, top } = buildTrunk(h, 0.4, 0.1 + rng() * 0.12, rng() * 6.28, 0.62);
  parts.push(paint(trunk, bark, WOOD_SWAY));

  const arms = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2 + rng() * 0.5;
    const bl = 2.6 + rng() * 1.2;
    const br = new CylinderGeometry(0.09, 0.2, bl, 5, 1);
    br.translate(0, bl / 2, 0);
    br.rotateZ(1.15 + rng() * 0.2);
    br.rotateY(a);
    br.translate(top.x, h * 0.72, top.z);
    parts.push(paint(br, bark, WOOD_SWAY));
  }

  // Very flat canopy discs, layered into an umbrella.
  for (let i = 0; i < 4; i++) {
    const lobe = canopyLobe(2.4 + rng() * 1.5, rng, 0.24);
    const a = rng() * Math.PI * 2;
    const rad = rng() * 2.2;
    lobe.translate(top.x + Math.cos(a) * rad, h + 0.5 + i * 0.35, top.z + Math.sin(a) * rad);
    parts.push(paint(lobe, leaves[i % 2]!));
  }
  return mergeParts(parts);
}

/** Bare, weathered snag for wetlands and cold ground. */
export function buildDeadTree(seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const wood = new Color(0.34, 0.31, 0.26);

  const h = 6 + rng() * 5;
  const { geo: trunk, top } = buildTrunk(h, 0.34, 0.08 + rng() * 0.14, rng() * 6.28, 0.75, 6);
  parts.push(paint(trunk, wood, WOOD_SWAY));

  const limbs = 4 + Math.floor(rng() * 4);
  for (let i = 0; i < limbs; i++) {
    const a = rng() * Math.PI * 2;
    const bl = 1.4 + rng() * 2.2;
    const br = new CylinderGeometry(0.05, 0.13, bl, 4, 1);
    br.translate(0, bl / 2, 0);
    br.rotateZ(0.6 + rng() * 0.8);
    br.rotateY(a);
    br.translate(top.x, h * (0.45 + rng() * 0.5), top.z);
    parts.push(paint(br, wood, WOOD_SWAY));
  }
  return mergeParts(parts);
}

/**
 * A far-distance stand-in: correct silhouette and colour, a fraction of the
 * triangles. Used for outer chunks where a full tree's detail is invisible but
 * its cost is not — this is what keeps a forest-sized view affordable.
 */
export function buildTreeFar(kind: TreeKind, seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];

  const palette: Record<TreeKind, { bark: Color; leaf: Color }> = {
    jungle: { bark: new Color(0.26, 0.2, 0.14), leaf: new Color(0.17, 0.36, 0.15) },
    palm: { bark: new Color(0.33, 0.26, 0.17), leaf: new Color(0.24, 0.45, 0.17) },
    sakura: { bark: new Color(0.22, 0.16, 0.15), leaf: new Color(0.9, 0.55, 0.67) },
    pine: { bark: new Color(0.25, 0.18, 0.13), leaf: new Color(0.13, 0.27, 0.16) },
    acacia: { bark: new Color(0.34, 0.27, 0.18), leaf: new Color(0.36, 0.43, 0.22) },
    dead: { bark: new Color(0.34, 0.31, 0.26), leaf: new Color(0.34, 0.31, 0.26) },
  };
  const { bark, leaf } = palette[kind];

  const h = kind === 'pine' ? 15 : kind === 'jungle' ? 13 : 8;
  const trunk = new CylinderGeometry(0.28, 0.5, h, 4, 1);
  trunk.translate(0, h / 2, 0);
  parts.push(paint(trunk, bark, WOOD_SWAY));

  if (kind === 'dead') return mergeParts(parts);

  if (kind === 'pine') {
    // Two stacked cones read unmistakably as a conifer.
    for (let i = 0; i < 2; i++) {
      const r = 3.2 * (1 - i * 0.42);
      const cone = new ConeGeometry(r, 6 - i * 1.6, 5, 1);
      cone.translate(0, h * (0.45 + i * 0.3), 0);
      parts.push(paint(cone, leaf));
    }
  } else {
    const flatten = kind === 'acacia' ? 0.3 : kind === 'sakura' ? 0.55 : 0.7;
    const radius = kind === 'jungle' ? 3.6 : 3;
    const lobe = canopyLobe(radius, rng, flatten);
    lobe.translate(0, h + radius * flatten * 0.5, 0);
    parts.push(paint(lobe, leaf));
  }
  return mergeParts(parts);
}

export function buildTree(kind: TreeKind, seed: number): BufferGeometry {
  switch (kind) {
    case 'jungle':
      return buildJungleTree(seed);
    case 'palm':
      return buildPalm(seed);
    case 'sakura':
      return buildSakura(seed);
    case 'pine':
      return buildPine(seed);
    case 'acacia':
      return buildAcacia(seed);
    case 'dead':
      return buildDeadTree(seed);
  }
}

// ---------------------------------------------------------------------------
// Undergrowth
// ---------------------------------------------------------------------------

/** Leafy shrub: a cluster of squashed lobes on a short stem. */
export function buildBush(seed: number, tint?: Color): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const base = tint ?? new Color(0.18, 0.38, 0.15);
  const stem = new CylinderGeometry(0.05, 0.1, 0.45, 5);
  stem.translate(0, 0.22, 0);
  parts.push(paint(stem, new Color(0.24, 0.19, 0.13)));
  const lobes = 3;
  for (let i = 0; i < lobes; i++) {
    const lobe = canopyLobe(0.44 + rng() * 0.3, rng, 0.72);
    const a = (i / lobes) * Math.PI * 2 + rng();
    lobe.translate(Math.cos(a) * rng() * 0.32, 0.48 + rng() * 0.3, Math.sin(a) * rng() * 0.32);
    const c = base.clone().multiplyScalar(0.82 + rng() * 0.4);
    parts.push(paint(lobe, c));
  }
  return mergeParts(parts);
}

/** Rosette of long drooping fronds. */
export function buildFern(seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const c1 = new Color(0.16, 0.36, 0.14);
  const c2 = new Color(0.24, 0.46, 0.18);
  const count = 5;
  for (let i = 0; i < count; i++) {
    const len = 1 + rng() * 0.7;
    const frond = new ConeGeometry(0.17, len, 3, 3);
    frond.scale(1, 1, 0.28);
    frond.translate(0, len / 2, 0);
    const p = frond.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const t = p.getY(v) / len;
      p.setY(v, p.getY(v) - t * t * len * 0.5);
      p.setZ(v, p.getZ(v) + t * t * 0.18);
    }
    frond.computeVertexNormals();
    frond.rotateX(0.5 + rng() * 0.35);
    frond.rotateY((i / count) * Math.PI * 2 + rng() * 0.25);
    parts.push(paint(frond, i % 2 ? c1 : c2));
  }
  return mergeParts(parts);
}

/** Small flowering plant — petals on thin stalks. */
export function buildFlower(seed: number, petal: Color): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const green = new Color(0.2, 0.4, 0.16);
  // Deliberately tiny: flowers are the most numerous prop in the world, so every
  // triangle here is multiplied by thousands of instances.
  for (let i = 0; i < 2; i++) {
    const hh = 0.32 + rng() * 0.26;
    const ox = (rng() - 0.5) * 0.16;
    const oz = (rng() - 0.5) * 0.16;
    const stalk = new CylinderGeometry(0.014, 0.02, hh, 3, 1, true);
    stalk.translate(ox, hh / 2, oz);
    parts.push(paint(stalk, green));
    const head = new ConeGeometry(0.085, 0.07, 5);
    head.translate(ox, hh + 0.03, oz);
    parts.push(paint(head, petal));
  }
  return mergeParts(parts);
}

/** Clump of grass blades. */
export function buildGrassTuft(tipTint?: Color): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const cB = new Color(0.14, 0.27, 0.08);
  const cT = tipTint ?? new Color(0.42, 0.63, 0.22);
  // Two blades per clump. Grass covers the whole near field, so this is one of
  // the highest-leverage triangle budgets in the game.
  for (let b = 0; b < 2; b++) {
    const a = (b / 2) * Math.PI * 2;
    const lean = 0.16;
    const w = 0.055;
    const h = 0.72 + b * 0.13;
    const dx = Math.cos(a) * lean;
    const dz = Math.sin(a) * lean;
    const positions = new Float32Array([
      -w, 0, 0, w, 0, 0,
      -w * 0.65 + dx * 0.5, h * 0.55, dz * 0.5,
      w * 0.65 + dx * 0.5, h * 0.55, dz * 0.5,
      dx, h, dz,
    ]);
    const colors = new Float32Array([
      cB.r, cB.g, cB.b, cB.r, cB.g, cB.b, cT.r, cT.g, cT.b, cT.r, cT.g, cT.b, cT.r, cT.g, cT.b,
    ]);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setAttribute('color', new BufferAttribute(colors, 3));
    g.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4]);
    g.computeVertexNormals();
    parts.push(g.toNonIndexed());
    g.dispose();
  }
  return mergeParts(parts);
}

/** Fallen, mossy log. */
export function buildLog(seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const len = 3.6 + rng() * 3;
  const log = new CylinderGeometry(0.44, 0.52, len, 8, 1);
  log.rotateZ(Math.PI / 2);
  log.translate(0, 0.46, 0);
  parts.push(paint(log, new Color(0.27, 0.21, 0.15)));
  for (let i = 0; i < 4; i++) {
    const patch = new IcosahedronGeometry(0.24 + rng() * 0.16, 0);
    patch.scale(1.3, 0.4, 1.1);
    patch.translate((rng() - 0.5) * len * 0.8, 0.79, (rng() - 0.5) * 0.35);
    parts.push(paint(patch, new Color(0.2, 0.42, 0.18)));
  }
  return mergeParts(parts);
}

/** Irregular boulder. */
export function buildRock(seed: number, detail = 1): BufferGeometry {
  const rng = makeRng(seed);
  const geo = new IcosahedronGeometry(1, detail);
  const p = geo.attributes.position;
  const v = new Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
    const n =
      0.26 * Math.sin(v.x * 3.1 + seed) +
      0.2 * Math.cos(v.y * 4.7 + seed * 1.7) +
      0.16 * Math.sin(v.z * 5.9 + seed * 2.3) +
      0.12 * (rng() - 0.5);
    v.multiplyScalar(1 + n * 0.45);
    if (v.y < -0.3) v.y *= 0.7; // flatten the base so it sits on the ground
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();

  // Per-vertex tint variation, and deliberately dark.
  //
  // The original flat 0.5 grey was why boulders read as blown-out white blobs:
  // under a 1.4 hemisphere plus a 3.4 sun, a mid-grey albedo clips to white on
  // every facet the sun catches. Real stone is much darker than people expect.
  const n = p.count;
  const colours = new Float32Array(n * 3);
  const sways = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const px = p.getX(i);
    const py = p.getY(i);
    const pz = p.getZ(i);
    // Two scales of variation so neighbouring facets differ without looking noisy.
    const coarse = Math.sin(px * 1.7 + seed) * Math.cos(pz * 2.1 - seed * 0.7);
    const fine = Math.sin(px * 6.3 - pz * 5.1 + seed * 2.3);
    const t = Math.min(1, Math.max(0, 0.5 + coarse * 0.34 + fine * 0.16 + py * 0.08));
    colours[i * 3] = 0.15 + t * 0.16;
    colours[i * 3 + 1] = 0.15 + t * 0.155;
    colours[i * 3 + 2] = 0.14 + t * 0.15;
    sways[i] = 0;
  }
  geo.setAttribute('color', new BufferAttribute(colours, 3));
  geo.setAttribute('aSway', new BufferAttribute(sways, 1));
  return geo;
}
