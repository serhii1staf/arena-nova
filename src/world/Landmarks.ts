import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  PointLight,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssetManager } from '../core/AssetManager.ts';
import { applyTriplanarUV } from './builders/geometry.ts';
import { buildRock } from './Flora.ts';
import type { PropRegistry } from './PropRegistry.ts';
import {
  cellRandom,
  LANDMARK_CELL,
  landmarkSiteFor,
  surfaceBiomeAt,
  surfaceHeightAt,
  surfaceSlopeAt,
} from './WorldGen.ts';

/**
 * Landmarks
 * ---------
 * Hand-feeling points of interest scattered across the world: campfires,
 * abandoned camps, ruined colonnades and standing stone circles. They are placed
 * one per large cell so they stay rare enough to feel like a discovery, and they
 * stream in and out with the player like everything else.
 */

/**
 * Placement grid. Owned by WorldGen, because the terrain has to level a pad for
 * each site — the two must agree or the props stop matching their ground.
 */
const CELL = LANDMARK_CELL;
/** How many cells out landmarks stream. */
const VIEW_CELLS = 2;

type LandmarkKind = 'campfire' | 'camp' | 'ruin' | 'stones';

interface LandmarkChunk {
  key: string;
  cx: number;
  cz: number;
  root: Group;
  fires: FireEffect[];
}

interface FireEffect {
  /** The flame's own node, used once to resolve its world position. */
  object: Object3D;
  /** World position of the flame, used to hand out lights from the pool. */
  x: number;
  y: number;
  z: number;
  seed: number;
  /** Releases the ember particle buffers, which are unique per fire. */
  dispose(): void;
}

/**
 * How many campfires can be lit at once.
 *
 * This is a hard pool rather than one light per fire, and that is a performance
 * decision, not an aesthetic one: three.js bakes the light count into every
 * shader program it compiles. Adding or removing a PointLight therefore
 * invalidates and recompiles *every* material in the scene — which is what made
 * the frame rate collapse the moment a landmark cell streamed in. With a fixed
 * pool the count never changes after the first frame.
 */
const FIRE_LIGHT_POOL = 4;
/** Beyond this a campfire's light reaches nothing, so it needn't hold a slot. */
const LIGHT_ASSIGN_RANGE = 40;
const FIRE_INTENSITY = 9;

export interface LandmarkStreamer {
  group: Group;
  update(position: Vector3, elapsed: number): void;
  /** Build pending cells until `deadline` (a `performance.now()` stamp). */
  pump(deadline: number): number;
  prime(position: Vector3, cells: number): void;
  dispose(): void;
}

const FIRE_VERT = /* glsl */ `
  uniform float uTime;
  attribute float aSeed;
  attribute float aScale;
  varying float vLife;
  void main() {
    // Each ember loops upward on its own offset timeline.
    float life = fract(uTime * 0.55 + aSeed);
    vLife = life;
    vec3 p = position;
    p.y += life * 2.6;
    float spread = life * 0.55;
    p.x += sin((aSeed + life) * 21.0) * spread;
    p.z += cos((aSeed + life) * 17.0) * spread;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aScale * (1.0 - life) * 34.0 / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FIRE_FRAG = /* glsl */ `
  varying float vLife;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    // Bright yellow core cooling to red as the ember rises.
    vec3 hot = vec3(1.0, 0.86, 0.42);
    vec3 cool = vec3(0.85, 0.24, 0.06);
    vec3 col = mix(hot, cool, vLife);
    float alpha = (1.0 - vLife) * smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(col, alpha);
  }
