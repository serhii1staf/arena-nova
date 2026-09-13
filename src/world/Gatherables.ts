import {
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type BufferGeometry,
} from 'three';
import { itemGeometry, workbenchGeo, type ItemId } from '../game/Items.ts';
import { Carpentry } from './Building.ts';
import { surfaceGroundHeightAt, WORLD } from './WorldGen.ts';

/**
 * Gatherables
 * -----------
 * The sticks, stones, fibre and berries lying about, the dead trees worth felling, and
 * the workbenches scattered across the map.
 *
 * **Nothing is stored.** Every one of these is derived from its own grid cell by a
 * hash, so the world is the same for everybody without a byte of server state and
 * without a spawn list to stream. Walk away and back and the same stick is in the same
 * place, because the answer was never written down — it was computed. That is also what
 * makes it free: there is no list to grow, so a map of any size costs the same as a
 * hundred metres of it.
 *
 * Only what is near the player exists as geometry, rebuilt when they cross a cell
 * boundary rather than every frame, and drawn as one instanced mesh per kind. A
 * thousand sticks in view would be four draw calls; in practice it is a few dozen
 * items and the same four.
 *
 * What *is* recorded is the small set of things this player has taken, so a picked-up
 * stick stays picked up. That set is local, which is the honest limit of this without
 * server-owned world state: another player sees their own copy of the same stick.
 */

/** Metres per gatherable cell. One small item per cell, at most. */
const CELL = 16;
/** How far out items are built. Beyond this they are not in the scene at all. */
const RANGE = 96;
/** Metres per snag cell — dead trees are much rarer than twigs. */
const SNAG_CELL = 72;
const SNAG_RANGE = 190;
/** Metres per workbench cell. Roughly one every 800 m, as asked for. */
const BENCH_CELL = 800;
const BENCH_RANGE = 1700;
/** How close you must be to pick something up or use a bench. */
export const REACH = 3.4;
/** Cap on the remembered-taken set, so a long session cannot grow without bound. */
const TAKEN_CAP = 4000;
const TAKEN_KEY = 'arena.gathered';
const OWN_BENCH_KEY = 'arena.benches';

/** What one spawned thing is. */
export type GatherKind = ItemId | 'snag' | 'bench';

export interface Gatherable {
  key: string;
  kind: GatherKind;
  x: number;
  y: number;
  z: number;
  /** Radians about Y, so a field of sticks does not all point the same way. */
  turn: number;
  /** Which instance draws it. */
  slot: number;
}

export interface GatherSite {
  group: Group;
  /**
   * Rebuilds what is nearby and advances anything falling.
   *
   * The rebuild does nothing until the player crosses a cell boundary; the fall is a
   * handful of transforms. Neither scales with how large the world is.
   */
  update(body: Vector3, dt: number): void;
  /** Pushes a body out of tree trunks and benches. */
  collide(p: Vector3, radius: number): void;
  /**
   * Stands a workbench of the player's own in front of them. False if there is one
   * there already.
   */
  placeBench(x: number, z: number, turn: number): boolean;
  /** The thing in reach that the player is facing, or null. */
  aimed(body: Vector3, forward: Vector3): Gatherable | null;
  /** Removes one, permanently for this player. Snags leave logs where they fell. */
  take(g: Gatherable): void;
  /** True when a workbench is within reach. */
  atBench(body: Vector3): boolean;
  /** How many things are currently built. Diagnostics. */
  count(): number;
  dispose(): void;
}

/**
 * A stable 32-bit hash of two integers.
 *
 * The same mixing the terrain generator uses. It has to be stable across reloads and
 * across machines, which rules out anything seeded from time or from `Math.random`.
 */
function hash2(x: number, z: number, salt: number): number {
  let h = (x * 374761393 + z * 668265263 + salt * 1442695040) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

/** A standing dead tree: a broken trunk with a couple of stubs. */
function snagGeo(): BufferGeometry {
  const c = new Carpentry();
  const n = 7;
  const h = 4.2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // Tapered: the staves lean in as they rise, so the trunk narrows like a tree.
    c.box(Math.cos(a) * 0.26, h * 0.45, Math.sin(a) * 0.26, 0.13, h * 0.45, 0.13);
    c.box(Math.cos(a) * 0.17, h * 0.86, Math.sin(a) * 0.17, 0.1, h * 0.28, 0.1);
  }
  // Two broken limbs and a root flare.
  c.box(0.55, h * 0.72, 0, 0.45, 0.09, 0.09);
  c.box(-0.4, h * 0.55, 0.3, 0.09, 0.08, 0.38);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    c.box(Math.cos(a) * 0.42, 0.12, Math.sin(a) * 0.42, 0.16, 0.12, 0.16);
  }
  return c.finish();
}

