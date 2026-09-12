import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
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
 * Rust: pick a piece, look where you want it, place. Ten pieces, a translucent
 * preview of exactly what will appear, and no materials to gather — this is an
 * admin tool, not an economy.
 *
 * Three ideas carry the whole thing.
 *
 * **One global lattice, with three kinds of slot.** Floors, ramps, stairs, roofs
 * and foundations fill a *cell*; walls, doorways, windows and railings stand on a
 * cell *edge*; pillars stand at a *corner*. That is not decoration — it is what
 * makes a building assemble. When walls sat in the middle of cells, four walls
 * around one floor tile was impossible: they landed in four different squares. On
 * edges, four walls enclose exactly one floor, and the pillars at its corners line
 * up with all of them. The edge is also chosen by which side of the cell you are
 * looking at, so a wall goes where you are pointing without any fiddling.
 *
 * **Pieces are carpentry, not blocks.** A wall is boards between posts, a floor is
 * boards over joists, a doorway has jambs and a lintel. Modelling the boards costs
 * a few dozen triangles and buys the silhouette: light falls through the gaps and
 * thin timber is thin from the side. Everything is generated from one primitive
 * that emits faces already wound outwards, which is not tidiness — the hand-written
 * ramp and roof this replaced were wound inside out, so their outer faces were
 * culled and the pieces looked transparent.
 *
 * **Cost does not grow with what you build.** Each kind is one `InstancedMesh`, so
 * a thousand pieces is ten draw calls rather than a thousand. Collision and floor
 * height are analytic — worked out from a piece's own cell and rotation — and
 * bucketed by grid column, so a query costs a map lookup rather than a search.
 * There is a hard cap per kind, because an admin holding the mouse down should run
 * out of pieces long before the frame budget does.
 *
 * Placements are local to the player who made them. Making them visible to the room
 * would need authoritative world state on the server: somewhere to store them,
 * ownership, a limit, and a rule for what happens when two people build into the
 * same cell. Relaying placements peer-to-peer instead would produce structures that
 * disagree between clients.
 */

/** Metres per lattice cell. A wall is this wide and this tall. */
export const BUILD_GRID = 4;
/** How far in front of the player a piece is placed. */
const REACH = 7;
/** How far the aim ray looks for a piece to remove. */
const PICK_RANGE = 11;
/** Thickness of a single board. */
const BOARD = 0.12;
/** Thickness of a frame member — post, joist, stringer, jamb. */
const POST = 0.2;
/** Height of the roof ridge above its cell floor. */
const RIDGE = BUILD_GRID * 0.55;
/** Walkable height of a floor and of a foundation, above their cell floor. */
const FLOOR_TOP = 0.3;
const FOUNDATION_TOP = 0.42;
/** Doorway opening: half width, and height to the underside of the lintel. */
const DOOR_HALF = 0.85;
const DOOR_HEAD = 2.6;
/** Window opening: half width, sill height and head height. */
const WIN_HALF = 1.15;
const WIN_SILL = 1.1;
const WIN_HEAD = 2.45;
/** Railing height. */
const RAIL_TOP = 1.1;
/** Steps in a flight of stairs. */
const STEPS = 8;
/** How many metres of timber one tile of the wood texture covers. */
const UV_METRES = 1.15;
/**
 * Hard cap per kind.
 *
 * Not a licence to grow: an `InstancedMesh` reserves its whole matrix buffer up
 * front, so this is 256 pieces of each of ten kinds, about 160 kB of matrices and
 * ten draw calls no matter how full it gets. Beyond this the answer is server-owned
 * world state, not a bigger buffer.
 */
const MAX_PER_KIND = 256;

export type PieceKind =
  | 'wall'
  | 'doorway'
  | 'window'
  | 'floor'
  | 'ramp'
  | 'stairs'
  | 'roof'
  | 'pillar'
  | 'railing'
  | 'foundation';

/** Order in the hotbar. Also the order the number keys select. */
export const PIECES: readonly PieceKind[] = [
  'wall',
  'doorway',
  'window',
  'floor',
  'ramp',
  'stairs',
  'roof',
  'pillar',
  'railing',
  'foundation',
];

/**
 * Which slot of the lattice a piece occupies.
 *
 * `cell` fills a square, `edge` stands on the boundary between two squares, and
 * `corner` stands where four squares meet.
 */
type Lattice = 'cell' | 'edge' | 'corner';

const LATTICE: Record<PieceKind, Lattice> = {
  wall: 'edge',
  doorway: 'edge',
  window: 'edge',
  railing: 'edge',
  floor: 'cell',
  ramp: 'cell',
  stairs: 'cell',
  roof: 'cell',
  foundation: 'cell',
  pillar: 'corner',
};

