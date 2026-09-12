import {
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Vector3,
  type BufferGeometry,
} from 'three';
import { itemGeometry, workbenchGeo, type ItemId } from '../game/Items.ts';
import { Carpentry } from './Building.ts';
import { surfaceGroundHeightAt } from './WorldGen.ts';

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
  /** Rebuilds what is nearby. Cheap, and does nothing until a cell is crossed. */
  update(body: Vector3): void;
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
    bench: 12,
  };

  interface Bucket {
    mesh: InstancedMesh;
    live: Gatherable[];
  }
  const buckets = new Map<GatherKind, Bucket>();
  const geoFor = (kind: GatherKind): BufferGeometry =>
    kind === 'snag' ? snagGeo() : kind === 'bench' ? workbenchGeo() : itemGeometry(kind);
  const owned: BufferGeometry[] = [];

  for (const kind of kinds) {
    const geo = geoFor(kind);
    if (kind === 'snag' || kind === 'bench') owned.push(geo);
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

  const update = (body: Vector3): void => {
    const cx = Math.round(body.x / CELL);
    const cz = Math.round(body.z / CELL);
    if (cx === atCell.x && cz === atCell.z) return;
    atCell = { x: cx, z: cz };
    rebuild(body);
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

  const atBench = (body: Vector3): boolean => {
    for (const g of buckets.get('bench')!.live) {
      if (Math.hypot(g.x - body.x, g.z - body.z) <= REACH + 2.4) return true;
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
    // A felled snag leaves its timber on the ground rather than teleporting it into
    // the bag: you fell it, then you carry the logs, which is both the obvious
    // behaviour and what makes an axe worth having before a big inventory.
    if (g.kind === 'snag') {
      const bucket = buckets.get('log')!;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + g.turn;
        const x = g.x + Math.cos(a) * 1.1;
        const z = g.z + Math.sin(a) * 1.1;
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
    }
  };

  return {
    group,
    update,
    aimed,
    take,
    atBench,
    count: () => {
      let n = 0;
      for (const b of buckets.values()) n += b.live.length;
      return n;
    },
    dispose: () => {
      for (const b of buckets.values()) b.mesh.dispose();
      for (const m of mats.values()) m.dispose();
      // Only the shapes this module made. The item geometries are shared with the
      // inventory icons and outlive any one scene.
      for (const g of owned) g.dispose();
      group.removeFromParent();
    },
  };
}
