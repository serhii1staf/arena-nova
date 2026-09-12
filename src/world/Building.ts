import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import type { AssetManager } from '../core/AssetManager.ts';
import type { PropRegistry } from './PropRegistry.ts';

/**
 * Building
 * --------
 * Snap-to-grid construction, in the shape players already know from Fortnite and
 * Rust: pick a piece, look where you want it, place. Six pieces, a translucent
 * preview that shows exactly what will appear, free rotation in quarter turns, and
 * no materials to gather — this is an admin tool, not an economy.
 *
 * Everything is built around one decision: a single global lattice. Positions snap
 * to it rather than to the piece you happen to be looking at, which is what makes
 * two walls placed minutes apart line up perfectly without any of the
 * edge-detection a "snap to neighbour" system needs. It also means the grid is the
 * same for every piece and every player, so nothing has to be negotiated.
 *
 * Geometry is shared per kind and materials are shared across all of them, so a
 * hundred placed pieces is a hundred draw calls of one material — and the whole
 * structure is one `Group` that can be hidden or thrown away in one move.
 *
 * Placements are local to the player who made them. Making them visible to the room
 * would need authoritative world state on the server: somewhere to store them,
 * ownership, a limit, and a rule for what happens when two people build into the
 * same cell. That is a different feature, and pretending otherwise by relaying
 * placements peer-to-peer would produce structures that disagree between clients.
 */

/** Metres per lattice cell. A wall is this wide and this tall. */
export const BUILD_GRID = 4;
/** How far in front of the player a piece is placed. */
const REACH = 7;
/** Thickness of a wall or a floor slab. */
const SLAB = 0.28;

export type PieceKind = 'wall' | 'floor' | 'ramp' | 'roof' | 'pillar' | 'foundation';

/** Order in the hotbar. Also the order the number keys select. */
export const PIECES: readonly PieceKind[] = [
  'wall',
  'floor',
  'ramp',
  'roof',
  'pillar',
  'foundation',
];

interface Placed {
  mesh: Mesh;
  kind: PieceKind;
  key: string;
  /** World height of the cell floor this piece stands on. */
  level: number;
  /** Quarter turns about Y, as placed. */
  turn: number;
}

/**
 * How far a piece's own origin sits above the floor of its cell, so that its
 * underside lands flush on that floor.
 *
 * Box geometries are centred on their origin, so they need half their height;
 * the hand-built ramp starts at `-t` and the pyramid at 0.
 */
function baseOffset(kind: PieceKind): number {
  switch (kind) {
    case 'wall':
    case 'pillar':
      return BUILD_GRID / 2;
    case 'floor':
      return SLAB / 2;
    case 'foundation':
      return (SLAB * 3) / 2;
    // The wedge's sloped face starts at its own origin and its underside hangs
    // `t` below. Zero, so the walkable face begins level with the cell floor and
    // you can step straight onto it; the buried underside is never seen.
    case 'ramp':
      return 0;
    case 'roof':
      return 0;
  }
}

export interface BuildSite {
  group: Group;
  /** True while the player is holding a piece and the preview is showing. */
  readonly active: boolean;
  setActive(on: boolean): void;
  select(kind: PieceKind): void;
  readonly selected: PieceKind;
  /** Quarter turn. */
  rotate(): void;
  /** Places the previewed piece. Returns false when the cell is already taken. */
  place(): boolean;
  /** Removes the piece nearest to where the player is aiming. */
  removeAimed(): boolean;
  /** How many pieces are standing. */
  count(): number;
  /** Clears everything this player built. */
  clear(): void;
  /**
   * Moves the preview. Call once per frame with the eye position and view
   * direction; cheap, and does nothing at all while inactive.
   */
  update(eye: Vector3, forward: Vector3, floorAt: (x: number, z: number) => number): void;
  /**
   * Floor height at a point, taking placed pieces into account. Given the height
   * the world reports there, returns whichever is higher. This is what makes a
   * floor stand on and a ramp walkable — the collider registry cannot express
   * either shape.
   */
  heightAt(x: number, z: number, ground: number): number;
  /** The geometries, so the hotbar can draw an icon of each. */
  geometryFor(kind: PieceKind): BufferGeometry;
  dispose(): void;
}

