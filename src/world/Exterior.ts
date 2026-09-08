import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Points,
  Quaternion,
  BackSide,
  ShaderMaterial,
  SphereGeometry,
  TubeGeometry,
  Vector3,
  AdditiveBlending,
  type IUniform,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssetManager } from '../core/AssetManager.ts';
import type { QualitySettings } from '../core/QualityManager.ts';
import { applyTriplanarUV, boxAt, buildRockGeometry } from './builders/geometry.ts';
import { buildPortal, type PortalBuild } from './Portal.ts';

interface Disposable {
  dispose(): void;
}

export interface ExteriorBuild {
  group: Group;
  floorHeightAt(x: number, z: number): number;
  collide(pos: Vector3): void;
  update(elapsed: number): void;
  dispose(): void;
  /** Spawn on dry ground in front of the portal monolith. */
  spawn: { x: number; z: number; yaw: number };
  /** True when the player has stepped into the portal. */
  isAtPortal(x: number, y: number, z: number): boolean;
  /** True when a point is inside solid geometry (third-person camera clamp). */
  blocksCamera(x: number, y: number, z: number): boolean;
}

export const EXTERIOR = {
  /** Half-extent of the world in metres (world is 2× this across). */
  halfSize: 420,
  waterY: 2.2,
  plazaY: 5.4,
} as const;

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967295);
}

/** Drifting pollen motes — the outdoor counterpart to the lobby's dust. */
const MOTE_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  uniform float uPixelRatio;
  attribute float aScale;
  attribute vec3 aSeed;
  void main() {
    vec3 p = position;
    p.x += sin(uTime * 0.22 + aSeed.x * 6.2831) * 1.6;
    p.y += sin(uTime * 0.15 + aSeed.y * 6.2831) * 0.9;
    p.z += cos(uTime * 0.19 + aSeed.z * 6.2831) * 1.6;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * aScale * uPixelRatio / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const MOTE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, d) * uOpacity);
  }
`;

interface Placement {
  x: number;
  y: number;
  z: number;
  s: number;
  sy: number;
  rot: number;
}

/**
 * Splits instances into spatial chunks, one InstancedMesh per chunk. An
 * InstancedMesh is culled as a single unit, so one giant mesh covering the whole
 * island would always be drawn in full. Chunking lets the frustum cull most of
 * the world — the difference between ~1.4M and a few hundred thousand triangles.
 */
function addChunkedInstances(
  parent: Group,
  geo: BufferGeometry,
  mat: MeshStandardMaterial,
  placements: Placement[],
  chunkSize: number,
  shadows = true,
): void {
  const buckets = new Map<string, Placement[]>();
  for (const p of placements) {
    const key = `${Math.floor(p.x / chunkSize)}|${Math.floor(p.z / chunkSize)}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(p);
  }
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const pos = new Vector3();
  const scl = new Vector3();
  for (const list of buckets.values()) {
    const mesh = new InstancedMesh(geo, mat, list.length);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    list.forEach((p, i) => {
      q.setFromAxisAngle(up, p.rot);
      pos.set(p.x, p.y, p.z);
      scl.set(p.s, p.sy, p.s);
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    parent.add(mesh);
  }
}

/** Adds a flat `color` attribute so parts can be merged into one vertex-coloured mesh. */
function paint(geo: BufferGeometry, c: Color): BufferGeometry {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new BufferAttribute(arr, 3));
  return geo;
}

/**
 * A palm: slightly leaning, tapered segmented trunk topped by a crown of
 * drooping fronds, each frond a tapered blade with a visible midrib bend.
 */
