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
  PointLight,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildRock } from './Flora.ts';
import type { PropRegistry } from './PropRegistry.ts';
import { biomeAt, cellRandom, elevationAt, slopeAt, WORLD } from './WorldGen.ts';

/**
 * Landmarks
 * ---------
 * Hand-feeling points of interest scattered across the world: campfires,
 * abandoned camps, ruined colonnades and standing stone circles. They are placed
 * one per large cell so they stay rare enough to feel like a discovery, and they
 * stream in and out with the player like everything else.
 */

/** Side of the placement cell in metres — roughly one landmark per this area. */
const CELL = 420;
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
  light: PointLight;
  uniforms: { uTime: { value: number } };
  baseIntensity: number;
  seed: number;
  /** Releases the ember particle buffers, which are unique per fire. */
  dispose(): void;
}

export interface LandmarkStreamer {
  group: Group;
  update(position: Vector3, elapsed: number): void;
  pump(): number;
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
function buildEmbers(): { points: Points; uniforms: { uTime: { value: number } }; dispose(): void } {
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

  const uniforms = { uTime: { value: 0 } };
  const mat = new ShaderMaterial({
    uniforms,
    vertexShader: FIRE_VERT,
    fragmentShader: FIRE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const points = new Points(geo, mat);
  points.frustumCulled = false;
  return {
    points,
    uniforms,
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}

interface Materials {
  wood: MeshStandardMaterial;
  stone: MeshStandardMaterial;
  cloth: MeshStandardMaterial;
  flame: MeshBasicMaterial;
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
  const ring = mergeGeometries(ringParts, false);
  for (const p of ringParts) p.dispose();
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

  const embers = buildEmbers();
  root.add(embers.points);

  const light = new PointLight(new Color(1.0, 0.62, 0.28), 9, 26, 2);
  light.position.set(0, 1.1, 0);
  root.add(light);

  return {
    group: root,
    fire: {
      light,
      uniforms: embers.uniforms,
      baseIntensity: 9,
      seed: Math.random() * 10,
      dispose: embers.dispose,
    },
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

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
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
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged) {
    const mesh = new Mesh(merged, mats.stone);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
  return root;
}

export function createLandmarks(registry: PropRegistry): LandmarkStreamer {
  const group = new Group();
  group.name = 'Landmarks';

  const mats: Materials = {
    wood: new MeshStandardMaterial({ color: new Color(0.3, 0.22, 0.15), roughness: 0.95, flatShading: true }),
    stone: new MeshStandardMaterial({ color: new Color(0.52, 0.52, 0.5), roughness: 1, flatShading: true }),
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
  };
  const rockGeo = buildRock(77, 1);

  const loaded = new Map<string, LandmarkChunk>();
  const pending = new Map<string, { cx: number; cz: number; dist: number }>();
  const key = (cx: number, cz: number): string => `${cx}|${cz}`;

  const buildChunk = (cx: number, cz: number): void => {
    const k = key(cx, cz);
    if (loaded.has(k)) return;

    const rand = (n: number): number => cellRandom(cx * 31 + n, cz * 17 - n, 555);
    const chunk: LandmarkChunk = { key: k, cx, cz, root: new Group(), fires: [] };

    // One candidate per cell, jittered inside it; some cells stay empty.
    const x = (cx + 0.15 + rand(1) * 0.7) * CELL;
    const z = (cz + 0.15 + rand(2) * 0.7) * CELL;

    const place = (): void => {
      if (Math.abs(x) > WORLD.halfSize - 80 || Math.abs(z) > WORLD.halfSize - 80) return;
      if (Math.hypot(x, z) < WORLD.plazaRadius * 2) return; // keep spawn clear
      const h = elevationAt(x, z);
      if (h < WORLD.waterLevel + 1.5) return; // not in the sea
      if (slopeAt(x, z, 6) > 0.35) return; // needs reasonably flat ground

      const roll = rand(3);
      if (roll < 0.3) return; // empty cell — landmarks should feel rare

      const biome = biomeAt(x, z, h);
      let kind: LandmarkKind;
      if (roll < 0.52) kind = 'campfire';
      else if (roll < 0.68) kind = 'camp';
      else if (roll < 0.86) kind = 'ruin';
      else kind = 'stones';
      // Snow and highland peaks get shelters rather than overgrown ruins.
      if ((biome === 'snow' || biome === 'highland') && kind === 'ruin') kind = 'camp';

      const site = new Group();
      site.position.set(x, h, z);
      site.rotation.y = rand(4) * Math.PI * 2;

      switch (kind) {
        case 'campfire': {
          const { group: fireGroup, fire } = buildCampfire(mats);
          site.add(fireGroup);
          chunk.fires.push(fire);
          // A couple of sitting stones around it.
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2 + rand(i + 11);
            const stone = new Mesh(rockGeo, mats.stone);
            const s = 0.5 + rand(i + 13) * 0.3;
            stone.position.set(Math.cos(a) * 1.9, s * 0.3, Math.sin(a) * 1.9);
            stone.scale.setScalar(s);
            site.add(stone);
          }
          registry.add(k, { x, z, r: 1.1, top: h + 0.4, solid: false });
          break;
        }
        case 'camp': {
          const { group: fireGroup, fire } = buildCampfire(mats);
          fireGroup.position.set(2.6, 0, 0);
          site.add(fireGroup);
          chunk.fires.push(fire);
          const tent = buildTent(mats);
          tent.position.set(-1.6, 0, 0.4);
          site.add(tent);
          registry.add(k, { x: x - 1.6, z: z + 0.4, r: 1.5, top: h + 1.3, solid: true });
          break;
        }
        case 'ruin':
          site.add(buildRuin(mats, rand));
          registry.add(k, { x, z, r: 1.0, top: h, solid: false });
          break;
        case 'stones':
          site.add(buildStoneCircle(mats, rand));
          break;
      }

      chunk.root.add(site);
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
    const pcx = Math.round(position.x / CELL);
    const pcz = Math.round(position.z / CELL);

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

    // Animate every visible fire: flicker the light and advance the embers.
    for (const chunk of loaded.values()) {
      for (const fire of chunk.fires) {
        fire.uniforms.uTime.value = elapsed;
        const flicker =
          Math.sin(elapsed * 11 + fire.seed) * 0.18 + Math.sin(elapsed * 23 + fire.seed * 3) * 0.1;
        fire.light.intensity = fire.baseIntensity * (1 + flicker);
      }
    }
  };

  const pump = (): number => {
    if (pending.size === 0) return 0;
    const queue = [...pending.entries()].sort((a, b) => a[1].dist - b[1].dist);
    const [k, want] = queue[0]!;
    pending.delete(k);
    buildChunk(want.cx, want.cz);
    return pending.size;
  };

  const prime = (position: Vector3, cells: number): void => {
    const pcx = Math.round(position.x / CELL);
    const pcz = Math.round(position.z / CELL);
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
  };

  return { group, update, pump, prime, dispose };
}