`;

/** Builds the ember particle system for one fire. */
/**
 * Ember particles for one fire. The material is passed in and shared across
 * every fire in the world — a `ShaderMaterial` per campfire meant a fresh shader
 * program compile for each landmark that streamed in.
 */
function buildEmbers(material: ShaderMaterial): { points: Points; dispose(): void } {
  const count = 40;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const scales = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 0.5;
    positions[i * 3 + 1] = 0.25;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
    seeds[i] = Math.random();
    scales[i] = 0.5 + Math.random() * 0.8;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  geo.setAttribute('aScale', new BufferAttribute(scales, 1));

  const points = new Points(geo, material);
  points.frustumCulled = false;
  return { points, dispose: () => geo.dispose() };
}

interface Materials {
  wood: MeshStandardMaterial;
  stone: MeshStandardMaterial;
  cloth: MeshStandardMaterial;
  flame: MeshBasicMaterial;
  embers: ShaderMaterial;
}

/** A ring of stones with crossed logs and a flame billboard. */
function buildCampfire(mats: Materials): { group: Group; fire: FireEffect } {
  const root = new Group();

  // Stone ring.
  const ringParts: BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const stone = new BoxGeometry(0.32, 0.24, 0.26);
    stone.translate(Math.cos(a) * 0.72, 0.1, Math.sin(a) * 0.72);
    ringParts.push(stone);
  }
  const ring = mergeStone(ringParts);
  if (ring) root.add(new Mesh(ring, mats.stone));

  // Crossed logs.
  const logParts: BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI + 0.4;
    const log = new CylinderGeometry(0.075, 0.09, 1.15, 5);
    log.rotateZ(Math.PI / 2 - 0.55);
    log.rotateY(a);
    log.translate(0, 0.3, 0);
    logParts.push(log);
  }
  const logs = mergeGeometries(logParts, false);
  for (const p of logParts) p.dispose();
  if (logs) root.add(new Mesh(logs, mats.wood));

  // Flame: two crossed cones, additive, so it reads from any angle.
  for (let i = 0; i < 2; i++) {
    const cone = new ConeGeometry(0.3, 0.95, 5, 1, true);
    const flame = new Mesh(cone, mats.flame);
    flame.position.y = 0.62;
    flame.rotation.y = (i * Math.PI) / 2;
    root.add(flame);
  }

  const embers = buildEmbers(mats.embers);
  root.add(embers.points);

  // No light here — lights come from the shared pool once the world position of
  // this fire is known (see `assignFireLights`).
  return {
    group: root,
    fire: { object: root, x: 0, y: 0, z: 0, seed: Math.random() * 10, dispose: embers.dispose },
  };
}

/** Lean-to tent from two cloth panels plus a bedroll. */
function buildTent(mats: Materials): Group {
  const root = new Group();
  for (const side of [-1, 1]) {
    const panel = new BoxGeometry(2.4, 0.06, 1.9);
    panel.translate(0, 0, (side * 1.9) / 2);
    const mesh = new Mesh(panel, mats.cloth);
    mesh.rotation.x = side * 0.85;
    mesh.position.y = 0.75;
    root.add(mesh);
  }
  // Ridge pole.
  const pole = new CylinderGeometry(0.05, 0.05, 2.7, 5);
  pole.rotateZ(Math.PI / 2);
  pole.translate(0, 1.32, 0);
  root.add(new Mesh(pole, mats.wood));
  return root;
}

/**
 * Merges stone parts and gives them world-projected UVs. Each primitive brings
 * its own 0..1 UVs, so a merged ruin would show the stone texture at a different
 * scale on every column. Triplanar projection puts it at one real-world scale
 * across the whole structure.
 */
function mergeStone(parts: BufferGeometry[]): BufferGeometry | null {
  const merged = mergeGeometries(
    parts.map((p) => (p.index ? p.toNonIndexed() : p)),
    false,
  );
  for (const p of parts) p.dispose();
  if (!merged) return null;
  return applyTriplanarUV(merged, 0.4);
}

/** Broken colonnade: standing stumps, toppled drums and rubble. */
function buildRuin(mats: Materials, rand: (n: number) => number): Group {
  const root = new Group();
  const parts: BufferGeometry[] = [];
  const count = 5 + Math.floor(rand(1) * 5);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand(i + 2) * 0.5;
    const rad = 4 + rand(i + 9) * 7;
    const x = Math.cos(a) * rad;
    const z = Math.sin(a) * rad;
    if (rand(i + 20) < 0.5) {
      const h = 2.4 + rand(i + 31) * 4;
      const col = new CylinderGeometry(0.55, 0.7, h, 9);
      col.translate(x, h / 2, z);
      parts.push(col);
    } else {
      const drum = new CylinderGeometry(0.6, 0.62, 2.6, 9);
      drum.rotateZ(Math.PI / 2);
      drum.rotateY(rand(i + 44) * Math.PI);
      drum.translate(x, 0.6, z);
      parts.push(drum);
    }
  }
  // A surviving lintel across two columns.
  const lintel = new BoxGeometry(5.2, 0.7, 0.9);
  lintel.translate(0, 5.2, 0);
  parts.push(lintel);

  const merged = mergeStone(parts);
  if (merged) {
    const mesh = new Mesh(merged, mats.stone);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
  return root;
}

/** Standing stone circle. */
function buildStoneCircle(mats: Materials, rand: (n: number) => number): Group {
  const root = new Group();
  const parts: BufferGeometry[] = [];
  const count = 7 + Math.floor(rand(3) * 4);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const rad = 7.5;
    const h = 3 + rand(i + 5) * 2.6;
    const stone = new BoxGeometry(1.1, h, 0.7);
    stone.translate(Math.cos(a) * rad, h / 2, Math.sin(a) * rad);
    parts.push(stone);
  }
  const merged = mergeStone(parts);
  if (merged) {
    const mesh = new Mesh(merged, mats.stone);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
  return root;
}

export function createLandmarks(assets: AssetManager, registry: PropRegistry): LandmarkStreamer {
  const group = new Group();
  group.name = 'Landmarks';

  const stoneTex = assets.stone(1);
  const mats: Materials = {
    wood: new MeshStandardMaterial({
      color: new Color(0.3, 0.22, 0.15),
      normalMap: stoneTex.normalMap,
      roughnessMap: stoneTex.roughnessMap,
      roughness: 0.95,
    }),
    // Textured, and darker than before. Ruins used to be an untextured 0.52 grey,
    // which under the outdoor lighting rig came out as flat white slabs.
    stone: new MeshStandardMaterial({
      color: new Color(0.46, 0.46, 0.44),
      map: stoneTex.map,
      normalMap: stoneTex.normalMap,
      roughnessMap: stoneTex.roughnessMap,
      roughness: 1,
      vertexColors: false,
    }),
    cloth: new MeshStandardMaterial({
      color: new Color(0.55, 0.48, 0.36),
      roughness: 0.9,
      side: DoubleSide,
      flatShading: true,
    }),
    flame: new MeshBasicMaterial({
      color: new Color(1.0, 0.62, 0.24),
      transparent: true,
      opacity: 0.75,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    }),
    // One ember program for the whole world; `uTime` is global elapsed time, so
    // every fire can share it and still flicker independently (the per-particle
    // seed does that inside the shader).
    embers: new ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: FIRE_VERT,
      fragmentShader: FIRE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  };
  const rockGeo = buildRock(77, 1);

  // Fixed pool of fire lights, added once so the scene's light count is stable
  // from the first frame onwards and no material is ever recompiled mid-play.
  const fireLights: PointLight[] = [];
  for (let i = 0; i < FIRE_LIGHT_POOL; i++) {
    const light = new PointLight(new Color(1.0, 0.62, 0.28), 0, 26, 2);
    light.visible = true;
    group.add(light);
    fireLights.push(light);
  }

  const loaded = new Map<string, LandmarkChunk>();
  const pending = new Map<string, { cx: number; cz: number; dist: number }>();
  const key = (cx: number, cz: number): string => `${cx}|${cz}`;
  const scratch = new Vector3();
  /** Reused each frame so light assignment allocates nothing. */
  const nearestFires: Array<{ fire: FireEffect; d2: number }> = [];

  const buildChunk = (cx: number, cz: number): void => {
    const k = key(cx, cz);
    if (loaded.has(k)) return;

    const rand = (n: number): number => cellRandom(cx * 31 + n, cz * 17 - n, 555);
    const chunk: LandmarkChunk = { key: k, cx, cz, root: new Group(), fires: [] };

    const place = (): void => {
      // Where a landmark goes — and whether the cell has one at all — is decided
      // in WorldGen, because the terrain has to level a pad there. Duplicating
      // the test here is how the props and their ground used to drift apart.
      const site = landmarkSiteFor(cx, cz);
      if (!site) return;
      const { x, z } = site;
      // Read the drawn surface rather than the analytic field: on the levelled
      // pad they agree exactly, so nothing hovers at any view distance.
      const h = surfaceHeightAt(x, z);
      if (surfaceSlopeAt(x, z) > 0.35) return;

      const roll = rand(3);
      const biome = surfaceBiomeAt(x, z);
      let kind: LandmarkKind;
      if (roll < 0.52) kind = 'campfire';
      else if (roll < 0.68) kind = 'camp';
      else if (roll < 0.86) kind = 'ruin';
      else kind = 'stones';
      // Snow and highland peaks get shelters rather than overgrown ruins.
      if ((biome === 'snow' || biome === 'highland') && kind === 'ruin') kind = 'camp';

      const anchor = new Group();
      anchor.position.set(x, h, z);
      anchor.rotation.y = rand(4) * Math.PI * 2;

      switch (kind) {
        case 'campfire': {
          const { group: fireGroup, fire } = buildCampfire(mats);
          anchor.add(fireGroup);
          chunk.fires.push(fire);
          // A couple of sitting stones around it.
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2 + rand(i + 11);
            const stone = new Mesh(rockGeo, mats.stone);
            const s = 0.5 + rand(i + 13) * 0.3;
            stone.position.set(Math.cos(a) * 1.9, s * 0.3, Math.sin(a) * 1.9);
            stone.scale.setScalar(s);
            anchor.add(stone);
          }
          registry.add(k, { x, z, r: 1.1, top: h + 0.4, blockTop: h + 0.4, solid: false });
          break;
        }
        case 'camp': {
          const { group: fireGroup, fire } = buildCampfire(mats);
          fireGroup.position.set(2.6, 0, 0);
          anchor.add(fireGroup);
          chunk.fires.push(fire);
          const tent = buildTent(mats);
          tent.position.set(-1.6, 0, 0.4);
          anchor.add(tent);
          registry.add(k, {
            x: x - 1.6,
            z: z + 0.4,
            r: 1.5,
            top: h + 1.3,
            blockTop: h + 1.3,
            solid: true,
          });
          break;
        }
        case 'ruin':
          anchor.add(buildRuin(mats, rand));
          registry.add(k, { x, z, r: 1.0, top: h, blockTop: h, solid: false });
          break;
        case 'stones':
          anchor.add(buildStoneCircle(mats, rand));
          break;
      }

      chunk.root.add(anchor);
      // Resolve each flame's world position now, once: the light pool needs it
      // every frame and fires never move.
      anchor.updateMatrixWorld(true);
      for (const fire of chunk.fires) {
        fire.object.getWorldPosition(scratch);
        fire.x = scratch.x;
        fire.y = scratch.y;
        fire.z = scratch.z;
      }
    };

    place();
    if (chunk.root.children.length > 0) group.add(chunk.root);
    loaded.set(k, chunk);
  };

  const dropChunk = (chunk: LandmarkChunk): void => {
    group.remove(chunk.root);
    chunk.root.traverse((o) => {
      const mesh = o as Mesh;
      // Shared materials and the shared rock geometry are disposed at the end.
      if (mesh.geometry && mesh.geometry !== rockGeo) mesh.geometry.dispose();
    });
    for (const fire of chunk.fires) fire.dispose();
    registry.removeOwner(chunk.key);
    loaded.delete(chunk.key);
  };

  const update = (position: Vector3, elapsed: number): void => {
    // Cells are corner-anchored (see `landmarkSiteFor`), so the containing cell
    // is floor, not round.
    const pcx = Math.floor(position.x / CELL);
    const pcz = Math.floor(position.z / CELL);

    for (let dz = -VIEW_CELLS; dz <= VIEW_CELLS; dz++) {
      for (let dx = -VIEW_CELLS; dx <= VIEW_CELLS; dx++) {
        const k = key(pcx + dx, pcz + dz);
        if (loaded.has(k) || pending.has(k)) continue;
        pending.set(k, { cx: pcx + dx, cz: pcz + dz, dist: dx * dx + dz * dz });
      }
    }
    for (const chunk of [...loaded.values()]) {
      const ring = Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz));
      if (ring > VIEW_CELLS + 1) dropChunk(chunk);
    }

    // Embers everywhere share one uniform — one write per frame, not one per fire.
    mats.embers.uniforms.uTime!.value = elapsed;

    // Hand the light pool to the nearest fires. Anything further away than the
    // light's own range contributes nothing anyway, so this is invisible.
    nearestFires.length = 0;
    for (const chunk of loaded.values()) {
      for (const fire of chunk.fires) {
        const d2 =
          (fire.x - position.x) * (fire.x - position.x) +
          (fire.z - position.z) * (fire.z - position.z);
        if (d2 > LIGHT_ASSIGN_RANGE * LIGHT_ASSIGN_RANGE) continue;
        nearestFires.push({ fire, d2 });
      }
    }
    nearestFires.sort((a, b) => a.d2 - b.d2);

    for (let i = 0; i < fireLights.length; i++) {
      const light = fireLights[i]!;
      const entry = nearestFires[i];
      if (!entry) {
        // Keep the light in the scene (the count must not change) but dark.
        light.intensity = 0;
        continue;
      }
      const { fire } = entry;
      light.position.set(fire.x, fire.y + 1.1, fire.z);
      const flicker =
        Math.sin(elapsed * 11 + fire.seed) * 0.18 + Math.sin(elapsed * 23 + fire.seed * 3) * 0.1;
      light.intensity = FIRE_INTENSITY * (1 + flicker);
    }
  };

  const pump = (deadline: number): number => {
    if (pending.size === 0) return 0;
    const queue = [...pending.entries()].sort((a, b) => a[1].dist - b[1].dist);
    for (let i = 0; i < queue.length; i++) {
      if (i > 0 && performance.now() >= deadline) break;
      const [k, want] = queue[i]!;
      pending.delete(k);
      buildChunk(want.cx, want.cz);
    }
    return pending.size;
  };

  const prime = (position: Vector3, cells: number): void => {
    const pcx = Math.floor(position.x / CELL);
    const pcz = Math.floor(position.z / CELL);
    for (let dz = -cells; dz <= cells; dz++) {
      for (let dx = -cells; dx <= cells; dx++) {
        buildChunk(pcx + dx, pcz + dz);
        pending.delete(key(pcx + dx, pcz + dz));
      }
    }
  };

  const dispose = (): void => {
    for (const chunk of [...loaded.values()]) dropChunk(chunk);
    pending.clear();
    rockGeo.dispose();
    mats.wood.dispose();
    mats.stone.dispose();
    mats.cloth.dispose();
    mats.flame.dispose();
    mats.embers.dispose();
    for (const light of fireLights) group.remove(light);
    fireLights.length = 0;
  };

  return { group, update, pump, prime, dispose };
}
