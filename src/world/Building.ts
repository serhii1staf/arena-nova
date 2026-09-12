import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  Vector3,
} from 'three';
import type { AssetManager } from '../core/AssetManager.ts';

/**
 * Building
 * --------
 * Snap-to-grid construction, in the shape players already know from Fortnite and
 * Rust: pick a piece, look where you want it, place. Six pieces, a translucent
 * preview that shows exactly what will appear, rotation in quarter turns, and no
 * materials to gather — this is an admin tool, not an economy.
 *
 * Everything is built around one decision: a single global lattice. Positions snap
 * to it rather than to the piece you happen to be looking at, which is what makes
 * two walls placed minutes apart line up perfectly without any of the
 * edge-detection a "snap to neighbour" system needs. It also means the grid is the
 * same for every piece and every player, so nothing has to be negotiated.
 *
 * The pieces are *carpentry*, not blocks: a wall is six boards between two posts, a
 * floor is boards over joists, a ramp is treads on stringers. Modelling the boards
 * rather than painting them on costs a few dozen triangles a piece and buys the
 * silhouette — light falls through the gaps, the edges are thin where thin timber is
 * thin, and the shape reads as built from the outside as well as head on.
 *
 * All of it is generated from one primitive, `box`, which emits its faces with the
 * winding that makes them face outwards. That is not incidental tidiness: the
 * hand-rolled ramp and roof shapes this replaced were wound inside out, so their
 * outer faces were back-faces, got culled, and the pieces looked transparent and
 * unlit from the only side you ever see them from.
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
/** Thickness of a single board. */
const BOARD = 0.12;
/** Thickness of a frame member — post, joist, stringer. */
const POST = 0.2;
/** Height of the roof ridge above its cell floor. */
const RIDGE = BUILD_GRID * 0.55;
/** Walkable height of a floor and of a foundation, above their cell floor. */
const FLOOR_TOP = 0.3;
const FOUNDATION_TOP = 0.42;
/** How many metres of timber one tile of the wood texture covers. */
const UV_METRES = 1.15;

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
   * floor stand on, and a ramp and a roof walkable.
   */
  heightAt(x: number, z: number, ground: number): number;
  /**
   * Pushes a body of the given radius out of any wall or pillar it is inside.
   * Call after the world's own collision, which clamps and handles terrain.
   */
  collide(p: Vector3, radius: number): void;
  /** True if a wall or pillar occupies this point, for camera pull-in. */
  blocksCamera(x: number, y: number, z: number): boolean;
  /** The geometries, so the hotbar can draw an icon of each. */
  geometryFor(kind: PieceKind): BufferGeometry;
  dispose(): void;
}

// --- Geometry -----------------------------------------------------------------

/**
 * Accumulates boxes into one geometry.
 *
 * Faces are emitted wound counter-clockwise as seen from outside, so
 * `computeVertexNormals` is never needed and a piece can never come out inside
 * out. UVs put the texture's V axis across the timber and U along it: for every
 * face, U follows whichever of its two tangents is longer, which on a board is
 * always its length. That one rule is why the grain runs the right way on a wall
 * board, a floor board and a ramp tread from a single tile.
 */
class Carpentry {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly uv: number[] = [];

