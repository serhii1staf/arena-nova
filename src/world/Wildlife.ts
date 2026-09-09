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

export type SpeciesId = 'moose' | 'boar' | 'rabbit' | 'fox';

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

/**
 * Moose. The silhouette is what makes it readable at distance, so the three
 * things that say "moose" rather than "deer" are all exaggerated: a high
 * shoulder hump, a long drooping muzzle, and broad palmate antlers.
 * Faces −Z, like the player character.
 */
function buildMoose(): BufferGeometry {
  const parts: Part[] = [];
  const coat = new Color(0.2, 0.14, 0.1);
  const flank = new Color(0.27, 0.19, 0.13);
  const legPale = new Color(0.42, 0.34, 0.26);
  const bone = new Color(0.58, 0.52, 0.4);
  const origin = new Vector3();

  const hipY = 1.25;
  // Barrel body, deepest at the chest.
  parts.push({ geo: box(0.62, 0.68, 1.5, 0, hipY + 0.16, 0), colour: coat, limb: LIMB_BODY, hip: origin });
  parts.push({ geo: box(0.56, 0.3, 1.1, 0, hipY - 0.1, 0.05), colour: flank, limb: LIMB_BODY, hip: origin });
  // Shoulder hump — the signature line.
  parts.push({ geo: box(0.5, 0.3, 0.62, 0, hipY + 0.54, -0.34), colour: coat, limb: LIMB_BODY, hip: origin });

  // Neck and head pivot at the shoulder, so grazing swings the whole neck down.
  const neckHip = new Vector3(0, hipY + 0.5, -0.66);
  const neck = new BoxGeometry(0.32, 0.62, 0.34);
  neck.translate(0, 0.26, -0.08);
  neck.rotateX(-0.22);
  neck.translate(neckHip.x, neckHip.y, neckHip.z);
  parts.push({ geo: neck, colour: coat, limb: LIMB_HEAD, hip: neckHip });
  // Long muzzle, angled down — a moose carries its nose low.
  const skull = new BoxGeometry(0.26, 0.26, 0.36);
  skull.translate(0, 0.56, -0.24);
  skull.translate(neckHip.x, neckHip.y, neckHip.z);
  parts.push({ geo: skull, colour: coat, limb: LIMB_HEAD, hip: neckHip });
  const muzzle = new BoxGeometry(0.2, 0.24, 0.34);
  muzzle.rotateX(0.3);
  muzzle.translate(0, 0.42, -0.52);
  muzzle.translate(neckHip.x, neckHip.y, neckHip.z);
  parts.push({ geo: muzzle, colour: flank, limb: LIMB_HEAD, hip: neckHip });
  // Dewlap under the throat.
  const bell = new BoxGeometry(0.14, 0.26, 0.12);
  bell.translate(0, 0.24, -0.34);
  bell.translate(neckHip.x, neckHip.y, neckHip.z);
  parts.push({ geo: bell, colour: coat, limb: LIMB_HEAD, hip: neckHip });

  for (const side of [-1, 1]) {
    const ear = new ConeGeometry(0.07, 0.22, 5);
    ear.rotateZ(side * 0.9);
    ear.translate(side * 0.2, 0.66, -0.16);
    ear.translate(neckHip.x, neckHip.y, neckHip.z);
    parts.push({ geo: ear, colour: coat, limb: LIMB_HEAD, hip: neckHip });

    // Palmate antler: a flat blade with prongs along its outer edge.
    const palm = new BoxGeometry(0.42, 0.08, 0.34);
    palm.rotateZ(side * 0.3);
    palm.translate(side * 0.34, 0.82, -0.14);
    palm.translate(neckHip.x, neckHip.y, neckHip.z);
    parts.push({ geo: palm, colour: bone, limb: LIMB_HEAD, hip: neckHip });
    for (let i = 0; i < 3; i++) {
      const prong = new BoxGeometry(0.05, 0.16, 0.05);
      prong.translate(side * (0.42 + i * 0.05), 0.94, -0.26 + i * 0.16);
      prong.translate(neckHip.x, neckHip.y, neckHip.z);
      parts.push({ geo: prong, colour: bone, limb: LIMB_HEAD, hip: neckHip });
    }
  }

  const tailHip = new Vector3(0, hipY + 0.34, 0.76);
  const tail = new BoxGeometry(0.1, 0.18, 0.08);
  tail.translate(0, -0.08, 0.03);
  tail.translate(tailHip.x, tailHip.y, tailHip.z);
  parts.push({ geo: tail, colour: flank, limb: LIMB_TAIL, hip: tailHip });

  legs(parts, legPale, hipY, 1.2, 0.13, 0.22, -0.56, 0.58);
  return assemble(parts);
}