/**
 * A wedge: a box with its top face sloped away along +Z.
 *
 * Built by hand rather than from a rotated box because a ramp has to fill its cell
 * exactly — a rotated box leaves triangular gaps at the sides that you can see
 * through and walk into, and the collision box would no longer match the shape.
 */
function rampGeometry(size: number, thickness: number): BufferGeometry {
  const h = size;
  const s = size / 2;
  const t = thickness;
  // Two triangular sides, a sloped top, a back wall and a floor.
  const v: number[] = [];
  const push = (...pts: number[]): void => {
    v.push(...pts);
  };
  // Sloped top surface.
  push(-s, 0, -s, s, 0, -s, s, h, s);
  push(-s, 0, -s, s, h, s, -s, h, s);
  // Underside, parallel to the slope and `t` below it.
  push(-s, -t, -s, s, h - t, s, s, -t, -s);
  push(-s, -t, -s, -s, h - t, s, s, h - t, s);
  // Back face at +Z.
  push(-s, h - t, s, s, h - t, s, s, h, s);
  push(-s, h - t, s, s, h, s, -s, h, s);
  // Front edge at -Z.
  push(-s, -t, -s, s, 0, -s, s, -t, -s);
  push(-s, -t, -s, -s, 0, -s, s, 0, -s);
  // Left and right triangles.
  push(-s, 0, -s, -s, h, s, -s, h - t, s);
  push(-s, 0, -s, -s, h - t, s, -s, -t, -s);
  push(s, 0, -s, s, h - t, s, s, h, s);
  push(s, 0, -s, s, -t, -s, s, h - t, s);

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

/** A four-sided pyramid filling its cell, for roofs. */
function roofGeometry(size: number, height: number): BufferGeometry {
  const s = size / 2;
  const v = [
    -s, 0, -s, s, 0, -s, 0, height, 0,
    s, 0, -s, s, 0, s, 0, height, 0,
    s, 0, s, -s, 0, s, 0, height, 0,
    -s, 0, s, -s, 0, -s, 0, height, 0,
    // Underside, so it is not see-through from below.
    -s, 0, -s, -s, 0, s, s, 0, s,
    -s, 0, -s, s, 0, s, s, 0, -s,
  ];
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

export function createBuildSite(assets: AssetManager, registry: PropRegistry): BuildSite {
  const group = new Group();
  group.name = 'Building';

  // One material for everything placed, and one for the preview. Timber-coloured
  // rather than grey: a structure has to read as built rather than as terrain, and
  // the stone maps carry the grain regardless of the tint.
  const tex = assets.stone(1);
  const solid = new MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    roughnessMap: tex.roughnessMap,
    color: new Color(0.62, 0.46, 0.3),
    roughness: 0.92,
    metalness: 0,
  });

  const ghostOk = new MeshStandardMaterial({
    color: new Color(0.35, 0.95, 0.55),
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    emissive: new Color(0.1, 0.4, 0.2),
  });
  const ghostBad = new MeshStandardMaterial({
    color: new Color(0.95, 0.35, 0.3),
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    emissive: new Color(0.4, 0.08, 0.06),
  });

  const G = BUILD_GRID;
  const geometries: Record<PieceKind, BufferGeometry> = {
    wall: new BoxGeometry(G, G, SLAB),
    floor: new BoxGeometry(G, SLAB, G),
    ramp: rampGeometry(G, SLAB * 1.6),
    roof: roofGeometry(G, G * 0.55),
    pillar: new BoxGeometry(SLAB * 2.2, G, SLAB * 2.2),
    foundation: new BoxGeometry(G, SLAB * 3, G),
  };

  const placed = new Map<string, Placed>();
  /**
   * Pieces grouped by the grid column they stand in, so asking how high the floor
   * is at a point costs one map lookup rather than a walk over everything built.
   */
  const columns = new Map<string, Placed[]>();
  const columnKey = (x: number, z: number): string =>
    `${Math.round(x / G)}|${Math.round(z / G)}`;
  let selected: PieceKind = 'wall';
  let quarter = 0;
  let active = false;

  const ghost = new Mesh(geometries.wall, ghostOk);
  ghost.visible = false;
  // Never casts or receives: it is a hint, not an object in the world.
  ghost.castShadow = false;
  ghost.receiveShadow = false;
  group.add(ghost);

  /** Where the preview currently sits, and whether that cell is free. */
  const at = new Vector3();
  let free = true;

  /**
   * A cell's identity.
   *
   * Rotation is part of it for walls and ramps but not for the rest: two walls at
   * right angles in the same cell is a corner and entirely reasonable, while two
   * floors in the same cell is the same floor twice.
   */
  const cellKey = (kind: PieceKind, p: Vector3, turn: number): string => {
    const gx = Math.round(p.x / G);
    const gy = Math.round(p.y / (G / 2));
    const gz = Math.round(p.z / G);
    const facing = kind === 'wall' || kind === 'ramp' ? turn % 4 : 0;
    return `${kind}:${gx}|${gy}|${gz}|${facing}`;
  };

  const update = (
    eye: Vector3,
    forward: Vector3,
    floorAt: (x: number, z: number) => number,
  ): void => {
    if (!active) {
      ghost.visible = false;
      return;
    }

    // The target is a fixed distance ahead, then snapped. Deliberately not a
    // raycast against the world: a ray gives a surface, and what a grid system
    // needs is a *cell* — snapping the aim point is both cheaper and steadier,
    // because the preview stops jittering between two cells as the crosshair
    // crosses an edge of some distant hillside.
    at.copy(eye).addScaledVector(forward, REACH);
    at.x = Math.round(at.x / G) * G;
    at.z = Math.round(at.z / G) * G;

    // Vertical snap is relative to the ground under the target, so a structure
    // follows the terrain instead of floating off it on a slope. Half-cell steps,
    // which is what lets a wall sit on a floor and a floor cap a wall.
    //
    // The tier comes from *how far you looked up*, and the base from the terrain
    // under the target. Measuring the aim height against the ground instead mixed
    // the two together: eye height is about 1.7 m, so looking straight ahead
    // already read as most of a tier, and whether it tipped over depended on how
    // the ground happened to fall away in front of you. Pieces landed flush on
    // level ground and a tier up on a slope, from the same gesture.
    //
    // Taking the rise from the view direction alone makes it predictable: level
    // gaze is always tier 0 and always flush, and it takes a deliberate look
    // upwards — about 17 degrees — to move up a tier. Floored, so tier 0 holds
    // across the whole range where the player is plainly looking straight ahead.
    const ground = floorAt(at.x, at.z);
    const step = G / 2;
    const tier = Math.max(0, Math.floor((at.y - eye.y) / step));
    at.y = ground + tier * step;

    ghost.geometry = geometries[selected];
    ghost.position.copy(at);
    ghost.rotation.set(0, (quarter * Math.PI) / 2, 0);
    ghost.position.y += baseOffset(selected);

    free = !placed.has(cellKey(selected, at, quarter));
    ghost.material = free ? ghostOk : ghostBad;
    ghost.visible = true;
  };

  const place = (): boolean => {
    if (!active || !free) return false;
    const key = cellKey(selected, at, quarter);
    if (placed.has(key)) return false;

    const mesh = new Mesh(geometries[selected], solid);
    mesh.position.copy(ghost.position);
    mesh.rotation.copy(ghost.rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    const entry: Placed = { mesh, kind: selected, key, level: at.y, turn: quarter };
    placed.set(key, entry);
    const col = columnKey(at.x, at.z);
    const bucket = columns.get(col);
    if (bucket) bucket.push(entry);
    else columns.set(col, [entry]);

    // Only the upright pieces go into the collider registry, and only to *block*.
    //
    // The registry holds circles with one flat top each, which is the right shape
    // for a tree trunk and the wrong shape for a floor — and hopeless for a ramp,
    // where every point along the slope is at a different height. Standing is
    // handled by `heightAt` instead, which knows each piece's exact cell and can
    // work the surface out properly. The inscribed radius, not the outscribed one:
    // outscribed would stop you a metre short of every wall.
    if (selected === 'wall' || selected === 'pillar') {
      registry.add(`build:${key}`, {
        x: mesh.position.x,
        z: mesh.position.z,
        r: selected === 'pillar' ? 0.4 : G * 0.5,
        top: at.y,
        blockTop: at.y + G,
        solid: true,
      });
    }
    return true;
  };

  /**
   * The walkable surface of one piece at a point, or `null` if that point is not
   * over it — or if the piece is not something you stand on.
   */
  const surfaceAt = (p: Placed, x: number, z: number): number | null => {
    const s = G / 2;
    const dx = x - p.mesh.position.x;
    const dz = z - p.mesh.position.z;
    if (p.kind === 'floor' || p.kind === 'foundation') {
      if (Math.abs(dx) > s || Math.abs(dz) > s) return null;
      return p.level + (p.kind === 'floor' ? SLAB : SLAB * 3);
    }
    if (p.kind !== 'ramp') return null; // walls, pillars and pyramids are not floors
    // Undo the piece's own rotation, so the slope can be measured in the frame the
    // geometry was built in — where it always rises along +Z, from 0 to one cell.
    const ang = (p.turn * Math.PI) / 2;
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    const lx = c * dx - sn * dz;
    const lz = sn * dx + c * dz;
    if (Math.abs(lx) > s || Math.abs(lz) > s) return null;
    return p.level + Math.max(0, Math.min(G, lz + s));
  };

  /**
   * Floor height at a point, given the height the world already reports there.
   * One map lookup: pieces are bucketed by grid column, so this does not care how
   * much has been built, and it returns `ground` untouched when nothing has.
   */
  const heightAt = (x: number, z: number, ground: number): number => {
    if (placed.size === 0) return ground;
    const list = columns.get(columnKey(x, z));
    if (!list) return ground;
    let h = ground;
    for (const p of list) {
      const surface = surfaceAt(p, x, z);
      if (surface !== null && surface > h) h = surface;
    }
    return h;
  };

  /** Takes a piece out of its column bucket, dropping the bucket once empty. */
  const unbucket = (p: Placed): void => {
    const col = columnKey(p.mesh.position.x, p.mesh.position.z);
    const bucket = columns.get(col);
    if (!bucket) return;
    const i = bucket.indexOf(p);
    if (i >= 0) bucket.splice(i, 1);
    if (bucket.length === 0) columns.delete(col);
  };

  const removeAimed = (): boolean => {
    if (placed.size === 0) return false;
    // Nearest to the preview, which is where the player is looking. Simpler and
    // steadier than a ray: it removes the thing under the marker you can already
    // see, so there is never a question of what will go.
    let best: Placed | null = null;
    let bestD = Infinity;
    for (const p of placed.values()) {
      const d = p.mesh.position.distanceToSquared(at);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best || bestD > (G * 1.6) ** 2) return false;
    group.remove(best.mesh);
    registry.removeOwner(`build:${best.key}`);
    unbucket(best);
    placed.delete(best.key);
    return true;
  };

  const clear = (): void => {
    for (const p of placed.values()) {
      group.remove(p.mesh);
      registry.removeOwner(`build:${p.key}`);
    }
    placed.clear();
    columns.clear();
  };

  return {
    group,
    get active() {
      return active;
    },
    setActive: (on) => {
      active = on;
      if (!on) ghost.visible = false;
    },
    select: (kind) => {
      selected = kind;
    },
    get selected() {
      return selected;
    },
    rotate: () => {
      quarter = (quarter + 1) % 4;
    },
    place,
    removeAimed,
    count: () => placed.size,
    clear,
    update,
    heightAt,
    geometryFor: (kind) => geometries[kind],
    dispose: () => {
      clear();
      for (const g of Object.values(geometries)) g.dispose();
      solid.dispose();
      ghostOk.dispose();
      ghostBad.dispose();
      group.removeFromParent();
    },
  };
}