  /**
   * One board. Half-extents are half its width, height and depth; `tilt` rotates
   * it about X, which is how treads lie on a slope.
   */
  box(
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    tilt = 0,
  ): Carpentry {
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    // Three's rotation about X: y' = y cos - z sin, z' = y sin + z cos.
    const place = (x: number, y: number, z: number): [number, number, number] => [
      cx + x,
      cy + (y * ct - z * st),
      cz + (y * st + z * ct),
    ];
    const dir = (x: number, y: number, z: number): [number, number, number] => [
      x,
      y * ct - z * st,
      y * st + z * ct,
    ];

    // Each face: its outward normal, its four corners in outward-CCW order, and
    // the extents of its two tangents so U can follow the longer one.
    const faces: {
      n: [number, number, number];
      c: [number, number, number][];
      su: number;
      sv: number;
    }[] = [
      {
        n: [1, 0, 0],
        c: [
          [hx, -hy, hz],
          [hx, -hy, -hz],
          [hx, hy, -hz],
          [hx, hy, hz],
        ],
        su: hz * 2,
        sv: hy * 2,
      },
      {
        n: [-1, 0, 0],
        c: [
          [-hx, -hy, -hz],
          [-hx, -hy, hz],
          [-hx, hy, hz],
          [-hx, hy, -hz],
        ],
        su: hz * 2,
        sv: hy * 2,
      },
      {
        n: [0, 1, 0],
        c: [
          [-hx, hy, hz],
          [hx, hy, hz],
          [hx, hy, -hz],
          [-hx, hy, -hz],
        ],
        su: hx * 2,
        sv: hz * 2,
      },
      {
        n: [0, -1, 0],
        c: [
          [-hx, -hy, -hz],
          [hx, -hy, -hz],
          [hx, -hy, hz],
          [-hx, -hy, hz],
        ],
        su: hx * 2,
        sv: hz * 2,
      },
      {
        n: [0, 0, 1],
        c: [
          [-hx, -hy, hz],
          [hx, -hy, hz],
          [hx, hy, hz],
          [-hx, hy, hz],
        ],
        su: hx * 2,
        sv: hy * 2,
      },
      {
        n: [0, 0, -1],
        c: [
          [hx, -hy, -hz],
          [-hx, -hy, -hz],
          [-hx, hy, -hz],
          [hx, hy, -hz],
        ],
        su: hx * 2,
        sv: hy * 2,
      },
    ];

    for (const f of faces) {
      const n = dir(f.n[0], f.n[1], f.n[2]);
      // The quad's corners run around its edge, so corner 1 is one tangent away
      // from corner 0 and corner 3 is the other. Which of those is the long one
      // decides whether the grain runs across the quad or up it.
      const flip = f.sv > f.su;
      const [uMax, vMax] = flip ? [f.sv, f.su] : [f.su, f.sv];
      const uvs: [number, number][] = flip
        ? [
            [0, 0],
            [0, vMax / UV_METRES],
            [uMax / UV_METRES, vMax / UV_METRES],
            [uMax / UV_METRES, 0],
          ]
        : [
            [0, 0],
            [uMax / UV_METRES, 0],
            [uMax / UV_METRES, vMax / UV_METRES],
            [0, vMax / UV_METRES],
          ];
      const p = f.c.map((c) => place(c[0], c[1], c[2]));
      // Quad as two triangles, keeping the winding.
      for (const [a, b, c] of [
        [0, 1, 2],
        [0, 2, 3],
      ]) {
        for (const i of [a, b, c]) {
          this.pos.push(p[i]![0], p[i]![1], p[i]![2]);
          this.nrm.push(n[0], n[1], n[2]);
          this.uv.push(uvs[i]![0], uvs[i]![1]);
        }
      }
    }
    return this;
  }

