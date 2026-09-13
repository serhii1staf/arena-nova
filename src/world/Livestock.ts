import {
  BufferAttribute,
  BufferGeometry,
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { surfaceGroundHeightAt } from './WorldGen.ts';
import type { VillageInfo, VillageStreamer } from './Village.ts';

/**
 * Livestock
 * ---------
 * The animals that belong to a settlement: hens, sheep, cows.
 *
 * Deliberately *not* added to `Wildlife.ts`, even though that file's species table is generic
 * enough to accept them and would have given instancing and limb animation for free. Its
 * population is a pool that follows the player and respawns on a ring around them — which is
 * right for a fox and wrong for a hen, because it cannot keep an animal in a paddock. A
 * village's animals have to stay in the village whether anybody is watching or not.
 *
 * One instanced mesh per species for the whole world, reassigned to whichever settlement the
 * player is in, exactly as the villagers are. Three species, three draw calls, however many
 * villages exist.
 */

type Kind = 'hen' | 'sheep' | 'cow';

interface Species {
  kind: Kind;
  /** How many of this animal a settlement keeps. */
  count: number;
  /** Metres per second when it bothers.  */
  speed: number;
  /** How far from its own patch it strays. */
  range: number;
  build(): BufferGeometry;
}

/**
 * Flat-shaded boxes and spheres, merged and vertex-coloured, in the same idiom as the
 * wildlife and the flora. No skinning and no shader work: at the size these are drawn a
 * bobbing body and a swinging head read as movement perfectly well, and the whole point of
 * this file is that a farmyard costs three draw calls.
 */
function part(geo: BufferGeometry, c: Color): BufferGeometry {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new BufferAttribute(arr, 3));
  return geo.index ? geo.toNonIndexed() : geo;
}

function merge(parts: BufferGeometry[]): BufferGeometry {
  const out = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!out) throw new Error('Livestock: merge failed');
  out.computeVertexNormals();
  return out;
}

function buildHen(): BufferGeometry {
  const body = new Color(0.92, 0.9, 0.86);
  const comb = new Color(0.82, 0.24, 0.18);
  const beak = new Color(0.9, 0.72, 0.2);
  const parts: BufferGeometry[] = [];
  const b = new SphereGeometry(0.16, 7, 5);
  b.scale(1, 0.9, 1.3);
  b.translate(0, 0.24, 0);
  parts.push(part(b, body));
  const head = new SphereGeometry(0.09, 6, 4);
  head.translate(0, 0.38, -0.16);
  parts.push(part(head, body));
  const c = new BoxGeometry(0.03, 0.06, 0.07);
  c.translate(0, 0.46, -0.16);
  parts.push(part(c, comb));
  const bk = new BoxGeometry(0.04, 0.03, 0.06);
  bk.translate(0, 0.37, -0.25);
  parts.push(part(bk, beak));
  const tail = new BoxGeometry(0.1, 0.11, 0.04);
  tail.translate(0, 0.3, 0.18);
  parts.push(part(tail, body));
  for (const sx of [-0.06, 0.06]) {
    const leg = new BoxGeometry(0.025, 0.14, 0.025);
    leg.translate(sx, 0.07, 0.02);
    parts.push(part(leg, beak));
  }
  return merge(parts);
}

function buildSheep(): BufferGeometry {
  const wool = new Color(0.9, 0.88, 0.84);
  const face = new Color(0.24, 0.22, 0.21);
  const parts: BufferGeometry[] = [];
  const b = new SphereGeometry(0.36, 7, 5);
  b.scale(1, 0.92, 1.35);
  b.translate(0, 0.56, 0);
  parts.push(part(b, wool));
  const head = new BoxGeometry(0.2, 0.2, 0.24);
  head.translate(0, 0.6, -0.5);
  parts.push(part(head, face));
  for (const [sx, sz] of [
    [-0.18, -0.26],
    [0.18, -0.26],
    [-0.18, 0.26],
    [0.18, 0.26],
  ]) {
    const leg = new BoxGeometry(0.08, 0.3, 0.08);
    leg.translate(sx, 0.15, sz);
    parts.push(part(leg, face));
  }
  return merge(parts);
}

function buildCow(): BufferGeometry {
  const hide = new Color(0.36, 0.28, 0.24);
  const patch = new Color(0.88, 0.86, 0.82);
  const horn = new Color(0.85, 0.82, 0.7);
  const parts: BufferGeometry[] = [];
  const b = new BoxGeometry(0.62, 0.6, 1.24);
  b.translate(0, 0.88, 0);
  parts.push(part(b, hide));
  const flank = new BoxGeometry(0.64, 0.26, 0.5);
  flank.translate(0, 0.86, 0.16);
  parts.push(part(flank, patch));
  const head = new BoxGeometry(0.34, 0.32, 0.4);
  head.translate(0, 0.92, -0.8);
  parts.push(part(head, hide));
  const muzzle = new BoxGeometry(0.24, 0.18, 0.12);
  muzzle.translate(0, 0.84, -1.0);
  parts.push(part(muzzle, patch));
  for (const sx of [-0.16, 0.16]) {
    const h = new BoxGeometry(0.07, 0.07, 0.14);
    h.translate(sx, 1.1, -0.74);
    parts.push(part(h, horn));
  }
  for (const [sx, sz] of [
    [-0.24, -0.44],
    [0.24, -0.44],
    [-0.24, 0.44],
    [0.24, 0.44],
  ]) {
    const leg = new BoxGeometry(0.14, 0.58, 0.14);
    leg.translate(sx, 0.29, sz);
    parts.push(part(leg, hide));
  }
  const tail = new BoxGeometry(0.06, 0.5, 0.06);
  tail.translate(0, 0.8, 0.66);
  parts.push(part(tail, hide));
  return merge(parts);
}

