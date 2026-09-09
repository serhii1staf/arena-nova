import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  surfaceBiomeAt,
  surfaceHeightAt,
  surfaceSlopeAt,
  WORLD,
  type BiomeId,
} from './WorldGen.ts';

/**
 * Wildlife
 * --------
 * Animals that live their own lives in the open world: they graze, wander a
 * little, and bolt when the player gets close.
 *
 * Everything about the implementation is shaped by the draw-call budget. A herd
 * of animals built the obvious way — a Group of body plus four legs each — would
 * cost five draws per animal and dominate the frame. Instead there is exactly one
 * `InstancedMesh` per species, and the legs, head and tail are articulated in the
 * vertex shader from per-instance attributes. All the wildlife in the world is
 * three draw calls.
 *
 * Animals are not placed deterministically the way landmarks are: they are a
 * recycled pool that respawns out of sight in a ring around the player. Wildlife
 * does not need to be in the same spot for every player — and when this becomes
 * multiplayer, positions will come from the server anyway.
 */

export type SpeciesId = 'deer' | 'boar' | 'rabbit';

/** Limb ids baked per vertex; the shader keys its articulation off these. */
const LIMB_BODY = 0;
const LIMB_LEG_FL = 1;
const LIMB_LEG_FR = 2;
const LIMB_LEG_BL = 3;
const LIMB_LEG_BR = 4;
const LIMB_HEAD = 5;
const LIMB_TAIL = 6;

interface Species {
  id: SpeciesId;
  /** Biomes this animal will spawn in. */
  biomes: BiomeId[];
  /** Metres per second when calm, and when fleeing. */
  walkSpeed: number;
  runSpeed: number;
  /** How close the player can get before it bolts. */
  alertRadius: number;
  /** Stride frequency scale — small animals take faster steps. */
  gaitRate: number;
  /** Share of the pool devoted to this species. */
  weight: number;
  build(): BufferGeometry;
}

/** Maximum animals alive at once. Bounds both CPU work and instance count. */
const POOL_SIZE = 18;
/** Animals outside this radius are recycled. */
const DESPAWN_RADIUS = 190;
/** Respawn ring, comfortably outside the alert radius. */
const SPAWN_MIN = 70;
const SPAWN_MAX = 150;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface Part {
  geo: BufferGeometry;
  colour: Color;
  limb: number;
  /** Pivot the limb rotates about, in object space. */
  hip: Vector3;
}

/**
 * Merges parts, baking the per-vertex colour, limb id and pivot the shader needs.
 * Every part goes through here so the attribute sets always match at merge time.
 */
function assemble(parts: Part[]): BufferGeometry {
  const prepared: BufferGeometry[] = [];
  for (const part of parts) {
    const geo = part.geo.index ? part.geo.toNonIndexed() : part.geo;
    if (geo !== part.geo) part.geo.dispose();
    const n = geo.attributes.position.count;
    const colour = new Float32Array(n * 3);
    const limb = new Float32Array(n);
    const hip = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colour[i * 3] = part.colour.r;
      colour[i * 3 + 1] = part.colour.g;
      colour[i * 3 + 2] = part.colour.b;
      limb[i] = part.limb;
      hip[i * 3] = part.hip.x;
      hip[i * 3 + 1] = part.hip.y;
      hip[i * 3 + 2] = part.hip.z;
    }
    geo.setAttribute('color', new BufferAttribute(colour, 3));
    geo.setAttribute('aLimb', new BufferAttribute(limb, 1));
    geo.setAttribute('aHip', new BufferAttribute(hip, 3));
    prepared.push(geo);
  }
  const merged = mergeGeometries(prepared, false);
  for (const g of prepared) g.dispose();
  if (!merged) throw new Error('Wildlife: geometry merge failed');
  return merged;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/**
 * Four legs at the corners of a body. Each leg's pivot is its top, so the shader
 * swings it from the hip rather than sliding the whole limb sideways.
 */