  finish(): BufferGeometry {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}

/**
 * Every piece is modelled with its underside on y = 0, which is the floor of its
 * cell — so a placed piece needs no vertical fudge factor at all. Getting that
 * wrong per shape is what previously left some pieces hovering and others sunk.
 */
function buildGeometries(): Record<PieceKind, BufferGeometry> {
  const G = BUILD_GRID;
  const s = G / 2;

  // --- Wall: six boards between two posts ---
  const wall = new Carpentry();
  const wallBoards = 6;
  for (let i = 0; i < wallBoards; i++) {
    const pitch = G / wallBoards;
    wall.box(0, (i + 0.5) * pitch, 0, s, pitch / 2 - 0.035, BOARD / 2);
  }
  wall.box(-(s - POST / 2), G / 2, 0, POST / 2, G / 2, POST / 2);
  wall.box(s - POST / 2, G / 2, 0, POST / 2, G / 2, POST / 2);

  // --- Floor: boards across joists ---
  // Joists run along Z, boards along X on top of them, so the grain crosses the
  // frame the way floorboards actually do.
  const floor = new Carpentry();
  const joistH = (FLOOR_TOP - BOARD) / 2;
  floor.box(-(s - 0.5), joistH, 0, POST / 2, joistH, s);
  floor.box(s - 0.5, joistH, 0, POST / 2, joistH, s);
  const floorBoards = 6;
  for (let i = 0; i < floorBoards; i++) {
    const pitch = G / floorBoards;
    floor.box(0, FLOOR_TOP - BOARD / 2, -s + (i + 0.5) * pitch, s, BOARD / 2, pitch / 2 - 0.03);
  }

  // --- Foundation: the same, heavier, on four stub posts ---
  const foundation = new Carpentry();
  for (const px of [-(s - 0.45), s - 0.45]) {
    for (const pz of [-(s - 0.45), s - 0.45]) {
      // Sunk into the ground, which is what a foundation is for.
      foundation.box(px, -0.3, pz, 0.16, 0.35, 0.16);
    }
  }
  const fJoist = (FOUNDATION_TOP - 0.18) / 2;
  for (const pz of [-(s - 0.45), 0, s - 0.45]) {
    foundation.box(0, fJoist, pz, s, fJoist, POST / 2);
  }
  for (let i = 0; i < 5; i++) {
    const pitch = G / 5;
    foundation.box(
      -s + (i + 0.5) * pitch,
      FOUNDATION_TOP - 0.09,
      0,
      pitch / 2 - 0.035,
      0.09,
      s,
    );
  }

  // --- Ramp: treads on two stringers, rising along +Z ---
  const ramp = new Carpentry();
  const rampLen = Math.hypot(G, G);
  // A tread's own +Z has to point up the slope. Three's X rotation sends (0,0,1)
  // to (0,-sin a, cos a), so the angle is negative to make it rise.
  const rampTilt = -Math.PI / 4;
  const up = Math.SQRT1_2; // sin/cos of 45 degrees
  for (const sx of [-(s - 0.12), s - 0.12]) {
    ramp.box(sx, G / 2, 0, POST / 2, 0.13, rampLen / 2, rampTilt);
  }
  const treads = 8;
  for (let i = 0; i < treads; i++) {
    const t = -rampLen / 2 + (i + 0.5) * (rampLen / treads);
    ramp.box(
      0,
      G / 2 + t * up + 0.1,
      t * up,
      s,
      BOARD / 2,
      rampLen / treads / 2 - 0.03,
      rampTilt,
    );
  }

  // --- Roof: a gable, two sheets to a ridge running along X ---
  const roof = new Carpentry();
  const slope = Math.hypot(RIDGE, s);
  const pitchAngle = Math.atan2(RIDGE, s);
  for (const side of [1, -1]) {
    // Sheet from (0, 0, side*s) up to (0, RIDGE, 0): midpoint and direction.
    const mx = 0;
    const my = RIDGE / 2;
    const mz = (side * s) / 2;
    const dy = -RIDGE / slope;
    const dz = (side * s) / slope;
    const sheets = 4;
    for (let i = 0; i < sheets; i++) {
      const t = -slope / 2 + (i + 0.5) * (slope / sheets);
      roof.box(
        mx,
        my + t * dy,
        mz + t * dz,
        s,
        BOARD / 2,
        slope / sheets / 2 - 0.025,
        side * pitchAngle,
      );
    }
  }
  roof.box(0, RIDGE - 0.08, 0, s, 0.09, 0.11);

  // --- Pillar: one post ---
  const pillar = new Carpentry()
    .box(0, G / 2, 0, 0.15, G / 2, 0.15)
    // A collar top and bottom, so it does not read as a bare stick.
    .box(0, 0.09, 0, 0.22, 0.09, 0.22)
    .box(0, G - 0.09, 0, 0.22, 0.09, 0.22);

  return {
    wall: wall.finish(),
    floor: floor.finish(),
    ramp: ramp.finish(),
    roof: roof.finish(),
    pillar: pillar.finish(),
    foundation: foundation.finish(),
  };
}

// --- The site -----------------------------------------------------------------

export function createBuildSite(assets: AssetManager): BuildSite {
  const group = new Group();
  group.name = 'Building';

  // Real timber, tiled per metre rather than per face, so a wall and a floor built
  // side by side are cut from visibly the same wood.
  const tex = assets.plank(1);
  for (const t of [tex.map, tex.normalMap, tex.roughnessMap]) {
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
  }
  const solid = new MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    roughnessMap: tex.roughnessMap,
    roughness: 1,
    metalness: 0,
  });

  const ghostOk = new MeshStandardMaterial({
    color: 0x5af08c,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    emissive: 0x18663a,
  });
  const ghostBad = new MeshStandardMaterial({
    color: 0xf05a4a,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    emissive: 0x66180f,
  });

  const G = BUILD_GRID;
  const geometries = buildGeometries();

  const placed = new Map<string, Placed>();
  /**
   * Pieces grouped by the grid column they stand in, so asking how high the floor
   * is at a point costs one map lookup rather than a walk over everything built.
   */
  const columns = new Map<string, Placed[]>();
  const colKey = (gx: number, gz: number): string => `${gx}|${gz}`;
  const columnOf = (x: number, z: number): string => colKey(Math.round(x / G), Math.round(z / G));

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

    // The tier comes from *how far you looked up*, and the base from the terrain
    // under the target. Measuring the aim height against the ground instead mixed
    // the two together: eye height is about 1.7 m, so looking straight ahead
    // already read as most of a tier, and whether it tipped over depended on how
    // the ground happened to fall away in front of you. Pieces landed flush on
    // level ground and a tier up on a slope, from the same gesture.
    const ground = floorAt(at.x, at.z);
    const step = G / 2;
    const tier = Math.max(0, Math.floor((at.y - eye.y) / step));
    at.y = ground + tier * step;

    ghost.geometry = geometries[selected];
    ghost.position.copy(at);
    ghost.rotation.set(0, (quarter * Math.PI) / 2, 0);

    free = !placed.has(cellKey(selected, at, quarter));
    ghost.material = free ? ghostOk : ghostBad;
    ghost.visible = true;
  };

  const place = (): boolean => {
    if (!active || !free) return false;
    const key = cellKey(selected, at, quarter);
    if (placed.has(key)) return false;

    const mesh = new Mesh(geometries[selected], solid);
    mesh.position.copy(at);
    mesh.rotation.set(0, (quarter * Math.PI) / 2, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    const entry: Placed = { mesh, kind: selected, key, level: at.y, turn: quarter };
    placed.set(key, entry);
    const col = columnOf(at.x, at.z);
    const bucket = columns.get(col);
    if (bucket) bucket.push(entry);
    else columns.set(col, [entry]);
    return true;
  };

  /** Turns a world point into a piece's own frame, undoing its quarter turn. */
  const toLocal = (p: Placed, x: number, z: number): [number, number] => {
    const dx = x - p.mesh.position.x;
    const dz = z - p.mesh.position.z;
    const ang = (p.turn * Math.PI) / 2;
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    return [c * dx - sn * dz, sn * dx + c * dz];
  };

  /**
   * The walkable surface of one piece at a point, or `null` if that point is not
   * over it.
   *
   * Worked out from the piece's own cell and rotation rather than looked up in the
   * world's collider registry. The registry holds circles with one flat top each,
   * which is the right shape for a tree trunk, the wrong shape for a floor slab and
   * hopeless for a slope: it reports the highest top containing the point, so a
   * slope approximated by overlapping circles collapses into a flat block.
   */
  const surfaceAt = (p: Placed, x: number, z: number): number | null => {
    const s = G / 2;
    const [lx, lz] = toLocal(p, x, z);
    if (Math.abs(lx) > s || Math.abs(lz) > s) return null;
    switch (p.kind) {
      case 'floor':
        return p.level + FLOOR_TOP;
      case 'foundation':
        return p.level + FOUNDATION_TOP;
      case 'ramp':
        // The treads follow the plane that is level with the floor at the low edge
        // and a full cell up at the high one.
        return p.level + Math.max(0, Math.min(G, lz + s));
      case 'roof':
        // A gable: highest along the ridge at lz = 0, down to nothing at the eaves.
        return p.level + Math.max(0, RIDGE * (1 - Math.abs(lz) / s));
      default:
        return null; // walls and pillars are not floors
    }
  };

  const heightAt = (x: number, z: number, ground: number): number => {
    if (placed.size === 0) return ground;
    const list = columns.get(columnOf(x, z));
    if (!list) return ground;
    let h = ground;
    for (const p of list) {
      const surface = surfaceAt(p, x, z);
      if (surface !== null && surface > h) h = surface;
    }
    return h;
  };

  /**
   * Half-extents of the part of a piece that a body cannot walk through, or `null`
   * if it has none. Only the upright pieces block; floors, ramps and roofs are
   * things you stand on, and giving them sides too would trap you on top of them.
   */
  const blockerHalf = (kind: PieceKind): [number, number] | null => {
    if (kind === 'wall') return [G / 2, POST / 2];
    if (kind === 'pillar') return [0.22, 0.22];
    return null;
  };

  /**
   * Pushes a body out of the walls and pillars it overlaps.
   *
   * Box against box, in each piece's own frame — not the circle the collider
   * registry would have used. A wall is four metres wide and a fifth of a metre
   * thick; describing it with a circle big enough to cover its width stops the
   * player two metres short of it in every direction, which is exactly what it
   * used to do.
   *
   * The body is treated as a square of its radius. At a flat face — which is where
   * a body meets a wall essentially always — that is exact; at an outside corner it
   * is up to a few centimetres generous, and paying for a true distance test there
   * is not worth a square root per piece per frame.
   */
  const collide = (p: Vector3, radius: number): void => {
    if (placed.size === 0) return;
    const gx = Math.round(p.x / G);
    const gz = Math.round(p.z / G);
    // A piece in a neighbouring cell can still reach across the boundary, so the
    // ring around the body's own cell has to be considered too.
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const list = columns.get(colKey(gx + ix, gz + iz));
        if (!list) continue;
        for (const piece of list) {
          const half = blockerHalf(piece.kind);
          if (!half) continue;
          // Vertically clear of it? Then there is nothing to push against. The
          // half-metre of slack at the top is what lets you stand on a wall's top
          // edge instead of being shoved off it.
          if (p.y >= piece.level + G - 0.1 || p.y + 1.7 <= piece.level) continue;

          const ang = (piece.turn * Math.PI) / 2;
          const c = Math.cos(ang);
          const sn = Math.sin(ang);
          const dx = p.x - piece.mesh.position.x;
          const dz = p.z - piece.mesh.position.z;
          const lx = c * dx - sn * dz;
          const lz = sn * dx + c * dz;

          const ox = half[0] + radius - Math.abs(lx);
          const oz = half[1] + radius - Math.abs(lz);
          if (ox <= 0 || oz <= 0) continue;

          // Out along whichever axis needs moving least, so a body walking into a
          // wall is stopped by it rather than squirted along it.
          let nx = lx;
          let nz = lz;
          if (oz <= ox) nz += (lz >= 0 ? 1 : -1) * oz;
          else nx += (lx >= 0 ? 1 : -1) * ox;

          // Back to world. Inverse of the rotation above.
          p.x = piece.mesh.position.x + (c * nx + sn * nz);
          p.z = piece.mesh.position.z + (-sn * nx + c * nz);
        }
      }
    }
  };

  const blocksCamera = (x: number, y: number, z: number): boolean => {
    if (placed.size === 0) return false;
    const gx = Math.round(x / G);
    const gz = Math.round(z / G);
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const list = columns.get(colKey(gx + ix, gz + iz));
        if (!list) continue;
        for (const piece of list) {
          const half = blockerHalf(piece.kind);
          if (!half) continue;
          if (y < piece.level || y > piece.level + G) continue;
          const [lx, lz] = toLocal(piece, x, z);
          if (Math.abs(lx) <= half[0] && Math.abs(lz) <= half[1] + 0.15) return true;
        }
      }
    }
    return false;
  };

  /** Takes a piece out of its column bucket, dropping the bucket once empty. */
  const unbucket = (p: Placed): void => {
    const col = columnOf(p.mesh.position.x, p.mesh.position.z);
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
    unbucket(best);
    placed.delete(best.key);
    return true;
  };

  const clear = (): void => {
    for (const p of placed.values()) group.remove(p.mesh);
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
    collide,
    blocksCamera,
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