export function createGatherSite(): GatherSite {
  const group = new Group();
  group.name = 'Gatherables';

  // One material per family rather than per item: two draws' worth of state change is
  // not worth ten materials, and at these sizes the tint is all that reads.
  const mats = new Map<GatherKind, MeshStandardMaterial>();
  const tint: Record<string, number> = {
    stick: 0x7d5a34,
    stone: 0x8a8e92,
    fibre: 0x9c9560,
    berries: 0x8e2b42,
    log: 0x775230,
    snag: 0x6b5238,
    bench: 0xa87742,
  };

  const kinds: GatherKind[] = ['stick', 'stone', 'fibre', 'berries', 'log', 'snag', 'bench'];
  const caps: Record<string, number> = {
    stick: 96,
    stone: 96,
    fibre: 96,
    berries: 96,
    // Logs only exist where a snag was felled, so a much smaller pool is plenty.
    log: 48,
    snag: 48,
    // Generous, because the range covers several 800 m cells and the player's own
    // benches share the pool with the generated ones.
    bench: 32,
  };

  interface Bucket {
    mesh: InstancedMesh;
    live: Gatherable[];
  }
  const buckets = new Map<GatherKind, Bucket>();
  const geoFor = (kind: GatherKind): BufferGeometry =>
    kind === 'snag' ? snagGeo() : kind === 'bench' ? workbenchGeo() : itemGeometry(kind);
  const owned: BufferGeometry[] = [];
  /** The trunk shape, kept so a falling tree reuses it instead of rebuilding it. */
  let snagShape: BufferGeometry | null = null;

  for (const kind of kinds) {
    const geo = geoFor(kind);
    if (kind === 'snag' || kind === 'bench') owned.push(geo);
    if (kind === 'snag') snagShape = geo;
    const mat = new MeshStandardMaterial({ color: tint[kind], roughness: 0.92, metalness: 0 });
    mats.set(kind, mat);
    const mesh = new InstancedMesh(geo, mat, caps[kind]!);
    mesh.count = 0;
    mesh.castShadow = kind === 'snag' || kind === 'bench';
    mesh.receiveShadow = false;
    // Culling off: the instances are spread over a wide area, and a bounding sphere
    // recomputed on every rebuild would cost more than the handful of draws it saves.
    mesh.frustumCulled = false;
    mesh.name = `Gather:${kind}`;
    group.add(mesh);
    buckets.set(kind, { mesh, live: [] });
  }

  /** Cells this player has emptied. Insertion-ordered, so the oldest can be dropped. */
  const taken = new Set<string>();
  try {
    const raw = localStorage.getItem(TAKEN_KEY);
    if (raw) for (const k of JSON.parse(raw) as string[]) taken.add(String(k));
  } catch {
    /* unreadable — everything is simply back on the ground */
  }
  const remember = (key: string): void => {
    taken.add(key);
    if (taken.size > TAKEN_CAP) {
      // Drop the oldest. Somewhere far behind the player, so it reappearing is both
      // invisible and, for a world this size, the right trade against unbounded growth.
      const first = taken.values().next();
      if (!first.done) taken.delete(first.value);
    }
    try {
      localStorage.setItem(TAKEN_KEY, JSON.stringify([...taken]));
    } catch {
      /* ignore */
    }
  };

  const matrix = new Matrix4();
  /** Cell the last rebuild was centred on, so it only happens on a crossing. */
  let atCell = { x: Number.NaN, z: Number.NaN };
  /** Logs dropped by felled snags, which are ordinary pickups with no cell of origin. */
  const dropped: Gatherable[] = [];
  let dropSeq = 0;

  /**
   * Benches the player put down themselves, kept apart from the ones the map
   * generates: those come out of a hash and cannot be added to, and these have to
   * survive a reload because they cost materials.
   */
  const ownBenches: { x: number; z: number; turn: number }[] = [];
  try {
    const raw = localStorage.getItem(OWN_BENCH_KEY);
    if (raw) {
      for (const b of JSON.parse(raw) as { x: number; z: number; turn: number }[]) {
        const x = Number(b?.x);
        const z = Number(b?.z);
        if (Number.isFinite(x) && Number.isFinite(z)) {
          ownBenches.push({ x, z, turn: Number(b?.turn) || 0 });
        }
      }
    }
  } catch {
    /* unreadable — the player's own benches are simply gone, which is honest */
  }
  const saveOwn = (): void => {
    try {
      localStorage.setItem(OWN_BENCH_KEY, JSON.stringify(ownBenches));
    } catch {
      /* ignore */
    }
  };

  /**
   * Trees in the act of falling.
   *
   * A real mesh each rather than an instance, for the seconds it takes: an instanced
   * transform can express the rotation perfectly well, but the tree also has to leave
   * the pool of standing snags the moment it is cut, and juggling one instance between
   * two meanings is how a tree ends up both fallen and standing. There are never more
   * than a few at once.
   */
  const falling: { mesh: Mesh; t: number; drop: () => void }[] = [];
  const FALL_SECONDS = 1.6;

  /**
   * What lives in one cell, or null.
   *
   * The kind and the offset both come out of the hash, so a cell's contents are fixed
   * for ever. Biome is not consulted deliberately: the point of these is that a player
   * who has just arrived can find something wherever they happen to be standing.
   */
  const inCell = (gx: number, gz: number): { kind: GatherKind; ox: number; oz: number } | null => {
    const roll = hash2(gx, gz, 7717);
    // Just over half of cells hold something, which at 16 m spacing is a scattering
    // rather than a carpet.
    if (roll > 0.55) return null;
    const pick = hash2(gx, gz, 3301);
    const kind: GatherKind =
      pick < 0.42 ? 'stick' : pick < 0.72 ? 'stone' : pick < 0.9 ? 'fibre' : 'berries';
    return {
      kind,
      ox: (hash2(gx, gz, 991) - 0.5) * CELL * 0.8,
      oz: (hash2(gx, gz, 613) - 0.5) * CELL * 0.8,
    };
  };

  const place = (list: Gatherable[], kind: GatherKind, key: string, x: number, z: number, turn: number): void => {
    const y = surfaceGroundHeightAt(x, z);
    // Nothing lies on the bottom of a lake.
    //
    // The cell lottery deliberately ignores biome, so that a player who has just arrived can
    // find something wherever they are standing — but it was ignoring the waterline too, and
    // the ground under a river or a bay is ground as far as the height field is concerned.
    // The result was sticks and stones standing in open water everywhere there was water,
    // which is the report. Half a metre of clearance, so a shingle beach still has its
    // pebbles while a channel does not.
    if (y < WORLD.waterLevel + 0.5) return;
    list.push({ key, kind, x, y, z, turn, slot: 0 });
  };

  const rebuild = (body: Vector3): void => {
    const pending = new Map<GatherKind, Gatherable[]>();
    for (const kind of kinds) pending.set(kind, []);

    // --- Small pickups, on the fine lattice ---
    const cx = Math.round(body.x / CELL);
    const cz = Math.round(body.z / CELL);
    const span = Math.ceil(RANGE / CELL);
    for (let ix = -span; ix <= span; ix++) {
      for (let iz = -span; iz <= span; iz++) {
        const gx = cx + ix;
        const gz = cz + iz;
        const cell = inCell(gx, gz);
        if (!cell) continue;
        const key = `${cell.kind}:${gx}|${gz}`;
        if (taken.has(key)) continue;
        const x = gx * CELL + cell.ox;
        const z = gz * CELL + cell.oz;
        if (Math.hypot(x - body.x, z - body.z) > RANGE) continue;
        place(pending.get(cell.kind)!, cell.kind, key, x, z, hash2(gx, gz, 77) * Math.PI * 2);
      }
    }

    // --- Snags, on their own coarser lattice ---
    const sx = Math.round(body.x / SNAG_CELL);
    const sz = Math.round(body.z / SNAG_CELL);
    const sspan = Math.ceil(SNAG_RANGE / SNAG_CELL);
    for (let ix = -sspan; ix <= sspan; ix++) {
      for (let iz = -sspan; iz <= sspan; iz++) {
        const gx = sx + ix;
        const gz = sz + iz;
        if (hash2(gx, gz, 5171) > 0.4) continue;
        const key = `snag:${gx}|${gz}`;
        if (taken.has(key)) continue;
        const x = gx * SNAG_CELL + (hash2(gx, gz, 131) - 0.5) * SNAG_CELL * 0.7;
        const z = gz * SNAG_CELL + (hash2(gx, gz, 197) - 0.5) * SNAG_CELL * 0.7;
        if (Math.hypot(x - body.x, z - body.z) > SNAG_RANGE) continue;
        place(pending.get('snag')!, 'snag', key, x, z, hash2(gx, gz, 41) * Math.PI * 2);
      }
    }

    // --- Workbenches ---
    const bx = Math.round(body.x / BENCH_CELL);
    const bz = Math.round(body.z / BENCH_CELL);
    const bspan = Math.ceil(BENCH_RANGE / BENCH_CELL);
    for (let ix = -bspan; ix <= bspan; ix++) {
      for (let iz = -bspan; iz <= bspan; iz++) {
        const gx = bx + ix;
        const gz = bz + iz;
        // Every cell has one. A bench you cannot rely on finding is not a landmark,
        // and at 800 m spacing that is one every few minutes of walking.
        const x = gx * BENCH_CELL + (hash2(gx, gz, 233) - 0.5) * BENCH_CELL * 0.55;
        const z = gz * BENCH_CELL + (hash2(gx, gz, 359) - 0.5) * BENCH_CELL * 0.55;
        if (Math.hypot(x - body.x, z - body.z) > BENCH_RANGE) continue;
        place(pending.get('bench')!, 'bench', `bench:${gx}|${gz}`, x, z, hash2(gx, gz, 83) * Math.PI * 2);
      }
    }

    // The player's own benches, wherever they put them — and put at the *front* of the
    // list, because the commit below truncates to the instance cap and a bench somebody
    // paid materials for must never be the one dropped.
    const own: Gatherable[] = [];
    ownBenches.forEach((b, i) => {
      if (Math.hypot(b.x - body.x, b.z - body.z) > BENCH_RANGE) return;
      place(own, 'bench', `own:${i}`, b.x, b.z, b.turn);
    });
    if (own.length > 0) pending.set('bench', [...own, ...pending.get('bench')!]);

    // Logs already on the ground stay wherever they were dropped, so felling a tree
    // and then walking a cell away does not lose the timber.
    for (const d of dropped) {
      if (Math.hypot(d.x - body.x, d.z - body.z) > RANGE) continue;
      pending.get('log')!.push(d);
    }

    // --- Commit ---
    for (const kind of kinds) {
      const bucket = buckets.get(kind)!;
      const list = pending.get(kind)!;
      const cap = caps[kind]!;
      bucket.live = list.length > cap ? list.slice(0, cap) : list;
      for (let i = 0; i < bucket.live.length; i++) {
        const g = bucket.live[i]!;
        g.slot = i;
        matrix.makeRotationY(g.turn);
        matrix.setPosition(g.x, g.y, g.z);
        bucket.mesh.setMatrixAt(i, matrix);
      }
      bucket.mesh.count = bucket.live.length;
      bucket.mesh.instanceMatrix.needsUpdate = true;
    }
  };

  const update = (body: Vector3, dt: number): void => {
    // Anything mid-fall, first: it is a fixed handful of transforms and must advance
    // whether or not the player is moving.
    for (let i = falling.length - 1; i >= 0; i--) {
      const f = falling[i]!;
      f.t += dt;
      const p = Math.min(1, f.t / FALL_SECONDS);
      // Eased in, not linear. A trunk starts by giving way slowly and finishes fast,
      // which is what makes it read as weight rather than as an object being rotated.
      // Quartic in, then a small settle past the horizontal so it lands rather than
      // stopping dead.
      const eased = p * p * p * (2 - p);
      f.mesh.rotation.z = eased * (Math.PI / 2 + 0.06);
      if (p >= 1) {
        f.drop();
        group.remove(f.mesh);
        falling.splice(i, 1);
      }
    }

    const cx = Math.round(body.x / CELL);
    const cz = Math.round(body.z / CELL);
    if (cx === atCell.x && cz === atCell.z) return;
    atCell = { x: cx, z: cz };
    rebuild(body);
  };

  /**
   * Pushes a body out of the things that are actually in the way.
   *
   * Trunks and benches only. Sticks and stones on the ground are deliberately not
   * solid: they are ankle height, and being stopped by a twig is worse than walking
   * over it. Round for a trunk, a box for a bench, because that is what each is.
   */
  const collide = (p: Vector3, radius: number): void => {
    for (const kind of ['snag', 'bench'] as const) {
      for (const g of buckets.get(kind)!.live) {
        // Clear of it vertically? A bench is waist high and can be stood on top of.
        const top = g.y + (kind === 'snag' ? 4.2 : 0.82);
        if (p.y >= top - 0.25) continue;
        const dx = p.x - g.x;
        const dz = p.z - g.z;
        if (kind === 'snag') {
          const minD = 0.5 + radius;
          const d2 = dx * dx + dz * dz;
          if (d2 >= minD * minD) continue;
          if (d2 < 1e-6) {
            // Dead on the trunk's own axis there is no direction to push along, so one
            // is chosen. Rare, but it is exactly the case where being inside the tree
            // matters most — bailing out here is how a body ends up standing in the
            // middle of a trunk with nothing able to move it.
            p.x += minD;
            continue;
          }
          const d = Math.sqrt(d2);
          const push = (minD - d) / d;
          p.x += dx * push;
          p.z += dz * push;
        } else {
          // In the bench's own frame, so a rotated bench is not a rotated bug.
          const c = Math.cos(g.turn);
          const s = Math.sin(g.turn);
          const lx = c * dx - s * dz;
          const lz = s * dx + c * dz;
          const hx = 0.72 + radius;
          const hz = 0.42 + radius;
          const ox = hx - Math.abs(lx);
          const oz = hz - Math.abs(lz);
          if (ox <= 0 || oz <= 0) continue;
          let nx = lx;
          let nz = lz;
          if (oz <= ox) nz += (lz >= 0 ? 1 : -1) * oz;
          else nx += (lx >= 0 ? 1 : -1) * ox;
          p.x = g.x + (c * nx + s * nz);
          p.z = g.z + (-s * nx + c * nz);
        }
      }
    }
  };

  /** Stands a workbench the player made. */
  const placeBench = (x: number, z: number, turn: number): boolean => {
    // Not on top of another one, generated or their own.
    for (const g of buckets.get('bench')!.live) {
      if (Math.hypot(g.x - x, g.z - z) < 2.2) return false;
    }
    ownBenches.push({ x, z, turn });
    saveOwn();
    const bucket = buckets.get('bench')!;
    if (bucket.live.length < caps['bench']!) {
      const g: Gatherable = {
        key: `own:${ownBenches.length - 1}`,
        kind: 'bench',
        x,
        y: surfaceGroundHeightAt(x, z),
        z,
        turn,
        slot: bucket.live.length,
      };
      bucket.live.push(g);
      matrix.makeRotationY(turn);
      matrix.setPosition(g.x, g.y, g.z);
      bucket.mesh.setMatrixAt(g.slot, matrix);
      bucket.mesh.count = bucket.live.length;
      bucket.mesh.instanceMatrix.needsUpdate = true;
    }
    return true;
  };

  /**
   * The thing in reach the player is facing.
   *
   * Facing matters as much as distance: standing between a stick and a bench, the one
   * you are looking at is the one you meant. Scored by how directly it is in front
   * divided by how far away, so a thing dead ahead beats a nearer thing off to the side.
   */
  const aimed = (body: Vector3, forward: Vector3): Gatherable | null => {
    let best: Gatherable | null = null;
    let bestScore = -1;
    for (const kind of kinds) {
      const bucket = buckets.get(kind)!;
      for (const g of bucket.live) {
        const dx = g.x - body.x;
        const dz = g.z - body.z;
        const dist = Math.hypot(dx, dz);
        // A snag and a bench are large, so they are reachable from a little further.
        const limit = kind === 'snag' || kind === 'bench' ? REACH + 1.2 : REACH;
        if (dist > limit) continue;
        if (Math.abs(g.y - body.y) > 3) continue;
        const facing = dist < 0.2 ? 1 : (dx / dist) * forward.x + (dz / dist) * forward.z;
        if (facing < 0.2) continue;
        const score = facing / Math.max(0.5, dist);
        if (score > bestScore) {
          bestScore = score;
          best = g;
        }
      }
    }
    return best;
  };

  /**
   * Whether a bench is within reach.
   *
   * Asks the world, not the draw list. The instanced pool has a cap, and once it is
   * full the next bench simply is not drawn — so a player standing at their own bench
   * was told there was none, because the answer was being read off what happened to
   * fit on screen. Being at a bench is a fact about where things are.
   */
  const atBench = (body: Vector3): boolean => {
    const limit = REACH + 2.4;
    for (const g of buckets.get('bench')!.live) {
      if (Math.hypot(g.x - body.x, g.z - body.z) <= limit) return true;
    }
    for (const b of ownBenches) {
      if (Math.hypot(b.x - body.x, b.z - body.z) <= limit) return true;
    }
    return false;
  };

  const removeFrom = (kind: GatherKind, g: Gatherable): void => {
    const bucket = buckets.get(kind);
    if (!bucket) return;
    const i = bucket.live.indexOf(g);
    if (i < 0) return;
    // Kept dense by moving the last instance into the freed slot, so the draw stays
    // over a contiguous range.
    const last = bucket.live.length - 1;
    if (i !== last) {
      const moved = bucket.live[last]!;
      moved.slot = i;
      bucket.live[i] = moved;
      matrix.makeRotationY(moved.turn);
      matrix.setPosition(moved.x, moved.y, moved.z);
      bucket.mesh.setMatrixAt(i, matrix);
    }
    bucket.live.pop();
    bucket.mesh.count = bucket.live.length;
    bucket.mesh.instanceMatrix.needsUpdate = true;
  };

  const take = (g: Gatherable): void => {
    if (g.kind === 'bench') return; // a bench is used, never carried off
    removeFrom(g.kind, g);
    if (!g.key.startsWith('drop:')) remember(g.key);
    else {
      const i = dropped.indexOf(g);
      if (i >= 0) dropped.splice(i, 1);
    }
    // A felled snag falls, and only then leaves its timber.
    //
    // Two separate things, and the order matters. It stops being a standing tree the
    // instant it is cut — so it cannot be chopped twice, and nothing collides with it
    // any more — while what you *see* is a trunk going over. The logs appear when it
    // lands, because logs that appear while the tree is still upright look like the
    // tree was deleted and replaced.
    if (g.kind === 'snag') {
      const trunk = new Mesh(snagShape ?? geoFor('snag'), mats.get('snag')!);
      trunk.position.set(g.x, g.y, g.z);
      trunk.rotation.y = g.turn;
      trunk.castShadow = true;
      group.add(trunk);
      falling.push({ mesh: trunk, t: 0, drop: () => dropLogs(g) });
    }
  };

  /** Puts three logs on the ground where a tree came down. */
  const dropLogs = (g: Gatherable): void => {
    const bucket = buckets.get('log')!;
    for (let i = 0; i < 3; i++) {
      // Along the direction it fell rather than in a ring, so the timber lies where
      // the trunk did.
      const a = g.turn + Math.PI / 2;
      const along = 1.1 + i * 1.15;
      const x = g.x + Math.cos(a) * along;
      const z = g.z + Math.sin(a) * along;
      const log: Gatherable = {
        key: `drop:${dropSeq++}`,
        kind: 'log',
        x,
        y: surfaceGroundHeightAt(x, z),
        z,
        turn: a,
        slot: 0,
      };
      dropped.push(log);
      if (bucket.live.length < caps['log']!) {
        log.slot = bucket.live.length;
        bucket.live.push(log);
        matrix.makeRotationY(log.turn);
        matrix.setPosition(log.x, log.y, log.z);
        bucket.mesh.setMatrixAt(log.slot, matrix);
        bucket.mesh.count = bucket.live.length;
        bucket.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  };

  return {
    group,
    update,
    collide,
    placeBench,
    aimed,
    take,
    atBench,
    count: () => {
      let n = 0;
      for (const b of buckets.values()) n += b.live.length;
      return n;
    },
    dispose: () => {
      for (const f of falling) group.remove(f.mesh);
      falling.length = 0;
      for (const b of buckets.values()) b.mesh.dispose();
      for (const m of mats.values()) m.dispose();
      // Only the shapes this module made. The item geometries are shared with the
      // inventory icons and outlive any one scene.
      for (const g of owned) g.dispose();
      group.removeFromParent();
    },
  };
}