function buildPalmGeometry(seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const barkA = new Color(0.3, 0.23, 0.15);
  const barkB = new Color(0.38, 0.3, 0.2);
  const leafA = new Color(0.19, 0.4, 0.14);
  const leafB = new Color(0.3, 0.53, 0.2);

  // Trunk: one continuous tapered tube swept along a curved spine. Stacking
  // separate cylinders made visible "box on box" steps wherever it leaned.
  const totalH = 7.5 + rng() * 3;
  const lean = 0.1 + rng() * 0.16;
  const leanDir = rng() * Math.PI * 2;
  const spine: Vector3[] = [];
  const spineSteps = 7;
  for (let i = 0; i <= spineSteps; i++) {
    const t = i / spineSteps;
    const bend = lean * t * t * totalH * 0.32;
    spine.push(new Vector3(Math.cos(leanDir) * bend, t * totalH, Math.sin(leanDir) * bend));
  }
  const curve = new CatmullRomCurve3(spine, false, 'catmullrom', 0.5);
  const trunkGeo = new TubeGeometry(curve, 12, 0.3, 7, false);
  // Taper the radius from base to crown by scaling each ring toward its centre.
  {
    const p = trunkGeo.attributes.position;
    const tmp = new Vector3();
    for (let i = 0; i < p.count; i++) {
      tmp.set(p.getX(i), p.getY(i), p.getZ(i));
      const t = Math.min(1, Math.max(0, tmp.y / totalH));
      const center = curve.getPointAt(t);
      const taper = 1 - t * 0.55;
      p.setXYZ(
        i,
        center.x + (tmp.x - center.x) * taper,
        tmp.y,
        center.z + (tmp.z - center.z) * taper,
      );
    }
    trunkGeo.computeVertexNormals();
  }
  parts.push(paint(trunkGeo, rng() > 0.5 ? barkA : barkB));
  const crownPoint = spine[spine.length - 1]!;
  const cx = crownPoint.x;
  const cz = crownPoint.z;

  // Crown.
  const crown = new IcosahedronGeometry(0.36, 0);
  crown.translate(cx, totalH, cz);
  parts.push(paint(crown, barkB));

  const frondCount = 8;
  for (let i = 0; i < frondCount; i++) {
    const yaw = (i / frondCount) * Math.PI * 2 + rng() * 0.3;
    const droop = 0.5 + rng() * 0.5;
    const len = 3 + rng() * 1.4;
    // Blade: a flattened, tapered cone, bent down along its length.
    const blade = new ConeGeometry(0.5, len, 4, 2);
    blade.scale(1, 1, 0.1);
    blade.translate(0, len / 2, 0);
    const p = blade.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const y = p.getY(v);
      const t = y / len;
      p.setY(v, y - t * t * len * droop * 0.55); // sag
      p.setZ(v, p.getZ(v) + t * t * 0.25); // curl
    }
    blade.computeVertexNormals();
    blade.rotateX(Math.PI * 0.42 + droop * 0.22);
    blade.rotateY(yaw);
    blade.translate(cx, totalH + 0.15, cz);
    parts.push(paint(blade, i % 2 ? leafA : leafB));
  }

  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()), false);
  for (const g of parts) g.dispose();
  return merged;
}

/** A broadleaf jungle tree: forked trunk with layered, irregular canopy blobs. */
function buildJungleTreeGeometry(seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const bark = new Color(0.26, 0.2, 0.14);
  const canopy = [
    new Color(0.13, 0.31, 0.12),
    new Color(0.18, 0.4, 0.15),
    new Color(0.24, 0.47, 0.18),
  ];

  const h = 9 + rng() * 5;
  // Slightly curved, tapering trunk swept as one tube (no stacked-box seams).
  {
    const lean = 0.05 + rng() * 0.1;
    const dir = rng() * Math.PI * 2;
    const spine: Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const bend = lean * t * t * h * 0.22;
      spine.push(new Vector3(Math.cos(dir) * bend, t * h, Math.sin(dir) * bend));
    }
    const curve = new CatmullRomCurve3(spine, false, 'catmullrom', 0.5);
    const trunk = new TubeGeometry(curve, 10, 0.72, 7, false);
    const p = trunk.attributes.position;
    const tmp = new Vector3();
    for (let i = 0; i < p.count; i++) {
      tmp.set(p.getX(i), p.getY(i), p.getZ(i));
      const t = Math.min(1, Math.max(0, tmp.y / h));
      const c = curve.getPointAt(t);
      const taper = 1 - t * 0.55;
      p.setXYZ(i, c.x + (tmp.x - c.x) * taper, tmp.y, c.z + (tmp.z - c.z) * taper);
    }
    trunk.computeVertexNormals();
    parts.push(paint(trunk, bark));
  }

  // Buttress roots.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng() * 0.4;
    const root = new ConeGeometry(0.34, 1.9, 4);
    root.rotateX(Math.PI);
    root.translate(Math.cos(a) * 0.55, 0.95, Math.sin(a) * 0.55);
    parts.push(paint(root, bark));
  }

  // Branches.
  const branches = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + rng() * 0.5;
    const bl = 2.4 + rng() * 1.6;
    const br = new CylinderGeometry(0.12, 0.24, bl, 5, 1);
    br.translate(0, bl / 2, 0);
    br.rotateZ(0.75 + rng() * 0.25);
    br.rotateY(a);
    br.translate(0, h * 0.78, 0);
    parts.push(paint(br, bark));
  }

  // Canopy: overlapping low-poly blobs (detail 0 keeps them cheap; they're
  // instanced hundreds of times across the island).
  const blobs = 5 + Math.floor(rng() * 2);
  for (let i = 0; i < blobs; i++) {
    const r = 1.8 + rng() * 1.6;
    const blob = new IcosahedronGeometry(r, 0);
    // Squash and roughen for an organic silhouette.
    const p = blob.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const k = 0.82 + rng() * 0.36;
      p.setXYZ(v, p.getX(v) * k, p.getY(v) * k * 0.72, p.getZ(v) * k);
    }
    blob.computeVertexNormals();
    const a = rng() * Math.PI * 2;
    const rad = rng() * 2.6;
    blob.translate(Math.cos(a) * rad, h + 0.4 + rng() * 2.2, Math.sin(a) * rad);
    parts.push(paint(blob, canopy[i % canopy.length]!));
  }

  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()), false);
  for (const g of parts) g.dispose();
  return merged;
}