const SPECIES: readonly Species[] = [
  { kind: 'hen', count: 6, speed: 0.5, range: 4, build: buildHen },
  { kind: 'sheep', count: 4, speed: 0.4, range: 7, build: buildSheep },
  { kind: 'cow', count: 2, speed: 0.3, range: 8, build: buildCow },
];

interface Animal {
  x: number;
  z: number;
  y: number;
  yaw: number;
  /** The patch it keeps to. */
  hx: number;
  hz: number;
  /** Where it is heading; null while it stands. */
  tx: number | null;
  tz: number;
  /** Seconds until it moves again. */
  wait: number;
  bob: number;
}

export interface LivestockHerd {
  group: Group;
  update(dt: number, playerPos: Vector3, villages: VillageStreamer): void;
  count(): number;
  dispose(): void;
}

/** Beyond this a settlement's animals are not worth simulating. */
const ACTIVE_RANGE = 190;

export function createLivestock(): LivestockHerd {
  const group = new Group();
  group.name = 'Livestock';

  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    flatShading: true,
  });

  const herds = SPECIES.map((spec) => {
    const geo = spec.build();
    const mesh = new InstancedMesh(geo, material, spec.count);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.name = `Livestock:${spec.kind}`;
    group.add(mesh);
    const animals: Animal[] = Array.from({ length: spec.count }, () => ({
      x: 0,
      z: 0,
      y: 0,
      yaw: 0,
      hx: 0,
      hz: 0,
      tx: null,
      tz: 0,
      wait: 0,
      bob: Math.random() * 6.28,
    }));
    return { spec, geo, mesh, animals };
  });

  let current: VillageInfo | null = null;
  const matrix = new Matrix4();
  const quat = new Quaternion();
  const pos = new Vector3();
  const one = new Vector3(1, 1, 1);
  const up = new Vector3(0, 1, 0);

  /**
   * Puts the herds in a settlement.
   *
   * Each species gets one patch per village, offset from the centre, so hens are together in
   * a yard and cows are together in a field rather than one of each standing beside every
   * house. Deterministic in the village's own coordinates, so the yard is in the same place
   * every time you come back.
   */
  const assign = (info: VillageInfo | null): void => {
    current = info;
    for (let s = 0; s < herds.length; s++) {
      const herd = herds[s]!;
      if (!info) {
        herd.mesh.count = 0;
        continue;
      }
      // Patches sit outside the built-up middle but well inside the levelled pad.
      const a = (s / herds.length) * Math.PI * 2 + 0.6;
      const rad = Math.min(info.radius * 0.55, 26);
      const px = info.x + Math.cos(a) * rad;
      const pz = info.z + Math.sin(a) * rad;
      for (let i = 0; i < herd.animals.length; i++) {
        const an = herd.animals[i]!;
        const ang = (i / herd.animals.length) * Math.PI * 2;
        an.hx = px;
        an.hz = pz;
        an.x = px + Math.cos(ang) * herd.spec.range * 0.5;
        an.z = pz + Math.sin(ang) * herd.spec.range * 0.5;
        an.y = surfaceGroundHeightAt(an.x, an.z);
        an.yaw = ang;
        an.tx = null;
        an.wait = 1 + i;
      }
      herd.mesh.count = herd.animals.length;
    }
  };

  const update = (dt: number, playerPos: Vector3, villages: VillageStreamer): void => {
    const info = villages.nearest(playerPos);
    const inRange =
      info !== null &&
      (info.x - playerPos.x) ** 2 + (info.z - playerPos.z) ** 2 < ACTIVE_RANGE * ACTIVE_RANGE;
    const want = inRange ? info : null;
    if ((want?.key ?? null) !== (current?.key ?? null)) assign(want);
    if (!current) return;

    for (const herd of herds) {
      const { spec, mesh, animals } = herd;
      for (let i = 0; i < animals.length; i++) {
        const an = animals[i]!;
        if (an.tx === null) {
          an.wait -= dt;
          if (an.wait <= 0) {
            // Somewhere else in its own patch. A pure random walk drifts away over time;
            // picking a point relative to the patch centre cannot.
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * spec.range;
            an.tx = an.hx + Math.cos(a) * r;
            an.tz = an.hz + Math.sin(a) * r;
          }
        } else {
          const dx = an.tx - an.x;
          const dz = an.tz - an.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.25) {
            an.tx = null;
            an.wait = 1.5 + Math.random() * 5;
          } else {
            const stepLen = Math.min(d, spec.speed * dt);
            an.x += (dx / d) * stepLen;
            an.z += (dz / d) * stepLen;
            an.y = surfaceGroundHeightAt(an.x, an.z);
            const wantYaw = Math.atan2(-dx, -dz);
            let turn = wantYaw - an.yaw;
            while (turn > Math.PI) turn -= Math.PI * 2;
            while (turn < -Math.PI) turn += Math.PI * 2;
            an.yaw += turn * Math.min(1, dt * 4);
            an.bob += dt * 9;
          }
        }
        // A gentle bob while walking stands in for legs. Cheap and, at the size an animal is
        // actually drawn, indistinguishable from articulation.
        const lift = an.tx === null ? 0 : Math.abs(Math.sin(an.bob)) * 0.045;
        pos.set(an.x, an.y + lift, an.z);
        quat.setFromAxisAngle(up, an.yaw);
        matrix.compose(pos, quat, one);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  };

  const dispose = (): void => {
    for (const herd of herds) {
      herd.mesh.dispose();
      herd.geo.dispose();
    }
    material.dispose();
    herds.length = 0;
    current = null;
  };

  return {
    group,
    update,
    count: () => (current ? herds.reduce((n, h) => n + h.mesh.count, 0) : 0),
    dispose,
  };
}