function legs(
  parts: Part[],
  colour: Color,
  hipY: number,
  legLength: number,
  thickness: number,
  halfWidth: number,
  frontZ: number,
  backZ: number,
): void {
  const layout: Array<[number, number, number]> = [
    [LIMB_LEG_FL, -halfWidth, frontZ],
    [LIMB_LEG_FR, halfWidth, frontZ],
    [LIMB_LEG_BL, -halfWidth, backZ],
    [LIMB_LEG_BR, halfWidth, backZ],
  ];
  for (const [limb, x, z] of layout) {
    parts.push({
      geo: box(thickness, legLength, thickness, x, hipY - legLength / 2, z),
      colour,
      limb,
      hip: new Vector3(x, hipY, z),
    });
  }
}

/** Slender, long-legged browser. Faces −Z, like the player character. */
function buildDeer(): BufferGeometry {
  const parts: Part[] = [];
  const coat = new Color(0.46, 0.3, 0.18);
  const belly = new Color(0.62, 0.47, 0.33);
  const dark = new Color(0.2, 0.14, 0.1);

  const hipY = 0.92;
  parts.push({ geo: box(0.46, 0.5, 1.15, 0, hipY + 0.12, 0), colour: coat, limb: LIMB_BODY, hip: new Vector3() });
  parts.push({ geo: box(0.4, 0.22, 0.9, 0, hipY - 0.06, 0.02), colour: belly, limb: LIMB_BODY, hip: new Vector3() });

  // Neck and head pivot at the shoulder, so grazing dips the whole neck.
  const neckHip = new Vector3(0, hipY + 0.3, -0.5);
  const neck = new BoxGeometry(0.2, 0.55, 0.22);
  neck.translate(0, 0.24, -0.1);
  neck.rotateX(-0.35);
  neck.translate(neckHip.x, neckHip.y, neckHip.z);
  parts.push({ geo: neck, colour: coat, limb: LIMB_HEAD, hip: neckHip });
  const head = new BoxGeometry(0.22, 0.22, 0.42);
  head.translate(0, 0.52, -0.34);
  head.translate(neckHip.x, neckHip.y, neckHip.z);
  parts.push({ geo: head, colour: coat, limb: LIMB_HEAD, hip: neckHip });
  for (const side of [-1, 1]) {
    const ear = new ConeGeometry(0.07, 0.2, 5);
    ear.rotateX(-0.3);
    ear.translate(side * 0.11, 0.68, -0.2);
    ear.translate(neckHip.x, neckHip.y, neckHip.z);
    parts.push({ geo: ear, colour: dark, limb: LIMB_HEAD, hip: neckHip });
    // Antlers: two forked prongs, enough to read as a stag in silhouette.
    const antler = new BoxGeometry(0.04, 0.34, 0.04);
    antler.rotateZ(side * 0.35);
    antler.rotateX(-0.2);
    antler.translate(side * 0.09, 0.86, -0.24);
    antler.translate(neckHip.x, neckHip.y, neckHip.z);
    parts.push({ geo: antler, colour: dark, limb: LIMB_HEAD, hip: neckHip });
  }

  const tailHip = new Vector3(0, hipY + 0.28, 0.58);
  const tail = new BoxGeometry(0.1, 0.22, 0.08);
  tail.translate(0, -0.1, 0.03);
  parts.push({
    geo: (tail.translate(tailHip.x, tailHip.y, tailHip.z), tail),
    colour: belly,
    limb: LIMB_TAIL,
    hip: tailHip,
  });

  legs(parts, coat, hipY, 0.88, 0.11, 0.17, -0.42, 0.44);
  return assemble(parts);
}