/** A leafy shrub: a cluster of squashed low-poly lobes on a stubby stem. */
function buildBushGeometry(seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const leaf = [new Color(0.15, 0.32, 0.13), new Color(0.21, 0.42, 0.17), new Color(0.27, 0.5, 0.2)];
  const stem = new CylinderGeometry(0.05, 0.09, 0.4, 5);
  stem.translate(0, 0.2, 0);
  parts.push(paint(stem, new Color(0.24, 0.19, 0.13)));
  const lobes = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < lobes; i++) {
    const r = 0.34 + rng() * 0.3;
    const lobe = new IcosahedronGeometry(r, 0);
    const p = lobe.attributes.position;
    for (let v = 0; v < p.count; v++) {
      p.setXYZ(v, p.getX(v) * 1.1, p.getY(v) * 0.7, p.getZ(v) * 1.1);
    }
    lobe.computeVertexNormals();
    const a = (i / lobes) * Math.PI * 2 + rng();
    const rad = rng() * 0.3;
    lobe.translate(Math.cos(a) * rad, 0.42 + rng() * 0.3, Math.sin(a) * rad);
    parts.push(paint(lobe, leaf[i % leaf.length]!));
  }
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()), false);
  for (const p of parts) p.dispose();
  return merged;
}

/** A fern: a rosette of long, drooping, serrated fronds. */
function buildFernGeometry(seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const c1 = new Color(0.16, 0.36, 0.14);
  const c2 = new Color(0.24, 0.46, 0.18);
  const count = 7;
  for (let i = 0; i < count; i++) {
    const len = 0.9 + rng() * 0.6;
    const frond = new ConeGeometry(0.16, len, 3, 3);
    frond.scale(1, 1, 0.28);
    frond.translate(0, len / 2, 0);
    const p = frond.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const y = p.getY(v);
      const t = y / len;
      p.setY(v, y - t * t * len * 0.5); // droop
      p.setZ(v, p.getZ(v) + t * t * 0.18);
    }
    frond.computeVertexNormals();
    frond.rotateX(0.5 + rng() * 0.35);
    frond.rotateY((i / count) * Math.PI * 2 + rng() * 0.25);
    parts.push(paint(frond, i % 2 ? c1 : c2));
  }
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()), false);
  for (const p of parts) p.dispose();
  return merged;
}

/** A small flowering plant — a few bright petals on thin stalks. */
function buildFlowerGeometry(seed: number, petal: Color): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const green = new Color(0.2, 0.4, 0.16);
  for (let i = 0; i < 3; i++) {
    const hh = 0.3 + rng() * 0.25;
    const stalk = new CylinderGeometry(0.012, 0.018, hh, 4);
    const ox = (rng() - 0.5) * 0.16;
    const oz = (rng() - 0.5) * 0.16;
    stalk.translate(ox, hh / 2, oz);
    parts.push(paint(stalk, green));
    const head = new IcosahedronGeometry(0.075, 0);
    head.scale(1, 0.6, 1);
    head.translate(ox, hh + 0.03, oz);
    parts.push(paint(head, petal));
  }
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()), false);
  for (const p of parts) p.dispose();
  return merged;
}

/** A fallen, mossy log. */
function buildLogGeometry(seed: number): BufferGeometry {
  const rng = makeRng(seed);
  const parts: BufferGeometry[] = [];
  const len = 3.5 + rng() * 3;
  const log = new CylinderGeometry(0.42, 0.5, len, 8, 1);
  log.rotateZ(Math.PI / 2);
  log.translate(0, 0.45, 0);
  parts.push(paint(log, new Color(0.27, 0.21, 0.15)));
  // Moss patches along the top.
  for (let i = 0; i < 4; i++) {
    const patch = new IcosahedronGeometry(0.24 + rng() * 0.16, 0);
    patch.scale(1.3, 0.4, 1.1);
    patch.translate((rng() - 0.5) * len * 0.8, 0.78, (rng() - 0.5) * 0.35);
    parts.push(paint(patch, new Color(0.2, 0.42, 0.18)));
  }
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()), false);
  for (const p of parts) p.dispose();
  return merged;
}

/** A tuft of a few blades, so each instance reads as a clump of grass. */
function buildGrassTuftGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const cB = new Color(0.14, 0.27, 0.08);
  const cT = new Color(0.42, 0.63, 0.22);
  for (let b = 0; b < 3; b++) {
    const a = (b / 3) * Math.PI * 2;
    const lean = 0.16;
    const w = 0.055;
    const h = 0.7 + b * 0.12;
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
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return merged;
}