/** A box in a piece's own frame: centre and half-extents across, and a Y range. */
interface Slab {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  y0: number;
  y1: number;
}

interface Placed {
  kind: PieceKind;
  key: string;
  /** Centre of the piece on the lattice. */
  x: number;
  z: number;
  /** World height of the floor of the slot this piece stands on. */
  level: number;
  /** Quarter turns about Y, as placed. */
  turn: number;
  /** Which instance of its kind's mesh draws it. Moves when others are removed. */
  slot: number;
}

export interface BuildSite {
  group: Group;
  /** True while the player is holding a piece and the preview is showing. */
  readonly active: boolean;
  setActive(on: boolean): void;
  select(kind: PieceKind): void;
  readonly selected: PieceKind;
  /** Steps the selection by `n` places, for the mouse wheel. */
  cycle(n: number): void;
  /** Quarter turn: rotates cell pieces, and moves edge pieces to the next side. */
  rotate(): void;
  /** Places the previewed piece. False if the slot is taken or the kind is full. */
  place(): boolean;
  /** The piece under the crosshair, described for the HUD, or null. */
  aimedKind(): PieceKind | null;
  /** Removes the single piece under the crosshair. */
  removeAimed(): boolean;
  /** How many pieces are standing. */
  count(): number;
  /** Clears everything this player built. */
  clear(): void;
  /**
   * Moves the preview and works out what is under the crosshair. Call once per
   * frame; does nothing at all while inactive.
   */
  update(eye: Vector3, forward: Vector3, floorAt: (x: number, z: number) => number): void;
  /**
   * Floor height at a point, taking placed pieces into account.
   *
   * `fromY` is the height the question is being asked from — the feet of the body
   * about to stand there. Surfaces further above that than a single step are
   * ignored, which is the whole reason walking under a roof no longer snatches you
   * onto it. Omit it to get the highest surface regardless.
   */
  heightAt(x: number, z: number, ground: number, fromY?: number): number;
  /**
   * Pushes a body of the given radius out of anything solid it is inside.
   * Call after the world's own collision, which clamps and handles terrain.
   */
  collide(p: Vector3, radius: number): void;
  /** True if something solid occupies this point, for camera pull-in. */
  blocksCamera(x: number, y: number, z: number): boolean;
  /** The geometries, so the hotbar can draw an icon of each. */
  geometryFor(kind: PieceKind): BufferGeometry;
  dispose(): void;
}

/** How far above your feet a surface can be and still be something you step onto. */
const STEP_UP = 0.65;

// --- Geometry -----------------------------------------------------------------

/**
 * Accumulates boxes into one geometry.
 *
 * Faces are emitted wound counter-clockwise as seen from outside, so
 * `computeVertexNormals` is never needed and a piece can never come out inside
 * out. UVs put the texture's V axis across the timber and U along it: for every
 * face, U follows whichever of its two tangents is longer, which on a board is
 * always its length. That one rule is why the grain runs the right way on a wall
 * board, a floor board and a stair tread from a single tile.
 */
class Carpentry {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly uv: number[] = [];