/** Low, heavy and bristly. Shorter legs, no antlers. */
function buildBoar(): BufferGeometry {
  const parts: Part[] = [];
  const hide = new Color(0.24, 0.19, 0.16);
  const bristle = new Color(0.14, 0.11, 0.1);
  const tusk = new Color(0.86, 0.84, 0.74);

  const hipY = 0.58;
  parts.push({ geo: box(0.52, 0.5, 1.05, 0, hipY + 0.08, 0), colour: hide, limb: LIMB_BODY, hip: new Vector3() });
  // Ridge of bristles along the spine.
  parts.push({ geo: box(0.12, 0.16, 0.8, 0, hipY + 0.36, 0.02), colour: bristle, limb: LIMB_BODY, hip: new Vector3() });

  const headHip = new Vector3(0, hipY + 0.16, -0.48);
  const snout = new BoxGeometry(0.3, 0.3, 0.5);
  snout.translate(0, 0.02, -0.22);
  snout.translate(headHip.x, headHip.y, headHip.z);
  parts.push({ geo: snout, colour: hide, limb: LIMB_HEAD, hip: headHip });
  for (const side of [-1, 1]) {
    const t = new ConeGeometry(0.035, 0.18, 4);
    t.rotateX(-1.9);
    t.translate(side * 0.11, 0.0, -0.44);
    t.translate(headHip.x, headHip.y, headHip.z);
    parts.push({ geo: t, colour: tusk, limb: LIMB_HEAD, hip: headHip });
  }

  const tailHip = new Vector3(0, hipY + 0.24, 0.52);
  const tail = new BoxGeometry(0.06, 0.18, 0.06);
  tail.translate(0, -0.08, 0.02);
  tail.translate(tailHip.x, tailHip.y, tailHip.z);
  parts.push({ geo: tail, colour: bristle, limb: LIMB_TAIL, hip: tailHip });

  legs(parts, bristle, hipY, 0.52, 0.11, 0.19, -0.36, 0.38);
  return assemble(parts);
}

/** Tiny, twitchy, and the one you are most likely to startle. */
function buildRabbit(): BufferGeometry {
  const parts: Part[] = [];
  const fur = new Color(0.55, 0.48, 0.4);
  const pale = new Color(0.82, 0.79, 0.72);

  const hipY = 0.24;
  const body = new SphereGeometry(0.19, 8, 6);
  body.scale(1, 0.9, 1.35);
  body.translate(0, hipY + 0.04, 0);
  parts.push({ geo: body, colour: fur, limb: LIMB_BODY, hip: new Vector3() });

  const headHip = new Vector3(0, hipY + 0.1, -0.2);
  const head = new SphereGeometry(0.12, 8, 6);
  head.translate(0, 0.04, -0.06);
  head.translate(headHip.x, headHip.y, headHip.z);
  parts.push({ geo: head, colour: fur, limb: LIMB_HEAD, hip: headHip });
  for (const side of [-1, 1]) {
    const ear = new BoxGeometry(0.05, 0.22, 0.03);
    ear.rotateZ(side * 0.16);
    ear.translate(side * 0.05, 0.2, -0.03);
    ear.translate(headHip.x, headHip.y, headHip.z);
    parts.push({ geo: ear, colour: fur, limb: LIMB_HEAD, hip: headHip });
  }

  const tailHip = new Vector3(0, hipY + 0.06, 0.2);
  const tail = new SphereGeometry(0.07, 6, 5);
  tail.translate(tailHip.x, tailHip.y, tailHip.z);
  parts.push({ geo: tail, colour: pale, limb: LIMB_TAIL, hip: tailHip });

  legs(parts, fur, hipY, 0.2, 0.06, 0.09, -0.1, 0.13);
  return assemble(parts);
}

const SPECIES: Species[] = [
  {
    id: 'deer',
    biomes: ['meadow', 'sakura', 'pine', 'jungle'],
    walkSpeed: 1.5,
    runSpeed: 9.5,
    alertRadius: 22,
    gaitRate: 1.9,
    weight: 0.42,
    build: buildDeer,
  },
  {
    id: 'boar',
    biomes: ['jungle', 'wetland', 'savanna'],
    walkSpeed: 1.2,
    runSpeed: 7,
    alertRadius: 15,
    gaitRate: 2.4,
    weight: 0.26,
    build: buildBoar,
  },
  {
    id: 'rabbit',
    biomes: ['meadow', 'savanna', 'beach', 'sakura'],
    walkSpeed: 1.1,
    runSpeed: 6.5,
    alertRadius: 12,
    gaitRate: 4.2,
    weight: 0.32,
    build: buildRabbit,
  },
];