export function buildExterior(assets: AssetManager, settings: QualitySettings): ExteriorBuild {
  const group = new Group();
  group.name = 'Exterior';
  const disposables: Disposable[] = [];
  const track = <T extends Disposable>(d: T): T => (disposables.push(d), d);
  const timeUniform: IUniform<number> = { value: 0 };
  let moteUniforms: { uTime: IUniform<number> } | null = null;
  const { halfSize, waterY, plazaY } = EXTERIOR;

  // ---- Terrain height field (fbm value noise) ---------------------------
  const hash = (ix: number, iz: number): number => {
    let h = (ix * 374761393 + iz * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  };
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  const vnoise = (x: number, z: number): number => {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const tx = smooth(x - x0);
    const tz = smooth(z - z0);
    const a = hash(x0, z0);
    const b = hash(x0 + 1, z0);
    const c = hash(x0, z0 + 1);
    const d = hash(x0 + 1, z0 + 1);
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };

  const heightAt = (x: number, z: number): number => {
    // Continental shape: broad landmass falling into water at the rim.
    let amp = 13;
    let freq = 0.0022;
    let h = 0;
    for (let o = 0; o < 6; o++) {
      h += (vnoise(x * freq + 500, z * freq + 500) - 0.5) * 2 * amp;
      amp *= 0.52;
      freq *= 2.07;
    }
    // Ridges add mountain character in the far field.
    const ridge = 1 - Math.abs(vnoise(x * 0.006 + 90, z * 0.006 + 90) - 0.5) * 2;
    const dist = Math.hypot(x, z) / halfSize;
    h += Math.pow(ridge, 2.2) * 34 * smooth(Math.min(1, Math.max(0, dist * 1.5 - 0.35)));
    h += 9;
    // Coastal falloff so the map ends in ocean, not a cliff wall.
    h -= Math.pow(Math.max(0, dist - 0.72) / 0.28, 2) * 46;

    // Flatten a plaza around the portal monolith (spawn area).
    const d = Math.max(Math.abs(x) - 16, Math.abs(z - 10) - 18, 0);
    const flat = smooth(Math.min(1, d / 22));
    return plazaY * (1 - flat) + h * flat;
  };

  // ---- Terrain sampled exactly like the rendered mesh --------------------
  // The terrain mesh is a grid, so its visible surface is the *bilinear* blend
  // of the grid vertices — not the raw noise. Props and the player must use the
  // same value, otherwise things float above ridges or sink into slopes.
  const terrainSeg = settings.drawDistance > 250 ? 176 : 128;
  const cellW = (halfSize * 2) / terrainSeg;
  const surfaceAt = (x: number, z: number): number => {
    const gx = (x + halfSize) / cellW;
    const gz = (z + halfSize) / cellW;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const tx = gx - ix;
    const tz = gz - iz;
    const vx0 = ix * cellW - halfSize;
    const vz0 = iz * cellW - halfSize;
    const vx1 = vx0 + cellW;
    const vz1 = vz0 + cellW;
    const h00 = heightAt(vx0, vz0);
    const h10 = heightAt(vx1, vz0);
    const h01 = heightAt(vx0, vz1);
    const h11 = heightAt(vx1, vz1);
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return a + (b - a) * tz;
  };

  // ---- Prop grid (trees, rocks, monolith) -------------------------------
  // A uniform spatial hash keeps queries cheap across a large world. `top` lets
  // props act as walkable surfaces, so rocks can be jumped onto.
  interface Prop {
    x: number;
    z: number;
    r: number;
    top: number;
    /** Blocks movement at body height (trunks, big boulders). */
    solid: boolean;
  }
  const CELL = 12;
  const obstacles = new Map<string, Prop[]>();
  const cellKey = (cx: number, cz: number): string => `${cx}|${cz}`;
  const addObstacle = (x: number, z: number, r: number, top = 0, solid = true): void => {
    const key = cellKey(Math.floor(x / CELL), Math.floor(z / CELL));
    let list = obstacles.get(key);
    if (!list) obstacles.set(key, (list = []));
    list.push({ x, z, r, top, solid });
  };
  /** Visit every prop near a point (3×3 cells). */
  const forEachNearProp = (x: number, z: number, fn: (p: Prop) => void): void => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const list = obstacles.get(cellKey(cx + ox, cz + oz));
        if (!list) continue;
        for (const p of list) fn(p);
      }
    }
  };

  // ---- Terrain mesh -----------------------------------------------------
  {
    const size = halfSize * 2;
    const geo = new PlaneGeometry(size, size, terrainSeg, terrainSeg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const uvs = new Float32Array(pos.count * 2);

    const sand = new Color(0.76, 0.71, 0.52);
    const lush = new Color(0.36, 0.5, 0.26);
    const jungle = new Color(0.24, 0.4, 0.2);
    const highland = new Color(0.52, 0.52, 0.42);
    const rock = new Color(0.44, 0.42, 0.4);
    const snow = new Color(0.86, 0.88, 0.86);
    const tmp = new Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      // The mesh vertices ARE the surface, so they use the raw height field.
      // Everything else queries `surfaceAt`, which interpolates these vertices.
      const y = heightAt(x, z);
      pos.setY(i, y);

      const hx = heightAt(x + 3, z) - heightAt(x - 3, z);
      const hz = heightAt(x, z + 3) - heightAt(x, z - 3);
      const slope = Math.min(1, Math.hypot(hx, hz) / 7);

      // Biome bands by altitude, then rock on steep faces, snow on peaks.
      if (y < waterY + 1.2) tmp.copy(sand);
      else if (y < 14) tmp.copy(lush).lerp(jungle, Math.min(1, (y - 3) / 11));
      else if (y < 30) tmp.copy(jungle).lerp(highland, (y - 14) / 16);
      else tmp.copy(highland).lerp(snow, Math.min(1, (y - 30) / 18));
      tmp.lerp(rock, slope * 0.75);
      // Large-scale mottling so the ground never reads as one flat colour.
      const macro = vnoise(x * 0.012 + 41, z * 0.012 + 41);
      const patch = vnoise(x * 0.05 + 7, z * 0.05 + 7);
      const tint = 0.78 + macro * 0.4 + patch * 0.16;
      colors[i * 3] = tmp.r * tint;
      colors[i * 3 + 1] = tmp.g * (tint * 0.98 + 0.03);
      colors[i * 3 + 2] = tmp.b * tint;

      // World-space UVs → the ground texture keeps a constant, real scale.
      uvs[i * 2] = x * 0.22;
      uvs[i * 2 + 1] = z * 0.22;
    }
    geo.setAttribute('color', new BufferAttribute(colors, 3));
    geo.setAttribute('uv', new BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    track(geo);

    const g = assets.ground();
    const mat = track(
      new MeshStandardMaterial({
        map: g.map,
        normalMap: g.normalMap,
        roughnessMap: g.roughnessMap,
        vertexColors: true,
        roughness: 1,
        metalness: 0,
      }),
    );
    const terrain = new Mesh(geo, mat);
    terrain.receiveShadow = true;
    group.add(terrain);
  }

  // ---- Ocean ------------------------------------------------------------
  {
    const geo = track(new PlaneGeometry(halfSize * 6, halfSize * 6, 1, 1));
    geo.rotateX(-Math.PI / 2);
    const mat = track(
      new MeshStandardMaterial({
        color: new Color(0.09, 0.26, 0.32),
        transparent: true,
        opacity: 0.86,
        roughness: 0.12,
        metalness: 0.35,
      }),
    );
    const water = new Mesh(geo, mat);
    water.position.y = waterY;
    group.add(water);
  }

  // ---- Portal monolith (the "glyba" you arrive from) --------------------
  const portalPos = new Vector3(0, plazaY + 3.2, 0);
  let portal: PortalBuild;
  {
    const stoneTex = assets.stone(1);
    const mat = track(
      new MeshStandardMaterial({
        map: stoneTex.map,
        normalMap: stoneTex.normalMap,
        roughnessMap: stoneTex.roughnessMap,
        color: new Color(0.5, 0.53, 0.5),
        roughness: 1,
        metalness: 0,
      }),
    );
    // A craggy rock slab with a gate cut through it.
    const parts: BufferGeometry[] = [];
    const slabH = 12;
    parts.push(boxAt(5.5, slabH, 3.4, -5.4, slabH / 2, 0));
    parts.push(boxAt(5.5, slabH, 3.4, 5.4, slabH / 2, 0));
    parts.push(boxAt(15.4, 3.4, 3.4, 0, slabH - 1.7, 0));
    parts.push(boxAt(17, 1.4, 5.2, 0, 0.7, 0)); // plinth
    const slab = track(applyTriplanarUV(mergeGeometries(parts.map((p) => p.toNonIndexed()), false), 0.35));
    for (const p of parts) p.dispose();
    const monolith = new Mesh(slab, mat);
    monolith.position.set(0, plazaY, 0);
    monolith.castShadow = true;
    monolith.receiveShadow = true;
    group.add(monolith);

    // Boulders piled around the base — but keep the spawn corridor (+Z, where
    // the player appears and the camera sits behind them) completely clear.
    const rockGeo = track(buildRockGeometry(41, 1));
    const rng = makeRng(6161);
    const boulders: Placement[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + rng() * 0.4;
      // Skip the wedge facing the spawn point.
      let delta = Math.abs(a - Math.PI / 2);
      if (delta > Math.PI) delta = Math.PI * 2 - delta;
      if (delta < 0.85) continue;
      const rad = 9 + rng() * 4;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      const s = 1.2 + rng() * 2;
      const by = surfaceAt(x, z) + s * 0.25;
      boulders.push({ x, y: by, z, s, sy: s * 0.75, rot: rng() * Math.PI * 2 });
      addObstacle(x, z, s * 0.8, by + s * 0.6, true);
    }
    addChunkedInstances(group, rockGeo, mat, boulders, 400);

    // Block walking through the monolith's two legs.
    addObstacle(-5.4, 0, 2.9, plazaY + 12, true);
    addObstacle(5.4, 0, 2.9, plazaY + 12, true);

    portal = buildPortal({
      position: portalPos,
      width: 5.2,
      height: 7.4,
      facing: 0, // faces +Z, toward the spawn point
      withArch: false,
    });
    group.add(portal.group);
  }

  // ---- Palms & jungle trees (instanced, with collision) -----------------
  {
    const palmMat = track(
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true }),
    );
    const treeMat = track(
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true }),
    );
    const palmGeos = [track(buildPalmGeometry(7)), track(buildPalmGeometry(23))];
    const treeGeos = [track(buildJungleTreeGeometry(11)), track(buildJungleTreeGeometry(37))];

    const density = 0.55 + settings.vegetationDensity * 0.5;
    const rng = makeRng(20260908);

    const scatter = (
      geos: BufferGeometry[],
      mat: MeshStandardMaterial,
      perGeo: number,
      minY: number,
      maxY: number,
      radius: number,
    ): void => {
      for (const geo of geos) {
        const placements: Placement[] = [];
        for (let attempt = 0; attempt < perGeo * 8 && placements.length < perGeo; attempt++) {
          const x = (rng() - 0.5) * 2 * (halfSize - 30);
          const z = (rng() - 0.5) * 2 * (halfSize - 30);
          if (Math.hypot(x, z - 10) < 24) continue; // keep the plaza clear
          const y = surfaceAt(x, z);
          if (y < minY || y > maxY) continue;
          const hx = surfaceAt(x + 3, z) - surfaceAt(x - 3, z);
          const hz = surfaceAt(x, z + 3) - surfaceAt(x, z - 3);
          if (Math.hypot(hx, hz) > 6) continue; // too steep
          const s = 0.8 + rng() * 0.5;
          placements.push({ x, y, z, s, sy: s, rot: rng() * Math.PI * 2 });
          // Trunks are solid all the way up — you can't stand on a tree.
          addObstacle(x, z, radius * s, y, true);
        }
        addChunkedInstances(group, geo, mat, placements, 200);
      }
    };

    scatter(palmGeos, palmMat, Math.floor(150 * density), waterY + 0.6, 20, 0.5);
    scatter(treeGeos, treeMat, Math.floor(95 * density), waterY + 1.5, 26, 0.9);
  }

  // ---- Scattered rocks --------------------------------------------------
  {
    const stoneTex = assets.stone(1);
    const rockMat = track(
      new MeshStandardMaterial({
        map: stoneTex.map,
        normalMap: stoneTex.normalMap,
        roughnessMap: stoneTex.roughnessMap,
        color: new Color(0.5, 0.51, 0.48),
        roughness: 1,
        metalness: 0,
      }),
    );
    const geos = [track(buildRockGeometry(5, 1)), track(buildRockGeometry(17, 1))];
    const rng = makeRng(9001);
    for (const g of geos) {
      const n = 70;
      const placements: Placement[] = [];
      for (let attempt = 0; attempt < n * 6 && placements.length < n; attempt++) {
        const x = (rng() - 0.5) * 2 * (halfSize - 20);
        const z = (rng() - 0.5) * 2 * (halfSize - 20);
        if (Math.hypot(x, z - 10) < 22) continue;
        const y = surfaceAt(x, z);
        if (y < waterY - 0.5) continue;
        const s = 0.9 + rng() * 4.5;
        const baseY = y + s * 0.22;
        placements.push({ x, y: baseY, z, s, sy: s * 0.8, rot: rng() * Math.PI * 2 });
        // Every rock collides. Low ones are steppable (you can jump on top);
        // tall ones also block movement at body height.
        const top = baseY + s * 0.62;
        addObstacle(x, z, s * 0.78, top, top - y > 1.5);
      }
      addChunkedInstances(group, g, rockMat, placements, 200);
    }
  }

  // ---- Grass tufts near the plaza --------------------------------------
  {
    const tuftGeo = track(buildGrassTuftGeometry());
    const grassMat = track(
      new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: DoubleSide }),
    );
    grassMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeUniform;
      shader.vertexShader =
        'uniform float uTime;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float sway = sin(uTime * 1.4 + instanceMatrix[3].x * 0.35 + instanceMatrix[3].z * 0.42);
           transformed.x += sway * position.y * position.y * 0.55;`,
        );
    };
    const count = Math.floor(9000 * settings.vegetationDensity);
    const rng = makeRng(321);
    const placements: Placement[] = [];
    for (let i = 0; i < count; i++) {
      // Concentrate around the plaza where the player actually walks.
      const a = rng() * Math.PI * 2;
      const rad = Math.pow(rng(), 0.6) * 150;
      const x = Math.cos(a) * rad;
      const z = 10 + Math.sin(a) * rad;
      const y = surfaceAt(x, z);
      if (y < waterY + 0.3) continue;
      const s = 0.7 + rng() * 0.9;
      placements.push({ x, y, z, s, sy: s * (0.8 + rng() * 0.6), rot: rng() * Math.PI * 2 });
    }
    // Grass is dense and short-range, so smaller chunks pay off — but not so
    // small that the draw-call count explodes.
    addChunkedInstances(group, tuftGeo, grassMat, placements, 100, false);
  }

  // ---- Undergrowth: bushes, ferns, flowers, fallen logs ------------------
  {
    const foliageMat = track(
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true }),
    );
    const rng = makeRng(778899);
    const density = 0.6 + settings.vegetationDensity * 0.5;

    const kinds: Array<{ geo: BufferGeometry; count: number; scale: number; radius: number; maxY: number }> = [
      { geo: track(buildBushGeometry(3)), count: Math.floor(320 * density), scale: 1.3, radius: 0, maxY: 24 },
      { geo: track(buildBushGeometry(19)), count: Math.floor(260 * density), scale: 1.1, radius: 0, maxY: 24 },
      { geo: track(buildFernGeometry(5)), count: Math.floor(380 * density), scale: 1.2, radius: 0, maxY: 20 },
      { geo: track(buildFernGeometry(29)), count: Math.floor(300 * density), scale: 1, radius: 0, maxY: 20 },
      { geo: track(buildFlowerGeometry(7, new Color(0.9, 0.85, 0.35))), count: Math.floor(300 * density), scale: 1.2, radius: 0, maxY: 18 },
      { geo: track(buildFlowerGeometry(11, new Color(0.85, 0.42, 0.62))), count: Math.floor(240 * density), scale: 1.2, radius: 0, maxY: 18 },
      { geo: track(buildLogGeometry(17)), count: 55, scale: 1, radius: 0.55, maxY: 22 },
    ];

    for (const kind of kinds) {
      const placements: Placement[] = [];
      for (let attempt = 0; attempt < kind.count * 6 && placements.length < kind.count; attempt++) {
        const a = rng() * Math.PI * 2;
        const rad = Math.pow(rng(), 0.55) * (halfSize - 40);
        const x = Math.cos(a) * rad;
        const z = 10 + Math.sin(a) * rad;
        const y = surfaceAt(x, z);
        if (y < waterY + 0.4 || y > kind.maxY) continue;
        if (Math.hypot(x, z - 10) < 18) continue; // keep the plaza walkable
        const hx = surfaceAt(x + 3, z) - surfaceAt(x - 3, z);
        const hz = surfaceAt(x, z + 3) - surfaceAt(x, z - 3);
        if (Math.hypot(hx, hz) > 7) continue;
        const s = kind.scale * (0.75 + rng() * 0.6);
        placements.push({ x, y, z, s, sy: s * (0.85 + rng() * 0.4), rot: rng() * Math.PI * 2 });
        // Logs are low enough to hop onto; leaves are pass-through.
        if (kind.radius > 0) addObstacle(x, z, kind.radius * s, y + 0.9 * s, false);
      }
      // Sparse undergrowth spread over a wide area: larger chunks keep the
      // draw-call count down while still culling most of the island.
      addChunkedInstances(group, kind.geo, foliageMat, placements, 260);
    }
  }

  // ---- Ruins: toppled columns and broken arches (ties to the cathedral) --
  {
    const stoneTex = assets.stone(1);
    const ruinMat = track(
      new MeshStandardMaterial({
        map: stoneTex.map,
        normalMap: stoneTex.normalMap,
        roughnessMap: stoneTex.roughnessMap,
        color: new Color(0.58, 0.6, 0.55),
        roughness: 1,
        metalness: 0,
      }),
    );
    const rng = makeRng(5150);

    // Standing column stumps.
    const columnGeo = track(applyTriplanarUV(new CylinderGeometry(0.62, 0.78, 5.5, 9, 1), 0.4));
    columnGeo.translate(0, 2.75, 0);
    const columns: Placement[] = [];
    // Fallen, half-buried column drums.
    const drumGeo = track(applyTriplanarUV(new CylinderGeometry(0.6, 0.62, 3.4, 9, 1), 0.4));
    drumGeo.rotateZ(Math.PI / 2);
    drumGeo.translate(0, 0.55, 0);
    const drums: Placement[] = [];

    // Cluster ruins into a few sites so they read as remains of structures.
    for (let site = 0; site < 7; site++) {
      const sa = rng() * Math.PI * 2;
      const sr = 60 + rng() * (halfSize - 130);
      const sx = Math.cos(sa) * sr;
      const sz = 10 + Math.sin(sa) * sr;
      if (surfaceAt(sx, sz) < waterY + 1.5) continue;
      const members = 4 + Math.floor(rng() * 5);
      for (let k = 0; k < members; k++) {
        const x = sx + (rng() - 0.5) * 22;
        const z = sz + (rng() - 0.5) * 22;
        const y = surfaceAt(x, z);
        if (y < waterY + 0.8) continue;
        const s = 0.85 + rng() * 0.6;
        if (rng() < 0.45) {
          columns.push({ x, y: y - 0.3, z, s, sy: s * (0.6 + rng() * 0.8), rot: rng() * Math.PI * 2 });
          addObstacle(x, z, 0.85 * s, y + 5 * s, true);
        } else {
          drums.push({ x, y: y - 0.1, z, s, sy: s, rot: rng() * Math.PI * 2 });
          addObstacle(x, z, 1.5 * s, y + 1.1 * s, false); // low enough to climb
        }
      }
    }
    addChunkedInstances(group, columnGeo, ruinMat, columns, 200);
    addChunkedInstances(group, drumGeo, ruinMat, drums, 200);
  }

  // ---- Outdoor atmosphere: drifting pollen motes -------------------------
  {
    const count = Math.floor(settings.particleCount * 0.5);
    const positions = new Float32Array(count * 3);
    const scales = new Float32Array(count);
    const seeds = new Float32Array(count * 3);
    const rng = makeRng(9);
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const rad = Math.pow(rng(), 0.6) * 130;
      const x = Math.cos(a) * rad;
      const z = 10 + Math.sin(a) * rad;
      positions[i * 3] = x;
      positions[i * 3 + 1] = surfaceAt(x, z) + 0.5 + rng() * 12;
      positions[i * 3 + 2] = z;
      scales[i] = 0.5 + rng() * 1.5;
      seeds[i * 3] = rng();
      seeds[i * 3 + 1] = rng();
      seeds[i * 3 + 2] = rng();
    }
    const geo = track(new BufferGeometry());
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('aScale', new BufferAttribute(scales, 1));
    geo.setAttribute('aSeed', new BufferAttribute(seeds, 3));
    const uniforms = {
      uTime: { value: 0 },
      uSize: { value: 22 },
      uPixelRatio: { value: Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2) },
      uColor: { value: new Color(1.0, 0.98, 0.75) },
      uOpacity: { value: 0.42 },
    };
    const mat = track(
      new ShaderMaterial({
        uniforms,
        vertexShader: MOTE_VERT,
        fragmentShader: MOTE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    const motes = new Points(geo, mat);
    motes.frustumCulled = false;
    group.add(motes);
    moteUniforms = uniforms;
  }

  // ---- Sky dome ---------------------------------------------------------
  {
    const geo = track(new SphereGeometry(halfSize * 2.6, 48, 28));
    const mat = track(
      new MeshBasicMaterial({ map: assets.sky(), side: BackSide, fog: false, depthWrite: false }),
    );
    const sky = new Mesh(geo, mat);
    sky.renderOrder = -2;
    group.add(sky);
  }

  // ---- Collision / floor ------------------------------------------------
  const shoreY = waterY + 0.35; // can't wade past this — no walking on water
  const lim = halfSize - 6;

  /**
   * Walkable height: the terrain, or the top of a prop you're standing on, so
   * boulders and logs can actually be jumped onto.
   */
  const floorHeightAt = (x: number, z: number): number => {
    let h = Math.max(surfaceAt(x, z), shoreY);
    forEachNearProp(x, z, (p) => {
      if (p.top <= h) return;
      const dx = x - p.x;
      const dz = z - p.z;
      // Slightly inset so you stand on the cap, not on thin air at the rim.
      const r = p.r * 0.85;
      if (dx * dx + dz * dz < r * r) h = p.top;
    });
    return h;
  };

  const collide = (p: Vector3): void => {
    p.x = Math.max(-lim, Math.min(lim, p.x));
    p.z = Math.max(-lim, Math.min(lim, p.z));

    // Push out of trunks/boulders — but only while below their top, so you can
    // stand on a rock instead of being shoved off it.
    const pr = 0.4; // player radius
    forEachNearProp(p.x, p.z, (o) => {
      if (!o.solid) return;
      if (p.y >= o.top - 0.15) return; // standing on (or above) it
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const minD = o.r + pr;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD * minD && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (minD - d) / d;
        p.x += dx * push;
        p.z += dz * push;
      }
    });

    // Shoreline barrier: climb the height gradient back onto dry land.
    for (let iter = 0; iter < 6; iter++) {
      if (surfaceAt(p.x, p.z) >= shoreY) break;
      const gx = surfaceAt(p.x + 2, p.z) - surfaceAt(p.x - 2, p.z);
      const gz = surfaceAt(p.x, p.z + 2) - surfaceAt(p.x, p.z - 2);
      const len = Math.hypot(gx, gz);
      if (len < 1e-4) break;
      p.x += (gx / len) * 1.1;
      p.z += (gz / len) * 1.1;
    }
  };

  /** True inside a tree/rock or under the ground — used to clamp the camera. */
  const blocksCamera = (x: number, y: number, z: number): boolean => {
    if (y < surfaceAt(x, z) + 0.3) return true;
    let hit = false;
    forEachNearProp(x, z, (o) => {
      if (hit || y > o.top) return; // above it → clear line of sight
      const dx = x - o.x;
      const dz = z - o.z;
      // Slightly tighter than the player collider so brushing past a trunk
      // doesn't yank the camera all the way in.
      const r = o.r * 0.72;
      if (dx * dx + dz * dz < r * r) hit = true;
    });
    return hit;
  };

  const isAtPortal = (x: number, y: number, z: number): boolean => portal.contains(x, y, z);

  const update = (elapsed: number): void => {
    timeUniform.value = elapsed;
    if (moteUniforms) moteUniforms.uTime.value = elapsed;
    portal.update(elapsed);
  };

  const dispose = (): void => {
    portal.dispose();
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    disposables.length = 0;
    obstacles.clear();
  };

  return {
    group,
    floorHeightAt,
    collide,
    update,
    dispose,
    // Stand in front of the portal facing +Z, i.e. out into the world.
    spawn: { x: 0, z: 14, yaw: Math.PI },
    isAtPortal,
    blocksCamera,
  };
}