/** Fox: small, low, bright orange, with a tail nearly as long as its body. */
function buildFox(): BufferGeometry {
  const parts: Part[] = [];
  const fur = new Color(0.72, 0.31, 0.08);
  const pale = new Color(0.9, 0.86, 0.8);
  const dark = new Color(0.12, 0.09, 0.08);
  const origin = new Vector3();

  const hipY = 0.4;
  parts.push({ geo: box(0.26, 0.26, 0.66, 0, hipY + 0.04, 0), colour: fur, limb: LIMB_BODY, hip: origin });
  parts.push({ geo: box(0.22, 0.12, 0.5, 0, hipY - 0.08, 0.02), colour: pale, limb: LIMB_BODY, hip: origin });

  const headHip = new Vector3(0, hipY + 0.14, -0.3);
  const head = new BoxGeometry(0.22, 0.2, 0.24);
  head.translate(0, 0.06, -0.06);
  head.translate(headHip.x, headHip.y, headHip.z);
  parts.push({ geo: head, colour: fur, limb: LIMB_HEAD, hip: headHip });
  const snout = new BoxGeometry(0.11, 0.1, 0.18);
  snout.translate(0, 0.02, -0.24);
  snout.translate(headHip.x, headHip.y, headHip.z);
  parts.push({ geo: snout, colour: pale, limb: LIMB_HEAD, hip: headHip });
  // Nose tip, and the eyes he asked about.
  const nose = new BoxGeometry(0.06, 0.05, 0.05);
  nose.translate(0, 0.02, -0.34);
  nose.translate(headHip.x, headHip.y, headHip.z);
  parts.push({ geo: nose, colour: dark, limb: LIMB_HEAD, hip: headHip });
  for (const side of [-1, 1]) {
    const eye = new BoxGeometry(0.035, 0.035, 0.025);
    eye.translate(side * 0.075, 0.1, -0.16);
    eye.translate(headHip.x, headHip.y, headHip.z);
    parts.push({ geo: eye, colour: dark, limb: LIMB_HEAD, hip: headHip });

    const ear = new ConeGeometry(0.055, 0.16, 4);
    ear.translate(side * 0.08, 0.22, -0.02);
    ear.translate(headHip.x, headHip.y, headHip.z);
    parts.push({ geo: ear, colour: fur, limb: LIMB_HEAD, hip: headHip });
  }

  // Big bushy tail with a white tip, angled up and back.
  const tailHip = new Vector3(0, hipY + 0.08, 0.32);
  const brush = new BoxGeometry(0.16, 0.16, 0.44);
  brush.rotateX(-0.35);
  brush.translate(0, 0.06, 0.22);
  brush.translate(tailHip.x, tailHip.y, tailHip.z);
  parts.push({ geo: brush, colour: fur, limb: LIMB_TAIL, hip: tailHip });
  const tip = new BoxGeometry(0.13, 0.13, 0.14);
  tip.translate(0, 0.19, 0.45);
  tip.translate(tailHip.x, tailHip.y, tailHip.z);
  parts.push({ geo: tip, colour: pale, limb: LIMB_TAIL, hip: tailHip });

  legs(parts, dark, hipY, 0.36, 0.07, 0.11, -0.2, 0.22);
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
    id: 'moose',
    biomes: ['meadow', 'sakura', 'pine', 'jungle'],
    walkSpeed: 1.3,
    runSpeed: 8.5,
    // Big and confident: it lets you get closer than the smaller animals do.
    alertRadius: 18,
    gaitRate: 1.6,
    weight: 0.3,
    build: buildMoose,
  },
  {
    id: 'boar',
    biomes: ['jungle', 'wetland', 'savanna'],
    walkSpeed: 1.2,
    runSpeed: 7,
    alertRadius: 15,
    gaitRate: 2.4,
    weight: 0.2,
    build: buildBoar,
  },
  {
    id: 'rabbit',
    biomes: ['meadow', 'savanna', 'beach', 'sakura'],
    walkSpeed: 1.1,
    runSpeed: 6.5,
    alertRadius: 12,
    gaitRate: 4.2,
    weight: 0.26,
    build: buildRabbit,
  },
  {
    id: 'fox',
    biomes: ['meadow', 'sakura', 'pine', 'savanna'],
    walkSpeed: 1.6,
    runSpeed: 8,
    alertRadius: 14,
    gaitRate: 3.4,
    weight: 0.24,
    build: buildFox,
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
             // Scaled entirely by gait: a standing animal must have still legs.
             // A constant base term made every idle animal look like it was
             // walking on the spot.
             float swingAmt = aGait * 0.62;
             float angle = sin(aPhase + pairOffset) * swingAmt;
             // A trace of weight-shifting while standing, an order of magnitude
             // smaller than a stride.
             angle += sin(aPhase * 0.35 + pairOffset) * 0.022 * (1.0 - aGait);
             transformed = swing(transformed, aHip, angle);
           } else if (aLimb > 4.5 && aLimb < 5.5) {
             // Head. The swing helper rotates about +X, which lifts a point that
             // sits forward of the pivot — so grazing needs a NEGATIVE angle to
             // put the muzzle on the ground. Getting this sign wrong had the
             // animals staring at the sky while supposedly eating.
             float dip = -aGraze * 0.95 + aGait * 0.12;
             // Cropping at the grass while grazing, a slow scan while alert.
             float chew = sin(aPhase * 2.6) * 0.06 * aGraze;
             float scan = sin(aPhase * 0.4) * 0.05 * (1.0 - aGraze) * (1.0 - aGait);
             transformed = swing(transformed, aHip, dip + chew + scan);
           } else if (aLimb > 5.5) {
             // Tail flicks, and keeps flicking while standing — it is the main
             // sign of life on an animal that is otherwise still.
             float flick = sin(aPhase * 2.0) * (0.14 + aGait * 0.3);
             transformed = swing(transformed, aHip, flick);
           } else {
             // Body rises and falls with the stride, plus a faint breath at rest.
             transformed.y += abs(sin(aPhase)) * 0.045 * aGait;
             transformed.y += sin(aPhase * 0.3) * 0.012 * (1.0 - aGait);
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