// ---------------------------------------------------------------------------
// Vertex articulation
// ---------------------------------------------------------------------------

/**
 * Swings the legs, dips the head and flicks the tail, all from the instance's own
 * phase and gait. Doing it here rather than with a node per limb is what keeps
 * every animal of a species inside a single draw call.
 */
function injectLimbAnimation(material: MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      `attribute float aLimb;
       attribute vec3 aHip;
       attribute float aPhase;
       attribute float aGait;
       attribute float aGraze;

       // Rotates a point about the X axis through a pivot.
       vec3 swing(vec3 p, vec3 pivot, float angle) {
         vec3 l = p - pivot;
         float c = cos(angle);
         float s = sin(angle);
         return pivot + vec3(l.x, l.y * c - l.z * s, l.y * s + l.z * c);
       }
      ` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           if (aLimb > 0.5 && aLimb < 4.5) {
             // Diagonal pairs move together, which is what a real four-legged
             // gait looks like: front-left with back-right, and vice versa.
             float pairOffset = (aLimb == 1.0 || aLimb == 4.0) ? 0.0 : 3.14159;
             float swingAmt = 0.22 + aGait * 0.55;
             float angle = sin(aPhase + pairOffset) * swingAmt;
             transformed = swing(transformed, aHip, angle);
           } else if (aLimb > 4.5 && aLimb < 5.5) {
             // Head: lowers to the ground while grazing, lifts and steadies at
             // speed so a running animal looks like it is looking where it goes.
             float dip = aGraze * 0.85 - aGait * 0.12;
             float bob = sin(aPhase * 0.5) * 0.05 * (1.0 - aGraze);
             transformed = swing(transformed, aHip, dip + bob);
           } else if (aLimb > 5.5) {
             float flick = sin(aPhase * 2.0) * (0.12 + aGait * 0.3);
             transformed = swing(transformed, aHip, flick);
           } else {
             // Body rises and falls with the stride.
             transformed.y += abs(sin(aPhase)) * 0.045 * aGait;
           }
         }`,
      );
  };
  material.customProgramCacheKey = () => 'wildlife-limbs';
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

type Behaviour = 'graze' | 'wander' | 'flee';

interface Animal {
  species: number;
  slot: number;
  alive: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  behaviour: Behaviour;
  /** Seconds left in the current behaviour. */
  timer: number;
  targetX: number;
  targetZ: number;
  phase: number;
  /** 0 standing still, 1 at a full run. Eased, so gait matches actual speed. */
  gait: number;
  graze: number;
}

export interface WildlifeField {
  group: Group;
  update(dt: number, playerPos: Vector3): void;
  /** Diagnostics: how many animals are currently alive. */
  count(): number;
  dispose(): void;
}

export function createWildlife(density = 1): WildlifeField {
  const group = new Group();
  group.name = 'Wildlife';

  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
    flatShading: true,
  });
  injectLimbAnimation(material);

  const poolSize = Math.max(6, Math.round(POOL_SIZE * density));
  const geometries: BufferGeometry[] = [];
  const meshes: InstancedMesh[] = [];
  const phaseAttrs: InstancedBufferAttribute[] = [];
  const gaitAttrs: InstancedBufferAttribute[] = [];
  const grazeAttrs: InstancedBufferAttribute[] = [];
  /** Per species, how many pool slots it owns. */
  const capacities: number[] = [];

  SPECIES.forEach((species, si) => {
    const cap = Math.max(2, Math.round(poolSize * species.weight));
    capacities[si] = cap;
    const geo = species.build();
    geometries.push(geo);

    const phase = new InstancedBufferAttribute(new Float32Array(cap), 1);
    const gait = new InstancedBufferAttribute(new Float32Array(cap), 1);
    const graze = new InstancedBufferAttribute(new Float32Array(cap), 1);
    // Rewritten every frame, so tell the driver not to treat them as static.
    phase.setUsage(DynamicDrawUsage);
    gait.setUsage(DynamicDrawUsage);
    graze.setUsage(DynamicDrawUsage);
    geo.setAttribute('aPhase', phase);
    geo.setAttribute('aGait', gait);
    geo.setAttribute('aGraze', graze);
    phaseAttrs.push(phase);
    gaitAttrs.push(gait);
    grazeAttrs.push(graze);

    const mesh = new InstancedMesh(geo, material, cap);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    // The instance matrices are rewritten every frame, and a herd spread over
    // 150 m has a huge bounding sphere anyway — culling it costs more than it
    // saves and risks popping the whole species out of view.
    mesh.frustumCulled = false;
    mesh.count = 0;
    group.add(mesh);
    meshes.push(mesh);
  });

  const animals: Animal[] = [];
  for (let si = 0; si < SPECIES.length; si++) {
    for (let slot = 0; slot < capacities[si]!; slot++) {
      animals.push({
        species: si,
        slot,
        alive: false,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        scale: 1,
        behaviour: 'graze',
        timer: 0,
        targetX: 0,
        targetZ: 0,
        phase: Math.random() * Math.PI * 2,
        gait: 0,
        graze: 0,
      });
    }
  }

  const matrix = new Matrix4();
  const quat = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const pos = new Vector3();
  const scl = new Vector3();

  /** Picks a spot in the respawn ring that this species will actually live on. */
  const findSpawn = (species: Species, playerPos: Vector3): { x: number; z: number } | null => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
      const x = playerPos.x + Math.cos(angle) * radius;
      const z = playerPos.z + Math.sin(angle) * radius;
      if (Math.abs(x) > WORLD.halfSize - 60 || Math.abs(z) > WORLD.halfSize - 60) continue;
      const h = surfaceHeightAt(x, z);
      if (h < WORLD.waterLevel + 1) continue;
      if (surfaceSlopeAt(x, z) > 0.5) continue;
      if (!species.biomes.includes(surfaceBiomeAt(x, z))) continue;
      return { x, z };
    }
    return null;
  };

  const pickWanderTarget = (a: Animal): void => {
    const angle = Math.random() * Math.PI * 2;
    const dist = 6 + Math.random() * 18;
    a.targetX = a.x + Math.cos(angle) * dist;
    a.targetZ = a.z + Math.sin(angle) * dist;
  };

  const update = (dt: number, playerPos: Vector3): void => {
    for (const a of animals) {
      const species = SPECIES[a.species]!;

      // ---- Spawn / recycle ------------------------------------------------
      if (a.alive) {
        const dx = a.x - playerPos.x;
        const dz = a.z - playerPos.z;
        if (dx * dx + dz * dz > DESPAWN_RADIUS * DESPAWN_RADIUS) a.alive = false;
      }
      if (!a.alive) {
        // Spread the attempts out: trying every animal every frame would burn
        // biome lookups for nothing when the player stands in the sea.
        if (Math.random() > 0.04) continue;
        const spot = findSpawn(species, playerPos);
        if (!spot) continue;
        a.alive = true;
        a.x = spot.x;
        a.z = spot.z;
        a.y = surfaceHeightAt(a.x, a.z);
        a.yaw = Math.random() * Math.PI * 2;
        a.scale = 0.88 + Math.random() * 0.28;
        a.behaviour = 'graze';
        a.timer = 2 + Math.random() * 6;
        a.gait = 0;
        a.graze = 1;
        pickWanderTarget(a);
      }

      // ---- Behaviour ------------------------------------------------------
      const pdx = playerPos.x - a.x;
      const pdz = playerPos.z - a.z;
      const playerDist = Math.hypot(pdx, pdz);
      const alert = species.alertRadius * a.scale;

      if (playerDist < alert) {
        // Bolt directly away from the player and keep running for a while.
        a.behaviour = 'flee';
        a.timer = Math.max(a.timer, 2.5);
        const len = Math.max(0.001, playerDist);
        a.targetX = a.x - (pdx / len) * 60;
        a.targetZ = a.z - (pdz / len) * 60;
      }

      a.timer -= dt;
      if (a.timer <= 0) {
        if (a.behaviour === 'flee') {
          // Calm down, but stay wary for a moment before settling.
          a.behaviour = 'wander';
          a.timer = 2 + Math.random() * 3;
          pickWanderTarget(a);
        } else if (a.behaviour === 'graze') {
          a.behaviour = 'wander';
          a.timer = 3 + Math.random() * 5;
          pickWanderTarget(a);
        } else {
          a.behaviour = 'graze';
          a.timer = 3 + Math.random() * 7;
        }
      }

      // ---- Movement -------------------------------------------------------
      let speed = 0;
      if (a.behaviour === 'flee') speed = species.runSpeed;
      else if (a.behaviour === 'wander') speed = species.walkSpeed;

      if (speed > 0) {
        const tdx = a.targetX - a.x;
        const tdz = a.targetZ - a.z;
        const tdist = Math.hypot(tdx, tdz);
        if (tdist < 1.2) {
          if (a.behaviour === 'wander') {
            a.behaviour = 'graze';
            a.timer = 2 + Math.random() * 5;
            speed = 0;
          } else {
            pickWanderTarget(a);
          }
        } else {
          const step = Math.min(tdist, speed * dt);
          const nx = a.x + (tdx / tdist) * step;
          const nz = a.z + (tdz / tdist) * step;
          // Refuse to walk into water or up a cliff; pick a new target instead.
          const nh = surfaceHeightAt(nx, nz);
          if (nh < WORLD.waterLevel + 0.6 || surfaceSlopeAt(nx, nz) > 0.75) {
            pickWanderTarget(a);
          } else {
            a.x = nx;
            a.z = nz;
            a.y = nh;
            // Turn toward travel. The models face −Z, same as the player.
            const want = Math.atan2(-tdx, -tdz);
            let d = want - a.yaw;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            a.yaw += d * Math.min(1, dt * 6);
          }
        }
      } else {
        a.y = surfaceHeightAt(a.x, a.z);
      }

      // ---- Animation drivers ---------------------------------------------
      const targetGait = speed > 0 ? Math.min(1, speed / species.runSpeed) : 0;
      a.gait += (targetGait - a.gait) * Math.min(1, dt * 5);
      const targetGraze = a.behaviour === 'graze' ? 1 : 0;
      a.graze += (targetGraze - a.graze) * Math.min(1, dt * 2.5);
      // Stride frequency follows real speed, so the feet do not skate.
      a.phase += dt * species.gaitRate * (1 + a.gait * 3.2);
      if (a.phase > Math.PI * 2) a.phase -= Math.PI * 2;
    }

    // ---- Upload -----------------------------------------------------------
    for (let si = 0; si < SPECIES.length; si++) {
      const mesh = meshes[si]!;
      const phaseArr = phaseAttrs[si]!.array as Float32Array;
      const gaitArr = gaitAttrs[si]!.array as Float32Array;
      const grazeArr = grazeAttrs[si]!.array as Float32Array;
      let written = 0;
      for (const a of animals) {
        if (a.species !== si || !a.alive) continue;
        quat.setFromAxisAngle(up, a.yaw);
        pos.set(a.x, a.y, a.z);
        scl.setScalar(a.scale);
        matrix.compose(pos, quat, scl);
        mesh.setMatrixAt(written, matrix);
        phaseArr[written] = a.phase;
        gaitArr[written] = a.gait;
        grazeArr[written] = a.graze;
        written++;
      }
      mesh.count = written;
      if (written > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        phaseAttrs[si]!.needsUpdate = true;
        gaitAttrs[si]!.needsUpdate = true;
        grazeAttrs[si]!.needsUpdate = true;
      }
    }
  };

  return {
    group,
    update,
    count: () => animals.reduce((n, a) => n + (a.alive ? 1 : 0), 0),
    dispose: () => {
      for (const mesh of meshes) {
        group.remove(mesh);
        mesh.dispose();
      }
      for (const geo of geometries) geo.dispose();
      material.dispose();
    },
  };
}