  /**
   * One board. Half-extents are half its width, height and depth; `tilt` rotates
   * it about X, which is how treads lie on a slope.
   */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, tilt = 0): Carpentry {
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

  /** Horizontal boards filling a height range, for a wall or a panel. */
  boards(cx: number, cz: number, hx: number, hz: number, y0: number, y1: number): Carpentry {
    const span = y1 - y0;
    if (span <= 0.01) return this;
    const rows = Math.max(1, Math.round(span / 0.66));
    const pitch = span / rows;
    for (let i = 0; i < rows; i++) {
      this.box(cx, y0 + (i + 0.5) * pitch, cz, hx, pitch / 2 - 0.035, hz);
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
 * slot — so a placed piece needs no vertical fudge factor at all. Getting that
 * wrong per shape is what previously left some pieces hovering and others sunk.
 */
function buildGeometries(): Record<PieceKind, BufferGeometry> {
  const G = BUILD_GRID;
  const s = G / 2;
  const jamb = POST / 2;

  // --- Wall: boards between two posts ---
  const wall = new Carpentry().boards(0, 0, s, BOARD / 2, 0, G);
  wall.box(-(s - jamb), G / 2, 0, jamb, G / 2, jamb);
  wall.box(s - jamb, G / 2, 0, jamb, G / 2, jamb);

  // --- Doorway: the same wall with a hole, jambs framing it, a lintel over it ---
  const doorway = new Carpentry();
  const doorSide = (s - DOOR_HALF) / 2;
  doorway.boards(-(DOOR_HALF + doorSide), 0, doorSide, BOARD / 2, 0, G);
  doorway.boards(DOOR_HALF + doorSide, 0, doorSide, BOARD / 2, 0, G);
  doorway.boards(0, 0, DOOR_HALF, BOARD / 2, DOOR_HEAD, G);
  doorway.box(-DOOR_HALF, DOOR_HEAD / 2, 0, jamb, DOOR_HEAD / 2, jamb);
  doorway.box(DOOR_HALF, DOOR_HEAD / 2, 0, jamb, DOOR_HEAD / 2, jamb);
  doorway.box(0, DOOR_HEAD, 0, DOOR_HALF + jamb, 0.11, jamb);
  doorway.box(-(s - jamb), G / 2, 0, jamb, G / 2, jamb);
  doorway.box(s - jamb, G / 2, 0, jamb, G / 2, jamb);

  // --- Window: boards below the sill and above the head, framed ---
  const win = new Carpentry();
  const winSide = (s - WIN_HALF) / 2;
  win.boards(-(WIN_HALF + winSide), 0, winSide, BOARD / 2, 0, G);
  win.boards(WIN_HALF + winSide, 0, winSide, BOARD / 2, 0, G);
  win.boards(0, 0, WIN_HALF, BOARD / 2, 0, WIN_SILL);
  win.boards(0, 0, WIN_HALF, BOARD / 2, WIN_HEAD, G);
  win.box(0, WIN_SILL, 0, WIN_HALF + jamb, 0.09, 0.16);
  win.box(0, WIN_HEAD, 0, WIN_HALF + jamb, 0.09, jamb);
  win.box(-WIN_HALF, (WIN_SILL + WIN_HEAD) / 2, 0, jamb, (WIN_HEAD - WIN_SILL) / 2, jamb);
  win.box(WIN_HALF, (WIN_SILL + WIN_HEAD) / 2, 0, jamb, (WIN_HEAD - WIN_SILL) / 2, jamb);
  win.box(-(s - jamb), G / 2, 0, jamb, G / 2, jamb);
  win.box(s - jamb, G / 2, 0, jamb, G / 2, jamb);

  // --- Railing: two rails on balusters ---
  const rail = new Carpentry();
  rail.box(0, RAIL_TOP - 0.06, 0, s, 0.06, 0.09);
  rail.box(0, RAIL_TOP * 0.45, 0, s, 0.05, 0.07);
  for (let i = 0; i < 7; i++) {
    const x = -s + 0.28 + (i * (G - 0.56)) / 6;
    rail.box(x, RAIL_TOP / 2, 0, 0.05, RAIL_TOP / 2, 0.05);
  }
  rail.box(-(s - 0.08), RAIL_TOP / 2, 0, 0.08, RAIL_TOP / 2, 0.08);
  rail.box(s - 0.08, RAIL_TOP / 2, 0, 0.08, RAIL_TOP / 2, 0.08);

  // --- Floor: boards across joists ---
  const floor = new Carpentry();
  const joistH = (FLOOR_TOP - BOARD) / 2;
  floor.box(-(s - 0.5), joistH, 0, jamb, joistH, s);
  floor.box(s - 0.5, joistH, 0, jamb, joistH, s);
  const floorBoards = 6;
  for (let i = 0; i < floorBoards; i++) {
    const pitch = G / floorBoards;
    floor.box(0, FLOOR_TOP - BOARD / 2, -s + (i + 0.5) * pitch, s, BOARD / 2, pitch / 2 - 0.03);
  }

  // --- Foundation: the same, heavier, on four sunk posts ---
  const foundation = new Carpentry();
  for (const px of [-(s - 0.45), s - 0.45]) {
    for (const pz of [-(s - 0.45), s - 0.45]) {
      foundation.box(px, -0.3, pz, 0.16, 0.35, 0.16);
    }
  }
  const fJoist = (FOUNDATION_TOP - 0.18) / 2;
  for (const pz of [-(s - 0.45), 0, s - 0.45]) {
    foundation.box(0, fJoist, pz, s, fJoist, jamb);
  }
  for (let i = 0; i < 5; i++) {
    const pitch = G / 5;
    foundation.box(-s + (i + 0.5) * pitch, FOUNDATION_TOP - 0.09, 0, pitch / 2 - 0.035, 0.09, s);
  }

  // --- Ramp: treads on two stringers, rising along +Z ---
  const ramp = new Carpentry();
  const rampLen = Math.hypot(G, G);
  // A tread's own +Z has to point up the slope. Three's X rotation sends (0,0,1)
  // to (0,-sin a, cos a), so the angle is negative to make it rise.
  const rampTilt = -Math.PI / 4;
  const up = Math.SQRT1_2;
  for (const sx of [-(s - 0.12), s - 0.12]) {
    ramp.box(sx, G / 2, 0, jamb, 0.13, rampLen / 2, rampTilt);
  }
  const treads = 8;
  for (let i = 0; i < treads; i++) {
    const t = -rampLen / 2 + (i + 0.5) * (rampLen / treads);
    ramp.box(0, G / 2 + t * up + 0.1, t * up, s, BOARD / 2, rampLen / treads / 2 - 0.03, rampTilt);
  }

  // --- Stairs: real treads and risers, same rise and run as the ramp ---
  const stairs = new Carpentry();
  for (let i = 0; i < STEPS; i++) {
    const rise = G / STEPS;
    const run = G / STEPS;
    const zc = -s + (i + 0.5) * run;
    const yTop = (i + 1) * rise;
    // Tread, then the riser under its leading edge.
    stairs.box(0, yTop - BOARD / 2, zc, s, BOARD / 2, run / 2);
    stairs.box(0, yTop - rise / 2, zc - run / 2 + BOARD / 2, s - 0.16, rise / 2, BOARD / 2);
  }
  for (const sx of [-(s - 0.1), s - 0.1]) {
    stairs.box(sx, G / 2, 0, 0.1, 0.14, rampLen / 2, rampTilt);
  }

  // --- Roof: a gable, two sheets to a ridge running along X ---
  const roof = new Carpentry();
  const slope = Math.hypot(RIDGE, s);
  const pitchAngle = Math.atan2(RIDGE, s);
  for (const side of [1, -1]) {
    const my = RIDGE / 2;
    const mz = (side * s) / 2;
    const dy = -RIDGE / slope;
    const dz = (side * s) / slope;
    const sheets = 4;
    for (let i = 0; i < sheets; i++) {
      const t = -slope / 2 + (i + 0.5) * (slope / sheets);
      roof.box(0, my + t * dy, mz + t * dz, s, BOARD / 2, slope / sheets / 2 - 0.025, side * pitchAngle);
    }
  }
  roof.box(0, RIDGE - 0.08, 0, s, 0.09, 0.11);

  // --- Pillar: a post with a collar top and bottom ---
  const pillar = new Carpentry()
    .box(0, G / 2, 0, 0.15, G / 2, 0.15)
    .box(0, 0.09, 0, 0.22, 0.09, 0.22)
    .box(0, G - 0.09, 0, 0.22, 0.09, 0.22);

  return {
    wall: wall.finish(),
    doorway: doorway.finish(),
    window: win.finish(),
    railing: rail.finish(),
    floor: floor.finish(),
    ramp: ramp.finish(),
    stairs: stairs.finish(),
    roof: roof.finish(),
    pillar: pillar.finish(),
    foundation: foundation.finish(),
  };
}

/**
 * The solid parts of a piece, in its own frame.
 *
 * A doorway is the reason this is a list rather than one box: its opening has to be
 * walkable, so the piece is described as two jambs and a lintel with a gap between
 * them, and both collision and camera occlusion read the same description. Floors,
 * ramps, stairs and roofs return nothing — they are things you stand on, and giving
 * them sides as well would trap you on top of them.
 */
function solidsOf(kind: PieceKind): Slab[] {
  const G = BUILD_GRID;
  const s = G / 2;
  const t = POST / 2;
  switch (kind) {
    case 'wall':
      return [{ cx: 0, cz: 0, hx: s, hz: t, y0: 0, y1: G }];
    case 'doorway': {
      const side = (s - DOOR_HALF) / 2;
      return [
        { cx: -(DOOR_HALF + side), cz: 0, hx: side, hz: t, y0: 0, y1: G },
        { cx: DOOR_HALF + side, cz: 0, hx: side, hz: t, y0: 0, y1: G },
        { cx: 0, cz: 0, hx: DOOR_HALF, hz: t, y0: DOOR_HEAD, y1: G },
      ];
    }
    case 'window': {
      const side = (s - WIN_HALF) / 2;
      return [
        { cx: -(WIN_HALF + side), cz: 0, hx: side, hz: t, y0: 0, y1: G },
        { cx: WIN_HALF + side, cz: 0, hx: side, hz: t, y0: 0, y1: G },
        { cx: 0, cz: 0, hx: WIN_HALF, hz: t, y0: 0, y1: WIN_SILL },
        { cx: 0, cz: 0, hx: WIN_HALF, hz: t, y0: WIN_HEAD, y1: G },
      ];
    }
    case 'railing':
      return [{ cx: 0, cz: 0, hx: s, hz: 0.1, y0: 0, y1: RAIL_TOP }];
    case 'pillar':
      return [{ cx: 0, cz: 0, hx: 0.22, hz: 0.22, y0: 0, y1: G }];
    default:
      return [];
  }
}

/** The whole volume of a piece, for picking it with the crosshair. */
function pickBox(kind: PieceKind): Slab {
  const G = BUILD_GRID;
  const s = G / 2;
  switch (kind) {
    case 'wall':
    case 'doorway':
    case 'window':
      return { cx: 0, cz: 0, hx: s, hz: POST / 2, y0: 0, y1: G };
    case 'railing':
      return { cx: 0, cz: 0, hx: s, hz: 0.12, y0: 0, y1: RAIL_TOP };
    case 'pillar':
      return { cx: 0, cz: 0, hx: 0.25, hz: 0.25, y0: 0, y1: G };
    case 'floor':
      return { cx: 0, cz: 0, hx: s, hz: s, y0: 0, y1: FLOOR_TOP };
    case 'foundation':
      return { cx: 0, cz: 0, hx: s, hz: s, y0: -0.65, y1: FOUNDATION_TOP };
    case 'roof':
      return { cx: 0, cz: 0, hx: s, hz: s, y0: 0, y1: RIDGE };
    default:
      return { cx: 0, cz: 0, hx: s, hz: s, y0: 0, y1: G };
  }
}

// --- The site -----------------------------------------------------------------

export function createBuildSite(assets: AssetManager): BuildSite {
  const group = new Group();
  group.name = 'Building';

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
  // Laid over the piece the crosshair is on, so removing is never a guess about
  // which one will go.
  const markMaterial = new MeshStandardMaterial({
    color: 0xffd166,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    emissive: 0x7a5410,
  });

  const G = BUILD_GRID;
  const geometries = buildGeometries();

  // One instanced mesh per kind: a thousand pieces is ten draw calls. Culling is
  // switched off deliberately — the alternative is recomputing a bounding sphere
  // over every instance on every placement, to save ten draws that cost nothing.
  const kinds = new Map<PieceKind, { mesh: InstancedMesh; live: Placed[] }>();
  for (const kind of PIECES) {
    const mesh = new InstancedMesh(geometries[kind], solid, MAX_PER_KIND);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = `Build:${kind}`;
    group.add(mesh);
    kinds.set(kind, { mesh, live: [] });
  }

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
  ghost.castShadow = false;
  ghost.receiveShadow = false;
  group.add(ghost);

  const mark = new Mesh(geometries.wall, markMaterial);
  mark.visible = false;
  mark.castShadow = false;
  mark.receiveShadow = false;
  group.add(mark);

  /** Where the preview sits, its rotation, and whether that slot is free. */
  const at = new Vector3();
  let atTurn = 0;
  let free = true;
  /** The piece under the crosshair, if any. */
  let aimed: Placed | null = null;

  const matrix = new Matrix4();

  /**
   * A slot's identity, on a half-cell index so cells, edges and corners all get
   * distinct keys from the same expression: a cell lands on two even indices, an
   * edge on one odd, a corner on two odd.
   *
   * Rotation is part of it only for the pieces where two of them in one slot is a
   * sensible thing to want — it never is for an edge, which has exactly one
   * orientation, and a floor rotated twice is the same floor.
   */
  const slotKey = (kind: PieceKind, p: Vector3, turn: number): string => {
    const h = G / 2;
    const gx = Math.round(p.x / h);
    const gy = Math.round(p.y / h);
    const gz = Math.round(p.z / h);
    const facing = LATTICE[kind] === 'cell' && kind !== 'floor' ? turn % 4 : 0;
    return `${kind}:${gx}|${gy}|${gz}|${facing}`;
  };

  /**
   * Snaps the raw aim point to the lattice slot the selected piece belongs in, and
   * returns the rotation that slot implies.
   *
   * Edge pieces are the interesting case. The cell you are aiming at is found
   * first, then the side of it you are nearest — so a wall goes on the side you are
   * looking at, which is what makes enclosing a floor with four walls a matter of
   * turning around rather than of lining anything up. `rotate` steps to the next
   * side from there.
   */
  const snap = (raw: Vector3, out: Vector3): number => {
    const lattice = LATTICE[selected];
    if (lattice === 'cell') {
      out.x = Math.round(raw.x / G) * G;
      out.z = Math.round(raw.z / G) * G;
      return quarter;
    }
    if (lattice === 'corner') {
      // Corners sit half a cell off the cell centres, where four cells meet.
      out.x = (Math.round(raw.x / G - 0.5) + 0.5) * G;
      out.z = (Math.round(raw.z / G - 0.5) + 0.5) * G;
      return quarter;
    }
    const cx = Math.round(raw.x / G) * G;
    const cz = Math.round(raw.z / G) * G;
    const ox = raw.x - cx;
    const oz = raw.z - cz;
    // Side 0 = +X, 1 = +Z, 2 = -X, 3 = -Z; whichever the aim leans towards.
    let side: number;
    if (Math.abs(ox) >= Math.abs(oz)) side = ox >= 0 ? 0 : 2;
    else side = oz >= 0 ? 1 : 3;
    side = (side + quarter) % 4;
    const half = G / 2;
    out.x = cx + (side === 0 ? half : side === 2 ? -half : 0);
    out.z = cz + (side === 1 ? half : side === 3 ? -half : 0);
    // A wall on an X side faces along X, so it is turned a quarter.
    return side === 0 || side === 2 ? 1 : 0;
  };

  /** Turns a world point into a piece's own frame, undoing its quarter turn. */
  const toLocal = (p: Placed, x: number, z: number): [number, number] => {
    const dx = x - p.x;
    const dz = z - p.z;
    const ang = (p.turn * Math.PI) / 2;
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    return [c * dx - sn * dz, sn * dx + c * dz];
  };

  /**
   * The nearest piece the aim ray enters, by an exact ray/box test in each piece's
   * own frame.
   *
   * Candidates come from the grid columns around the eye rather than from the whole
   * site, so this does not care how much has been built. Deliberately not a
   * `Raycaster` against the meshes: the pieces are instanced, so there are no
   * per-piece objects to raycast, and marching triangles to find something whose
   * bounds are already known analytically would be strictly more work.
   */
  const pick = (eye: Vector3, forward: Vector3): Placed | null => {
    if (placed.size === 0) return null;
    const gx = Math.round(eye.x / G);
    const gz = Math.round(eye.z / G);
    const span = Math.ceil(PICK_RANGE / G) + 1;
    let best: Placed | null = null;
    let bestT = PICK_RANGE;

    for (let ix = -span; ix <= span; ix++) {
      for (let iz = -span; iz <= span; iz++) {
        const list = columns.get(colKey(gx + ix, gz + iz));
        if (!list) continue;
        for (const p of list) {
          const b = pickBox(p.kind);
          const ang = (p.turn * Math.PI) / 2;
          const c = Math.cos(ang);
          const sn = Math.sin(ang);
          // Ray origin and direction in the piece's frame.
          const ex = eye.x - p.x;
          const ez = eye.z - p.z;
          const ox = c * ex - sn * ez - b.cx;
          const oz = sn * ex + c * ez - b.cz;
          const oy = eye.y - p.level;
          const dx = c * forward.x - sn * forward.z;
          const dz = sn * forward.x + c * forward.z;
          const dy = forward.y;

          // Slab test, one axis at a time.
          let t0 = 0;
          let t1 = bestT;
          let ok = true;
          const slab = (o: number, d: number, lo: number, hi: number): void => {
            if (Math.abs(d) < 1e-9) {
              if (o < lo || o > hi) ok = false;
              return;
            }
            let a = (lo - o) / d;
            let bb = (hi - o) / d;
            if (a > bb) [a, bb] = [bb, a];
            if (a > t0) t0 = a;
            if (bb < t1) t1 = bb;
            if (t0 > t1) ok = false;
          };
          slab(ox, dx, -b.hx, b.hx);
          if (ok) slab(oz, dz, -b.hz, b.hz);
          if (ok) slab(oy, dy, b.y0, b.y1);
          if (ok && t1 >= t0 && t0 < bestT) {
            bestT = t0;
            best = p;
          }
        }
      }
    }
    return best;
  };

  /**
   * The piece occupying the slot the preview is in, if any.
   *
   * Bounded to just over half a cell, so it can only ever name something the
   * preview is sitting on top of — never a piece somewhere off to the side.
   */
  const nearestToPreview = (): Placed | null => {
    if (placed.size === 0) return null;
    let best: Placed | null = null;
    let bestD = (G * 0.55) ** 2;
    const gx = Math.round(at.x / G);
    const gz = Math.round(at.z / G);
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const list = columns.get(colKey(gx + ix, gz + iz));
        if (!list) continue;
        for (const p of list) {
          const dx = p.x - at.x;
          const dz = p.z - at.z;
          // Height matters as much as position, or a floor five storeys up would be
          // named while you point at the ground.
          const dy = p.level - at.y;
          const d = dx * dx + dz * dz + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
      }
    }
    return best;
  };

  const update = (
    eye: Vector3,
    forward: Vector3,
    floorAt: (x: number, z: number) => number,
  ): void => {
    if (!active) {
      ghost.visible = false;
      mark.visible = false;
      aimed = null;
      return;
    }

    // The target is a fixed distance ahead, then snapped. Deliberately not a
    // raycast against the world: a ray gives a surface, and what a grid system
    // needs is a *slot* — snapping the aim point is both cheaper and steadier,
    // because the preview stops jittering between two cells as the crosshair
    // crosses an edge of some distant hillside.
    at.copy(eye).addScaledVector(forward, REACH);
    atTurn = snap(at, at);

    // The tier comes from *how far you looked up*, and the base from the terrain
    // under the target. Measuring the aim height against the ground instead mixed
    // the two together: eye height is about 1.7 m, so looking straight ahead
    // already read as most of a tier, and whether it tipped over depended on how
    // the ground happened to fall away in front of you.
    const ground = floorAt(at.x, at.z);
    const step = G / 2;
    const tier = Math.max(0, Math.floor((at.y - eye.y) / step));
    at.y = ground + tier * step;

    ghost.geometry = geometries[selected];
    ghost.position.copy(at);
    ghost.rotation.set(0, (atTurn * Math.PI) / 2, 0);
    free = !placed.has(slotKey(selected, at, atTurn)) && (kinds.get(selected)?.live.length ?? 0) < MAX_PER_KIND;
    ghost.material = free ? ghostOk : ghostBad;
    ghost.visible = true;

    // What would be removed, shown before it is.
    //
    // The ray is the primary answer and the honest one. The fallback exists for a
    // real case it cannot serve: a floor is three hundred millimetres thick lying
    // on the ground, so a level gaze from eye height passes clean over it and you
    // could not delete the slab you were standing beside without staring at your
    // feet. When the ray finds nothing, whatever sits in the slot the preview is
    // already showing is taken instead — which is predictable, because that slot is
    // drawn on screen.
    aimed = pick(eye, forward) ?? nearestToPreview();
    if (aimed) {
      mark.geometry = geometries[aimed.kind];
      mark.position.set(aimed.x, aimed.level, aimed.z);
      mark.rotation.set(0, (aimed.turn * Math.PI) / 2, 0);
      mark.visible = true;
    } else {
      mark.visible = false;
    }
  };

  /** Writes a piece's transform into its kind's instance buffer. */
  const writeInstance = (p: Placed): void => {
    const bucket = kinds.get(p.kind);
    if (!bucket) return;
    matrix.makeRotationY((p.turn * Math.PI) / 2);
    matrix.setPosition(p.x, p.level, p.z);
    bucket.mesh.setMatrixAt(p.slot, matrix);
    bucket.mesh.instanceMatrix.needsUpdate = true;
  };

  const place = (): boolean => {
    if (!active || !free) return false;
    const bucket = kinds.get(selected);
    if (!bucket || bucket.live.length >= MAX_PER_KIND) return false;
    const key = slotKey(selected, at, atTurn);
    if (placed.has(key)) return false;

    const entry: Placed = {
      kind: selected,
      key,
      x: at.x,
      z: at.z,
      level: at.y,
      turn: atTurn,
      slot: bucket.live.length,
    };
    bucket.live.push(entry);
    bucket.mesh.count = bucket.live.length;
    writeInstance(entry);

    placed.set(key, entry);
    const col = columnOf(at.x, at.z);
    const list = columns.get(col);
    if (list) list.push(entry);
    else columns.set(col, [entry]);
    return true;
  };

  /**
   * Removes one piece.
   *
   * The instance buffer is kept dense: the last live instance of that kind is moved
   * into the freed slot and the count drops by one. That keeps the draw call over a
   * contiguous range, so removing from the middle of a large structure costs the
   * same as removing the last thing placed.
   */
  const remove = (p: Placed): void => {
    const bucket = kinds.get(p.kind);
    if (!bucket) return;
    const last = bucket.live.length - 1;
    if (p.slot !== last) {
      const moved = bucket.live[last]!;
      moved.slot = p.slot;
      bucket.live[p.slot] = moved;
      writeInstance(moved);
    }
    bucket.live.pop();
    bucket.mesh.count = bucket.live.length;
    bucket.mesh.instanceMatrix.needsUpdate = true;

    placed.delete(p.key);
    const col = columnOf(p.x, p.z);
    const list = columns.get(col);
    if (list) {
      const i = list.indexOf(p);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) columns.delete(col);
    }
    if (aimed === p) {
      aimed = null;
      mark.visible = false;
    }
  };

  const removeAimed = (): boolean => {
    if (!aimed) return false;
    remove(aimed);
    return true;
  };

  const clear = (): void => {
    for (const bucket of kinds.values()) {
      bucket.live.length = 0;
      bucket.mesh.count = 0;
      bucket.mesh.instanceMatrix.needsUpdate = true;
    }
    placed.clear();
    columns.clear();
    aimed = null;
    mark.visible = false;
  };

  /**
   * The walkable surface of one piece at a point, or `null` if that point is not
   * over it.
   *
   * Worked out from the piece's own slot and rotation rather than looked up in the
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
      case 'stairs': {
        // The tread you are standing on, so a flight feels like steps underfoot
        // rather than a smooth slope.
        const i = Math.min(STEPS - 1, Math.max(0, Math.floor(((lz + s) / G) * STEPS)));
        return p.level + ((i + 1) * G) / STEPS;
      }
      case 'roof':
        // A gable: highest along the ridge at lz = 0, down to nothing at the eaves.
        return p.level + Math.max(0, RIDGE * (1 - Math.abs(lz) / s));
      default:
        return null; // walls, doorways, windows, railings and pillars are not floors
    }
  };

  const heightAt = (x: number, z: number, ground: number, fromY?: number): number => {
    if (placed.size === 0) return ground;
    const list = columns.get(columnOf(x, z));
    if (!list) return ground;
    // A surface far above the body asking is a ceiling, not a floor. Without this
    // limit, walking under a roof or a raised floor snapped the player onto it —
    // because the only question the query could answer was "what is the highest
    // thing in this column".
    const ceiling = fromY === undefined ? Infinity : fromY + STEP_UP;
    let h = ground;
    for (const p of list) {
      const surface = surfaceAt(p, x, z);
      if (surface !== null && surface > h && surface <= ceiling) h = surface;
    }
    return h;
  };

  /**
   * Pushes a body out of the pieces it overlaps.
   *
   * Box against box, in each piece's own frame — not the circle the collider
   * registry would have used. A wall is four metres wide and a fifth of a metre
   * thick; describing it with a circle big enough to cover its width stops the
   * player two metres short of it in every direction, which is exactly what it
   * used to do.
   *
   * The body is treated as a square of its radius. At a flat face — which is where
   * a body meets a wall essentially always — that is exact; at an outside corner it
   * is a few centimetres generous, and paying for a true distance test there is not
   * worth a square root per box per frame.
   */
  const collide = (p: Vector3, radius: number): void => {
    if (placed.size === 0) return;
    const gx = Math.round(p.x / G);
    const gz = Math.round(p.z / G);
    // The body's own height range. Feet at p.y, and a head about 1.7 m up.
    const footY = p.y;
    const headY = p.y + 1.7;
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const list = columns.get(colKey(gx + ix, gz + iz));
        if (!list) continue;
        for (const piece of list) {
          const slabs = solidsOf(piece.kind);
          if (slabs.length === 0) continue;
          const ang = (piece.turn * Math.PI) / 2;
          const c = Math.cos(ang);
          const sn = Math.sin(ang);
          for (const b of slabs) {
            const y0 = piece.level + b.y0;
            const y1 = piece.level + b.y1;
            // Clear of it vertically? The slack at the top is what lets you stand
            // on a wall's top edge instead of being shoved off it.
            if (footY >= y1 - 0.1 || headY <= y0) continue;

            const dx = p.x - piece.x;
            const dz = p.z - piece.z;
            const lx = c * dx - sn * dz - b.cx;
            const lz = sn * dx + c * dz - b.cz;

            const ox = b.hx + radius - Math.abs(lx);
            const oz = b.hz + radius - Math.abs(lz);
            if (ox <= 0 || oz <= 0) continue;

            // Out along whichever axis needs moving least, so a body walking into a
            // wall is stopped by it rather than squirted along it.
            let nx = lx;
            let nz = lz;
            if (oz <= ox) nz += (lz >= 0 ? 1 : -1) * oz;
            else nx += (lx >= 0 ? 1 : -1) * ox;
            nx += b.cx;
            nz += b.cz;

            // Back to world. Inverse of the rotation above.
            p.x = piece.x + (c * nx + sn * nz);
            p.z = piece.z + (-sn * nx + c * nz);
          }
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
          const slabs = solidsOf(piece.kind);
          if (slabs.length === 0) continue;
          const [lx, lz] = toLocal(piece, x, z);
          for (const b of slabs) {
            if (y < piece.level + b.y0 || y > piece.level + b.y1) continue;
            if (Math.abs(lx - b.cx) <= b.hx && Math.abs(lz - b.cz) <= b.hz + 0.15) return true;
          }
        }
      }
    }
    return false;
  };

  return {
    group,
    get active() {
      return active;
    },
    setActive: (on) => {
      active = on;
      if (!on) {
        ghost.visible = false;
        mark.visible = false;
        aimed = null;
      }
    },
    select: (kind) => {
      selected = kind;
    },
    get selected() {
      return selected;
    },
    cycle: (n) => {
      const i = PIECES.indexOf(selected);
      const next = (i + n + PIECES.length * 8) % PIECES.length;
      selected = PIECES[next]!;
    },
    rotate: () => {
      quarter = (quarter + 1) % 4;
    },
    place,
    aimedKind: () => aimed?.kind ?? null,
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
      for (const bucket of kinds.values()) bucket.mesh.dispose();
      for (const g of Object.values(geometries)) g.dispose();
      solid.dispose();
      ghostOk.dispose();
      ghostBad.dispose();
      markMaterial.dispose();
      group.removeFromParent();
    },
  };
}
