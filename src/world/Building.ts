import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PointLight,
  RepeatWrapping,
  Vector3,
} from 'three';
import type { AssetManager } from '../core/AssetManager.ts';

/**
 * Building
 * --------
 * Snap-to-grid construction, in the shape players already know from Fortnite and
 * Rust: pick a piece, look where you want it, place. Twenty pieces in three
 * categories, a translucent preview of exactly what will appear, and no materials
 * to gather — this is an admin tool for now, but nothing here assumes that.
 *
 * Four ideas carry the whole thing.
 *
 * **One global lattice, with three kinds of slot.** Floors, ramps, stairs and roofs
 * fill a *cell*; walls, doorways, windows, gables and railings stand on a cell
 * *edge*; pillars stand at a *corner*. That is what makes a building assemble: four
 * walls enclose exactly one floor, the pillars at its corners meet all of them, and
 * a gable end lands on the same edge the wall below it used. The edge is chosen by
 * which side of the cell you are looking at, so a piece goes where you point.
 *
 * **A piece is described once.** Each kind declares its solid parts as a list of
 * boxes in its own frame, and collision, camera occlusion and crosshair picking all
 * read that one list. A doorway's opening is walkable for the same reason it looks
 * open: there is no box there. Nothing can drift between how a piece looks and how
 * it behaves, because there is only one description.
 *
 * **Pieces are carpentry.** Boards between posts, boards over joists, jambs and a
 * lintel, cladding that narrows as a gable rises. Modelling the boards costs a few
 * dozen triangles and buys the silhouette. Everything comes from one primitive that
 * emits faces already wound outwards — the hand-written shapes this replaced were
 * wound inside out, so their outer faces were culled and looked transparent.
 *
 * **Cost does not grow with what is built.** One `InstancedMesh` per kind, so a
 * thousand pieces is a couple of dozen draw calls. Collision and floor height are
 * analytic and bucketed by grid column, so a query costs a map lookup rather than a
 * search. There is a hard cap per kind: whoever is building should run out of
 * pieces long before the frame budget does.
 *
 * Placements are local to the player who made them. Making them visible to the room
 * needs authoritative world state on the server: storage, ownership, a limit, and a
 * rule for what happens when two people build into the same slot. Relaying
 * placements peer-to-peer instead would produce structures that disagree between
 * clients.
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
/**
 * Height of a roof ridge or a gable apex above its slot floor.
 *
 * Three metres, not the 2.2 it was. At 2.2 the slope had already dropped below head
 * height half a metre either side of the ridge, so a roof was only standable under along
 * a single line down its middle — measured, a body half a metre off centre was pushed
 * 0.23 m by its own roof. That is arithmetic rather than a bug: a shelter has to be
 * taller than the person sheltering. The gable piece reads the same constant, so the two
 * still meet.
 */
const RIDGE = BUILD_GRID * 0.75;
/** Walkable heights above a piece's own slot floor. */
const FLOOR_TOP = 0.3;
const FOUNDATION_TOP = 0.42;
const DECK_TOP = 0.26;
/**
 * A ceiling's walking surface, and how far its boards hang below that.
 *
 * A ceiling is not a floor with a different name. A floor is a deck you stand on and its
 * boards sit *above* its origin; a ceiling is the same deck seen from underneath, so its
 * exposed joists hang *below* the level it is placed at — which is what makes a room read as
 * closed rather than as having another floor floating over it. It is still walkable on top,
 * because a ceiling is the next storey's floor and pretending otherwise would mean a
 * two-storey house needed two pieces in the same slot.
 */
const CEIL_TOP = 0.2;
const CEIL_DROP = 0.24;
/** Height of a half wall, and of a railing or parapet. */
const HALF_WALL = 1.6;
const RAIL_TOP = 1.1;
const PARAPET = 0.62;
/** Doorway opening: half width, and height to the underside of the lintel. */
const DOOR_HALF = 0.85;
const DOOR_HEAD = 2.6;
/** Window opening: half width, sill height and head height. */
const WIN_HALF = 1.15;
const WIN_SILL = 1.1;
const WIN_HEAD = 2.45;
/** Vent window: the small high one. */
const VENT_HALF = 0.6;
const VENT_SILL = 2.15;
const VENT_HEAD = 3.05;
/** Steps in a flight of stairs. */
const STEPS = 8;
/** Thickness of a pane of glass. */
const GLASS = 0.03;
/** How many metres of timber one tile of the wood texture covers. */
const UV_METRES = 1.15;
/** How far above your feet a surface can be and still be something you step onto. */
const STEP_UP = 0.65;
/**
 * Thickness of a roof's solid shell.
 *
 * Thin, and it has to be. A ridge stands 2.2 m over its floor, so a shell of half a
 * metre leaves its underside at 1.7 m — exactly head height — and standing in the middle
 * of your own roof was blocked. Measured: at 0.55 a body under the ridge was pushed
 * 0.6 m; at this thickness it is not touched.
 *
 * A thin shell cannot be slipped through between bands, because the bands sit side by
 * side across the slope rather than stacked above one another: a body moving level meets
 * whichever band covers the ground it is over, whatever its thickness.
 */
const SHELL = 0.24;
/** Height above a piece's floor that its flame sits at, how far it reaches, how bright. */
interface FireGlow {
  y: number;
  reach: number;
  power: number;
}

/**
 * What actually casts light, and how much.
 *
 * A campfire throws further and warmer than a torch; a lantern is contained and throws
 * least. Only these four kinds are lit — a bed does not glow, and checking every piece for
 * a light it cannot have is work for nothing.
 */
const FIRELIGHT: Partial<Record<PieceKind, FireGlow>> = {
  campfire: { y: 0.5, reach: 22, power: 34 },
  brazier: { y: 1.05, reach: 19, power: 27 },
  torch: { y: 2.0, reach: 16, power: 20 },
  lantern: { y: 1.5, reach: 15, power: 17 },
};
/**
 * Beyond this a fire is not worth a light from the pool.
 *
 * Raised from 16 m along with every fire's own reach. Sixteen metres sounds generous and is
 * not: a building four cells across is sixteen metres on its own, so a lamp in one corner
 * had already faded to nothing by the opposite corner — which is the report. Twenty-eight
 * covers a seven-cell room, and the cost of raising it is nil, because the pool is still four
 * lights however many fires come into range.
 */
const LIGHT_RANGE = 28;
/** How far a door swings open, in radians. */
const DOOR_SWING = Math.PI * 0.52;
/** How close you have to be for a door to offer itself. */
const INTERACT_RANGE = 3.2;
/**
 * Hard cap per kind.
 *
 * An `InstancedMesh` reserves its whole matrix buffer up front, so this is a fixed
 * cost: twenty kinds at 192 pieces each is about 240 kB of matrices, whether or not
 * anything is built. Beyond this the answer is server-owned world state, not a
 * bigger buffer.
 */
const MAX_PER_KIND = 192;

export type PieceKind =
  // Edge pieces — they stand on the boundary between two cells.
  | 'wall'
  | 'wallHalf'
  | 'gable'
  | 'doorway'
  | 'doorArch'
  | 'doorLeaf'
  | 'windowOpen'
  | 'windowGlass'
  | 'windowVent'
  | 'railing'
  | 'beam'
  // Cell pieces — they fill a square.
  | 'floor'
  | 'foundation'
  | 'ramp'
  | 'stairs'
  | 'ceiling'
  | 'chair'
  | 'chest'
  | 'bench'
  | 'rug'
  | 'crate'
  | 'planter'
  | 'roofGable'
  | 'roofHip'
  | 'roofShed'
  | 'roofFlat'
  // Corner pieces.
  | 'pillar'
  // Furnishings, on a half-cell lattice so a table need not sit in the middle of a
  // four-metre square.
  | 'bed'
  | 'table'
  | 'stool'
  | 'cabinet'
  | 'barrel'
  | 'shelf'
  | 'torch'
  | 'campfire'
  | 'brazier'
  | 'lantern';

export interface Category {
  id: 'walls' | 'frame' | 'roof' | 'props' | 'interior';
  pieces: readonly PieceKind[];
}

/**
 * The library, grouped so a hotbar can show ten at a time.
 *
 * Grouped by what you are doing rather than by lattice: putting up walls is one
 * job, laying floors and stairs is another, closing the top is a third. Openings sit
 * beside the wall they are cut into, which is where you look for them.
 */
export const CATEGORIES: readonly Category[] = [
  {
    id: 'walls',
    pieces: [
      'wall',
      'wallHalf',
      'gable',
      'doorway',
      'doorArch',
      'doorLeaf',
      'windowOpen',
      'windowGlass',
      'windowVent',
      'railing',
    ],
  },
  {
    id: 'frame',
    pieces: ['floor', 'ceiling', 'foundation', 'ramp', 'stairs', 'pillar', 'beam'],
  },
  { id: 'roof', pieces: ['roofGable', 'roofHip', 'roofShed', 'roofFlat'] },
  /**
   * A second furnishings group, because the first one is full.
   *
   * The hotbar is ten slots and the original props group uses all ten, so more furniture
   * could not simply be appended — it would have been unreachable. Splitting rather than
   * widening the bar: ten is already as many as can be reached by number key.
   */
  {
    id: 'interior',
    pieces: ['chair', 'bench', 'chest', 'crate', 'rug', 'planter'],
  },
  {
    id: 'props',
    pieces: [
      'bed',
      'table',
      'stool',
      'cabinet',
      'barrel',
      'shelf',
      'torch',
      'campfire',
      'brazier',
      'lantern',
    ],
  },
];

/** Every kind, in category order. */
export const PIECES: readonly PieceKind[] = CATEGORIES.flatMap((c) => [...c.pieces]);

/**
 * `quarter` is the half-cell lattice the furnishings use. A four-metre square is
 * the right unit for a floor and far too coarse for a stool, and a free position
 * would give up the one property that makes the rest of this work — that two things
 * placed apart still line up.
 */
type Lattice = 'cell' | 'edge' | 'corner' | 'quarter';

const LATTICE: Record<PieceKind, Lattice> = {
  wall: 'edge',
  wallHalf: 'edge',
  gable: 'edge',
  doorway: 'edge',
  doorArch: 'edge',
  doorLeaf: 'edge',
  windowOpen: 'edge',
  windowGlass: 'edge',
  windowVent: 'edge',
  railing: 'edge',
  beam: 'edge',
  floor: 'cell',
  foundation: 'cell',
  ramp: 'cell',
  stairs: 'cell',
  roofGable: 'cell',
  roofHip: 'cell',
  roofShed: 'cell',
  ceiling: 'cell',
  chair: 'quarter',
  chest: 'quarter',
  bench: 'quarter',
  rug: 'quarter',
  crate: 'quarter',
  planter: 'quarter',
  roofFlat: 'cell',
  pillar: 'corner',
  bed: 'quarter',
  table: 'quarter',
  stool: 'quarter',
  cabinet: 'quarter',
  barrel: 'quarter',
  campfire: 'quarter',
  brazier: 'quarter',
  // Things that hang on a wall go on the wall's own lattice.
  //
  // On the half-cell lattice a shelf or a torch landed wherever you were pointing,
  // which for anything meant to be fixed to a wall meant half inside it. The edge
  // lattice is where walls are, so a shelf put on the side of a cell sits flat against
  // the wall on that side and faces into the room — and if there is no wall there yet,
  // it is still on the line one will take.
  shelf: 'edge',
  torch: 'edge',
  lantern: 'edge',
};

/**
 * Cell pieces whose orientation means something, so two of them in one cell facing
 * different ways are two different things. A floor rotated is the same floor; a
 * flight of stairs rotated is a different flight.
 */
const ROTATABLE = new Set<PieceKind>([
  'ramp',
  'stairs',
  'roofGable',
  'roofShed',
  'bed',
  'table',
  'cabinet',
  'shelf',
  'stool',
  'barrel',
  'chair',
  'chest',
  'bench',
  'rug',
  'crate',
  'planter',
]);

/** Kinds that can be opened and shut. */
const OPENABLE = new Set<PieceKind>(['doorLeaf']);

/**
 * Fixtures that hang on a wall.
 *
 * They share the wall's lattice, but a wall stands *on* the edge and a fixture has to
 * stand *against* it — centred on the edge, half of a shelf is inside the wall. So they
 * are pushed off the line by a wall's own half-thickness and turned to face the cell
 * you were aiming at, which is the room side.
 */
const MOUNTED = new Set<PieceKind>(['shelf', 'torch', 'lantern', 'cabinet']);

/**
 * How far off the wall line a fixture's origin sits.
 *
 * A wall's half-thickness plus the piece's own reach behind its origin. A shelf hangs
 * flat, so it needs almost nothing; a cabinet is a box standing on the floor and needs
 * its own depth or its back half disappears into the wall.
 */
function mountOffset(kind: PieceKind): number {
  const wall = POST / 2 + 0.04;
  return kind === 'cabinet' ? wall + 0.22 : wall;
}

/** How far a cupboard's front face stands off the wall line it backs onto. */
const CABINET_FACE = POST / 2 + 0.04 + 0.22 + 0.22;

/**
 * Fixtures that hang at whatever height you aim at, rather than standing on a floor.
 *
 * A cabinet is mounted against a wall but it is still a box resting on the ground, so it
 * is deliberately not in here.
 */
const HUNG = new Set<PieceKind>(['shelf', 'torch', 'lantern']);

/**
 * The height each hung fixture's working part sits at within its own geometry.
 *
 * Needed because the models are drawn with their business end well above their origin — a
 * shelf's boards at 1.02 m and 1.42 m, a torch's flame at about 1.4 m, a lantern's box at
 * 1.72 m. Placing the origin where the crosshair lands would put the object a metre and a
 * half higher than the spot aimed at. Subtracting the nominal height instead means the
 * part you can see goes where you pointed.
 */
const HUNG_NOMINAL: Partial<Record<PieceKind, number>> = {
  shelf: 1.22,
  torch: 1.4,
  lantern: 1.78,
};

/** Vertical step a hung fixture snaps to. Fine enough to fit a shelf under a cupboard. */
const MOUNT_RISE = 0.25;

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
  x: number;
  z: number;
  /** World height of the floor of the slot this piece stands on. */
  level: number;
  turn: number;
  /** Which instance of its kind's mesh draws it. Moves when others are removed. */
  slot: number;
  /** Doors only: swung open. */
  open: boolean;
}

export interface BuildSite {
  group: Group;
  readonly active: boolean;
  setActive(on: boolean): void;
  select(kind: PieceKind): void;
  readonly selected: PieceKind;
  /** Index of the category the selection is in. */
  readonly category: number;
  /** Moves to another category, selecting its first piece. */
  setCategory(index: number): void;
  /** Steps the selection within the current category, for the mouse wheel. */
  cycle(n: number): void;
  /** Quarter turn: rotates cell pieces, and moves edge pieces to the next side. */
  rotate(): void;
  /** Places the previewed piece. False if the slot is taken or the kind is full. */
  place(): boolean;
  /** A door within reach that you are facing, or null. */
  reachableKind(): PieceKind | null;
  /** Whether that door is currently open. */
  reachableOpen(): boolean;
  /** Opens or shuts the door within reach. */
  interact(): boolean;
  /** The piece under the crosshair, or null. */
  aimedKind(): PieceKind | null;
  /** Removes the single piece under the crosshair. */
  removeAimed(): boolean;
  count(): number;
  clear(): void;
  /**
   * Per-frame update. `eye` and `forward` are the camera's, because that is what the
   * crosshair points along; `body` is the player's own feet, because how far away a
   * door is has to be measured from the person, not from a camera that in third
   * person is standing several metres behind them.
   */
  update(
    eye: Vector3,
    forward: Vector3,
    body: Vector3,
    /**
     * The composed surface at a point, optionally ignoring anything more than a step above
     * `fromY`. The bound is what keeps a roof from being treated as the floor.
     */
    floorAt: (x: number, z: number, fromY?: number) => number,
  ): void;
  /**
   * Floor height at a point, taking placed pieces into account.
   *
   * `fromY` is the height the question is being asked from — the feet of the body
   * about to stand there. Surfaces further above that than a single step are
   * ignored, which is why walking under a roof no longer snatches you onto it. Omit
   * it to get the highest surface regardless.
   */
  heightAt(x: number, z: number, ground: number, fromY?: number): number;
  collide(p: Vector3, radius: number): void;
  blocksCamera(x: number, y: number, z: number): boolean;
  /**
   * Points the small pool of firelights at whatever is burning nearest the player.
   * Call once a frame with the player's position.
   */
  lightUp(near: Vector3, dt?: number): void;
  /**
   * What the crosshair resolved to this frame: the usable stretch of the ray, how far
   * along it the hit was, and the wall a fixture found to hang on. Diagnostic only —
   * placement reads none of it — but without it a mounting fault is guesswork.
   */
  aimInfo(): { near: number; far: number; hit: number; panel: PieceKind | null; aimY: number };
  /** The timber geometry of a kind, so the hotbar can draw an icon of it. */
  geometryFor(kind: PieceKind): BufferGeometry;
  dispose(): void;
}

// --- Geometry -----------------------------------------------------------------

/**
 * Accumulates boxes into one geometry.
 *
 * Faces are emitted wound counter-clockwise as seen from outside, so
 * `computeVertexNormals` is never needed and a piece can never come out inside out.
 * UVs put the texture's V axis across the timber and U along it: for every face, U
 * follows whichever of its two tangents is longer, which on a board is always its
 * length. That one rule is why the grain runs the right way on a wall board, a floor
 * board and a stair tread from a single tile.
 */
export class Carpentry {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly uv: number[] = [];

  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, tilt = 0): Carpentry {
    if (hx <= 0 || hy <= 0 || hz <= 0) return this;
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
    if (span <= 0.02 || hx <= 0) return this;
    const rows = Math.max(1, Math.round(span / 0.66));
    const pitch = span / rows;
    for (let i = 0; i < rows; i++) {
      this.box(cx, y0 + (i + 0.5) * pitch, cz, hx, pitch / 2 - 0.035, hz);
    }
    return this;
  }

  /** The two vertical posts that frame the ends of any edge piece. */
  endPosts(halfWidth: number, height: number): Carpentry {
    const t = POST / 2;
    this.box(-(halfWidth - t), height / 2, 0, t, height / 2, t);
    this.box(halfWidth - t, height / 2, 0, t, height / 2, t);
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
 * A piece's parts, split by the material each needs.
 *
 * Every part is drawn by its own instanced mesh sharing the piece's transform, so a
 * pane follows its frame and a flame follows its brazier for free. The leaf is the
 * exception and the reason this is a list rather than a single mesh with one
 * material: it has to swing on a hinge, which means its own transform.
 */
interface PieceGeo {
  timber: BufferGeometry;
  /** Panes. */
  glass?: BufferGeometry;
  /** A door leaf, hinged on its left jamb. */
  leaf?: BufferGeometry;
  /** Flame, ember or lit glass — emissive, casts nothing. */
  glow?: BufferGeometry;
}

/**
 * Every piece is modelled with its underside on y = 0, which is the floor of its
 * slot — so a placed piece needs no vertical fudge factor at all. Getting that wrong
 * per shape is what previously left some pieces hovering and others sunk.
 */
/**
 * The piece library and its materials, built once and shared.
 *
 * Villages are laid out from the very same pieces the player builds with, which is the
 * whole point of them — a settlement made of a separate set of models would drift from the
 * building system the first time either changed. That means two owners for one library, so
 * neither may dispose it: the geometries and materials live here, are created on first
 * request, and are released by `disposePieceAssets` when the scene is torn down.
 *
 * Materials cannot be module constants because they are built from `AssetManager` textures,
 * hence the accessor rather than a top-level `const`.
 */
export interface PieceMaterials {
  timber: MeshStandardMaterial;
  furnish: MeshStandardMaterial;
  glass: MeshStandardMaterial;
  glow: MeshStandardMaterial;
  /** Woven cloth, for the things that are not made of wood. */
  cloth: MeshStandardMaterial;
}

export interface PieceAssets {
  geometries: Record<PieceKind, PieceGeo>;
  materials: PieceMaterials;
  /** Which kinds take the darker furnishing stain. */
  furnished: ReadonlySet<PieceKind>;
}

let sharedPieces: PieceAssets | null = null;

export function pieceAssets(assets: AssetManager): PieceAssets {
  if (sharedPieces) return sharedPieces;
  const tex = assets.plank(1);
  for (const t of [tex.map, tex.normalMap, tex.roughnessMap]) {
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
  }
  const common = {
    map: tex.map,
    normalMap: tex.normalMap,
    roughnessMap: tex.roughnessMap,
    metalness: 0,
  };
  const materials: PieceMaterials = {
    timber: new MeshStandardMaterial({ ...common, roughness: 1 }),
    /**
     * Furnishings, in a darker stain than the structure they stand in.
     *
     * Same boards, same grain, same normals — only the tint differs. Structural timber and
     * a table made of the identical texture read as one continuous surface: pushed up
     * against a wall, a cupboard disappeared into it. Free, as far as the renderer is
     * concerned: colour is a uniform rather than a shader feature, so this shares its
     * compiled program with the structural material.
     */
    furnish: new MeshStandardMaterial({ ...common, color: 0xbe9a7c, roughness: 0.92 }),
    // Glass must not write depth, or a pane hides its own lit flame from outside.
    glass: new MeshStandardMaterial({
      color: 0xd6ecf5,
      transparent: true,
      opacity: 0.26,
      roughness: 0.06,
      metalness: 0,
      depthWrite: false,
    }),
    glow: new MeshStandardMaterial({
      color: 0xff9a3c,
      emissive: 0xff7a18,
      emissiveIntensity: 2.6,
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0.92,
    }),
    /**
     * A rug is not made of planks.
     *
     * It was taking the timber material like everything else, so a woven mat on a boarded floor
     * was boards on boards — invisible as an object and pointless as decoration. Deep red wool
     * with the plank normal map still applied, which at a rug's scale reads as weave rather than
     * as grain, so it costs no new texture.
     */
    cloth: new MeshStandardMaterial({
      map: null,
      normalMap: tex.normalMap,
      color: 0x8c3a34,
      roughness: 0.95,
      metalness: 0,
    }),
  };
  sharedPieces = {
    geometries: buildGeometries(),
    materials,
    furnished: new Set(CATEGORIES.find((c) => c.id === 'props')?.pieces ?? []),
  };
  return sharedPieces;
}

/** Releases the shared library. Called once, when the exterior scene is torn down. */
export function disposePieceAssets(): void {
  if (!sharedPieces) return;
  for (const g of Object.values(sharedPieces.geometries)) {
    g.timber.dispose();
    g.glass?.dispose();
    g.leaf?.dispose();
    g.glow?.dispose();
  }
  for (const m of Object.values(sharedPieces.materials)) m.dispose();
  sharedPieces = null;
}

/** The lattice a kind sits on, for anything laying pieces out programmatically. */
export function latticeOf(kind: PieceKind): 'cell' | 'edge' | 'corner' | 'quarter' {
  return LATTICE[kind];
}

/**
 * The space a piece actually occupies, in its own frame.
 *
 * Read straight off the same slab list collision uses, so it cannot disagree with what you
 * bump into. Exported because anything arranging furniture *programmatically* needs it: a bed
 * is over two metres long, and a layout that assumes every furnishing is a point puts half of
 * it through the wall behind it — which is exactly what the first villages did.
 */
export function pieceFootprint(kind: PieceKind): { hx: number; hz: number; top: number } {
  let hx = 0;
  let hz = 0;
  let top = 0;
  for (const b of solidsOf(kind)) {
    hx = Math.max(hx, Math.abs(b.cx) + b.hx);
    hz = Math.max(hz, Math.abs(b.cz) + b.hz);
    top = Math.max(top, b.y1);
  }
  // Pieces with no solid parts — a rug, a floor — still occupy their own geometry.
  if (hx === 0 && hz === 0) {
    const box = sharedPieces?.geometries[kind].timber.boundingBox;
    if (box) {
      hx = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
      hz = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
      top = box.max.y;
    }
  }
  return { hx, hz, top };
}

/** Slot dimensions villages need in order to stack storeys and sit things on floors. */
export const PIECE_METRICS = {
  grid: BUILD_GRID,
  floorTop: FLOOR_TOP,
  foundationTop: FOUNDATION_TOP,
  ceilTop: CEIL_TOP,
  wallHeight: BUILD_GRID,
  ridge: RIDGE,
} as const;

function buildGeometries(): Record<PieceKind, PieceGeo> {
  const G = BUILD_GRID;
  const s = G / 2;
  const t = POST / 2;
  const b = BOARD / 2;

  // --- Plain wall, and the waist-high version ---
  const wall = new Carpentry().boards(0, 0, s, b, 0, G).endPosts(s, G);
  const wallHalf = new Carpentry()
    .boards(0, 0, s, b, 0, HALF_WALL)
    .endPosts(s, HALF_WALL)
    // A capping rail, so the top edge is finished rather than raw board ends.
    .box(0, HALF_WALL + 0.05, 0, s, 0.06, 0.14);

  // --- Gable: the triangle a pitched roof leaves over a wall ---
  // Cladding that narrows as it rises, which is both what real gable ends look like
  // and the only way to fill a triangle out of horizontal boards.
  const gable = new Carpentry();
  const gableRows = 5;
  for (let i = 0; i < gableRows; i++) {
    const y0 = (i / gableRows) * RIDGE;
    const y1 = ((i + 1) / gableRows) * RIDGE;
    // Width at the middle of the row, so each board stops just inside the rake.
    const half = s * (1 - (y0 + y1) / 2 / RIDGE);
    gable.box(0, (y0 + y1) / 2, 0, Math.max(0.05, half), (y1 - y0) / 2 - 0.03, b);
  }
  // The rake boards trimming the two slopes. `box` only tilts about X, and these
  // need to lean in the XY plane, so each is a short stepped run instead — six
  // segments per side, which at this size is indistinguishable from a straight
  // board and keeps every face an axis-aligned quad with correct winding.
  for (const side of [1, -1]) {
    for (let i = 0; i < 6; i++) {
      const f = (i + 0.5) / 6;
      gable.box(side * s * (1 - f), RIDGE * f, 0, (s / 6) * 0.62, 0.075, t * 1.05);
    }
  }
  // Collar tie along the bottom, where the gable meets the wall below it.
  gable.box(0, 0.07, 0, s, 0.07, t);

  // --- Doorway variants ---
  const doorSide = (s - DOOR_HALF) / 2;
  const doorway = new Carpentry();
  doorway.boards(-(DOOR_HALF + doorSide), 0, doorSide, b, 0, G);
  doorway.boards(DOOR_HALF + doorSide, 0, doorSide, b, 0, G);
  doorway.boards(0, 0, DOOR_HALF, b, DOOR_HEAD, G);
  doorway.box(-DOOR_HALF, DOOR_HEAD / 2, 0, t, DOOR_HEAD / 2, t);
  doorway.box(DOOR_HALF, DOOR_HEAD / 2, 0, t, DOOR_HEAD / 2, t);
  doorway.box(0, DOOR_HEAD, 0, DOOR_HALF + t, 0.11, t);
  doorway.endPosts(s, G);

  // Arched: the same opening with its head stepped into a curve.
  const doorArch = new Carpentry();
  doorArch.boards(-(DOOR_HALF + doorSide), 0, doorSide, b, 0, G);
  doorArch.boards(DOOR_HALF + doorSide, 0, doorSide, b, 0, G);
  const archRows = 5;
  for (let i = 0; i < archRows; i++) {
    // A quarter-circle profile: the opening narrows towards its crown.
    const f0 = i / archRows;
    const f1 = (i + 1) / archRows;
    const fm = (f0 + f1) / 2;
    const halfOpen = DOOR_HALF * Math.sqrt(Math.max(0, 1 - fm * fm));
    const y0 = DOOR_HEAD - 0.5 + f0 * (DOOR_HALF + 0.5);
    const y1 = DOOR_HEAD - 0.5 + f1 * (DOOR_HALF + 0.5);
    const side = (DOOR_HALF - halfOpen) / 2;
    if (side > 0.04) {
      doorArch.box(-(halfOpen + side), (y0 + y1) / 2, 0, side, (y1 - y0) / 2, t);
      doorArch.box(halfOpen + side, (y0 + y1) / 2, 0, side, (y1 - y0) / 2, t);
    }
  }
  doorArch.boards(0, 0, DOOR_HALF, b, DOOR_HEAD + DOOR_HALF, G);
  doorArch.box(-DOOR_HALF, (DOOR_HEAD - 0.5) / 2, 0, t, (DOOR_HEAD - 0.5) / 2, t);
  doorArch.box(DOOR_HALF, (DOOR_HEAD - 0.5) / 2, 0, t, (DOOR_HEAD - 0.5) / 2, t);
  doorArch.endPosts(s, G);

  // Fitted with a leaf: the same frame, and a separate swinging door.
  //
  // The frame and the leaf are different geometries because they move differently.
  // A batten door in the old manner: vertical boards held by two ledges and a
  // diagonal brace between them, which is how a door was made before it was made of
  // panels, and which is the only reason such a door does not sag.
  const doorLeaf = new Carpentry();
  doorLeaf.boards(-(DOOR_HALF + doorSide), 0, doorSide, b, 0, G);
  doorLeaf.boards(DOOR_HALF + doorSide, 0, doorSide, b, 0, G);
  doorLeaf.boards(0, 0, DOOR_HALF, b, DOOR_HEAD, G);
  doorLeaf.box(-DOOR_HALF, DOOR_HEAD / 2, 0, t, DOOR_HEAD / 2, t);
  doorLeaf.box(DOOR_HALF, DOOR_HEAD / 2, 0, t, DOOR_HEAD / 2, t);
  doorLeaf.box(0, DOOR_HEAD, 0, DOOR_HALF + t, 0.11, t);
  doorLeaf.endPosts(s, G);

  const leaf = new Carpentry();
  const leafW = DOOR_HALF - 0.05;
  const leafH = DOOR_HEAD - 0.08;
  const leafPlanks = 6;
  for (let i = 0; i < leafPlanks; i++) {
    const pitch = (leafW * 2) / leafPlanks;
    leaf.box(-leafW + (i + 0.5) * pitch, leafH / 2, 0, pitch / 2 - 0.018, leafH / 2, 0.045);
  }
  // Two ledges across the back, and the brace between them, stepped because `box`
  // only tilts about X and this diagonal lies in the door's own plane.
  for (const y of [0.42, leafH - 0.42]) {
    leaf.box(0, y, -0.075, leafW - 0.04, 0.085, 0.035);
  }
  for (let i = 0; i < 7; i++) {
    const f = (i + 0.5) / 7;
    leaf.box(-leafW + f * leafW * 2, 0.42 + f * (leafH - 0.84), -0.075, leafW / 7, 0.09, 0.033);
  }
  // Strap hinges and a ring handle, so it reads as a door rather than a board.
  for (const y of [0.55, leafH - 0.55]) {
    leaf.box(-leafW + 0.35, y, 0.05, 0.35, 0.055, 0.02);
  }
  leaf.box(leafW - 0.16, leafH * 0.5, 0.075, 0.055, 0.09, 0.035);

  /** A window of the given opening, optionally with a pane and glazing bars. */
  const windowGeo = (half: number, sill: number, head: number, glazed: boolean): PieceGeo => {
    const c = new Carpentry();
    const side = (s - half) / 2;
    c.boards(-(half + side), 0, side, b, 0, G);
    c.boards(half + side, 0, side, b, 0, G);
    c.boards(0, 0, half, b, 0, sill);
    c.boards(0, 0, half, b, head, G);
    // Sill juts out; head is flush.
    c.box(0, sill, 0, half + t, 0.09, 0.17);
    c.box(0, head, 0, half + t, 0.09, t);
    c.box(-half, (sill + head) / 2, 0, t, (head - sill) / 2, t);
    c.box(half, (sill + head) / 2, 0, t, (head - sill) / 2, t);
    if (glazed) {
      // Glazing bars, in timber, dividing the opening into panes.
      c.box(0, (sill + head) / 2, 0, half, 0.035, 0.045);
      c.box(0, (sill + head) / 2, 0, 0.035, (head - sill) / 2, 0.045);
    }
    c.endPosts(s, G);
    const out: PieceGeo = { timber: c.finish() };
    if (glazed) {
      out.glass = new Carpentry()
        .box(0, (sill + head) / 2, 0, half - 0.02, (head - sill) / 2 - 0.02, GLASS / 2)
        .finish();
    }
    return out;
  };

  // --- Railing ---
  const rail = new Carpentry();
  rail.box(0, RAIL_TOP - 0.06, 0, s, 0.06, 0.09);
  rail.box(0, RAIL_TOP * 0.45, 0, s, 0.05, 0.07);
  for (let i = 0; i < 7; i++) {
    rail.box(-s + 0.28 + (i * (G - 0.56)) / 6, RAIL_TOP / 2, 0, 0.05, RAIL_TOP / 2, 0.05);
  }
  rail.box(-(s - 0.08), RAIL_TOP / 2, 0, 0.08, RAIL_TOP / 2, 0.08);
  rail.box(s - 0.08, RAIL_TOP / 2, 0, 0.08, RAIL_TOP / 2, 0.08);

  // --- Beam: a header spanning an edge, for openings and porches ---
  const beam = new Carpentry()
    .box(0, 0.16, 0, s, 0.16, 0.13)
    .box(0, 0.36, 0, s, 0.055, 0.17)
    // Corbels at each end, so it reads as carrying something.
    .box(-(s - 0.3), 0.06, 0, 0.3, 0.06, 0.11)
    .box(s - 0.3, 0.06, 0, 0.3, 0.06, 0.11);

  // --- Floor: boards across joists ---
  const floor = new Carpentry();
  const joistH = (FLOOR_TOP - BOARD) / 2;
  floor.box(-(s - 0.5), joistH, 0, t, joistH, s);
  floor.box(s - 0.5, joistH, 0, t, joistH, s);
  for (let i = 0; i < 6; i++) {
    const pitch = G / 6;
    floor.box(0, FLOOR_TOP - b, -s + (i + 0.5) * pitch, s, b, pitch / 2 - 0.03);
  }

  // --- Foundation: heavier, on four sunk posts ---
  const foundation = new Carpentry();
  for (const px of [-(s - 0.45), s - 0.45]) {
    for (const pz of [-(s - 0.45), s - 0.45]) {
      foundation.box(px, -0.3, pz, 0.16, 0.35, 0.16);
    }
  }
  const fJoist = (FOUNDATION_TOP - 0.18) / 2;
  for (const pz of [-(s - 0.45), 0, s - 0.45]) {
    foundation.box(0, fJoist, pz, s, fJoist, t);
  }
  for (let i = 0; i < 5; i++) {
    const pitch = G / 5;
    foundation.box(-s + (i + 0.5) * pitch, FOUNDATION_TOP - 0.09, 0, pitch / 2 - 0.035, 0.09, s);
  }

  // --- Ramp and stairs, both rising a full cell along +Z ---
  const slopeLen = Math.hypot(G, G);
  const slopeTilt = -Math.PI / 4;
  const up = Math.SQRT1_2;
  const ramp = new Carpentry();
  for (const sx of [-(s - 0.12), s - 0.12]) {
    ramp.box(sx, G / 2, 0, t, 0.13, slopeLen / 2, slopeTilt);
  }
  for (let i = 0; i < 8; i++) {
    const tt = -slopeLen / 2 + (i + 0.5) * (slopeLen / 8);
    ramp.box(0, G / 2 + tt * up + 0.1, tt * up, s, b, slopeLen / 8 / 2 - 0.03, slopeTilt);
  }

  const stairs = new Carpentry();
  for (let i = 0; i < STEPS; i++) {
    const rise = G / STEPS;
    const run = G / STEPS;
    const zc = -s + (i + 0.5) * run;
    const yTop = (i + 1) * rise;
    stairs.box(0, yTop - b, zc, s, b, run / 2);
    stairs.box(0, yTop - rise / 2, zc - run / 2 + b, s - 0.16, rise / 2, b);
  }
  for (const sx of [-(s - 0.1), s - 0.1]) {
    stairs.box(sx, G / 2, 0, 0.1, 0.14, slopeLen / 2, slopeTilt);
  }

  /** Sheets of boards laid up a slope, shared by every roof shape. */
  const slopeSheets = (
    c: Carpentry,
    fromZ: number,
    fromY: number,
    toZ: number,
    toY: number,
    halfWidth: number,
  ): void => {
    const len = Math.hypot(toY - fromY, toZ - fromZ);
    const angle = Math.atan2(toY - fromY, -(toZ - fromZ));
    const sheets = Math.max(2, Math.round(len / 0.8));
    for (let i = 0; i < sheets; i++) {
      const f = (i + 0.5) / sheets;
      c.box(
        0,
        fromY + (toY - fromY) * f,
        fromZ + (toZ - fromZ) * f,
        halfWidth,
        b,
        len / sheets / 2 - 0.02,
        angle,
      );
    }
  };

  const roofGable = new Carpentry();
  slopeSheets(roofGable, s, 0, 0, RIDGE, s);
  slopeSheets(roofGable, -s, 0, 0, RIDGE, s);
  roofGable.box(0, RIDGE - 0.08, 0, s, 0.09, 0.11);

  // Hip: four slopes to a point. Built as two gable sheets plus two end sheets that
  // narrow, which is close enough to a hip at this scale and keeps every face a box.
  const roofHip = new Carpentry();
  slopeSheets(roofHip, s, 0, 0, RIDGE * 0.98, s * 0.72);
  slopeSheets(roofHip, -s, 0, 0, RIDGE * 0.98, s * 0.72);
  for (const side of [1, -1]) {
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const f = (i + 0.5) / steps;
      // A wedge closing the end, narrowing as it climbs.
      roofHip.box(
        side * s * (1 - f * 0.72),
        RIDGE * f * 0.98,
        0,
        (s / steps) * 0.78,
        b,
        s * (1 - f * 0.55),
      );
    }
  }
  roofHip.box(0, RIDGE * 0.98 - 0.08, 0, s * 0.3, 0.09, 0.11);

  const roofShed = new Carpentry();
  slopeSheets(roofShed, -s, 0, s, RIDGE, s);
  roofShed.box(0, RIDGE - 0.08, s - 0.1, s, 0.09, 0.11);

  // Flat: a deck with a parapet, so a rooftop is a place you can stand.
  const roofFlat = new Carpentry();
  const dJoist = (DECK_TOP - BOARD) / 2;
  for (const pz of [-(s - 0.5), s - 0.5]) {
    roofFlat.box(0, dJoist, pz, s, dJoist, t);
  }
  for (let i = 0; i < 6; i++) {
    const pitch = G / 6;
    roofFlat.box(-s + (i + 0.5) * pitch, DECK_TOP - b, 0, pitch / 2 - 0.03, b, s);
  }
  for (const side of [1, -1]) {
    roofFlat.box(0, DECK_TOP + PARAPET / 2, side * (s - 0.07), s, PARAPET / 2, 0.07);
    roofFlat.box(side * (s - 0.07), DECK_TOP + PARAPET / 2, 0, 0.07, PARAPET / 2, s);
  }

  // --- Second furnishings group -------------------------------------------------------
  // All built from the same box primitive as the rest, so they share the timber material and
  // cost one instanced mesh each however many are placed.

  // Chair: a stool with a back, which is what makes a table worth sitting at.
  const chair = new Carpentry();
  chair.box(0, 0.44, 0, 0.24, 0.035, 0.24);
  for (const [sx, sz] of [
    [-0.19, -0.19],
    [0.19, -0.19],
    [-0.19, 0.19],
    [0.19, 0.19],
  ]) {
    chair.box(sx, 0.22, sz, 0.035, 0.22, 0.035);
  }
  // Back posts carry on up past the seat, with two slats between them.
  for (const sx of [-0.19, 0.19]) chair.box(sx, 0.7, 0.19, 0.035, 0.26, 0.035);
  for (const y of [0.62, 0.84]) chair.box(0, y, 0.19, 0.19, 0.05, 0.028);

  // Bench: seating for a long table, or a porch.
  const bench = new Carpentry();
  for (let i = 0; i < 3; i++) bench.box(0, 0.42, -0.16 + i * 0.16, 0.78, 0.035, 0.075);
  for (const sx of [-0.62, 0.62]) {
    bench.box(sx, 0.21, 0, 0.05, 0.21, 0.2);
    bench.box(sx, 0.03, 0, 0.09, 0.03, 0.24);
  }
  bench.box(0, 0.3, 0, 0.6, 0.04, 0.05);

  // Chest: a lidded box with iron banding. Storage is not implemented yet and this does not
  // pretend otherwise — it is furniture that looks like storage, and the lid is modelled shut.
  const chest = new Carpentry();
  chest.box(0, 0.24, 0, 0.42, 0.24, 0.28);
  chest.box(0, 0.52, 0, 0.43, 0.06, 0.29);
  for (const sx of [-0.28, 0.28]) chest.box(sx, 0.26, 0, 0.035, 0.28, 0.3);
  chest.box(0, 0.46, -0.29, 0.07, 0.06, 0.02);

  // Crate: a slatted box, for stacking in a corner.
  const crate = new Carpentry();
  for (const [sx, sz] of [
    [0, -0.3],
    [0, 0.3],
  ]) {
    for (let i = 0; i < 3; i++) crate.box(sx, 0.1 + i * 0.22, sz, 0.3, 0.075, 0.025);
  }
  for (const sx of [-0.3, 0.3]) {
    for (let i = 0; i < 3; i++) crate.box(sx, 0.1 + i * 0.22, 0, 0.025, 0.075, 0.3);
  }
  for (const [cx, cz] of [
    [-0.29, -0.29],
    [0.29, -0.29],
    [-0.29, 0.29],
    [0.29, 0.29],
  ]) {
    crate.box(cx, 0.3, cz, 0.04, 0.3, 0.04);
  }
  crate.box(0, 0.58, 0, 0.3, 0.025, 0.3);

  // Rug: a woven mat, so a floor of bare boards has something on it. Deliberately almost
  // flat — it is decoration and you walk over it, not onto it.
  const rug = new Carpentry();
  rug.box(0, 0.012, 0, 1.05, 0.012, 0.72);
  for (const sz of [-0.68, 0.68]) rug.box(0, 0.02, sz, 1.05, 0.018, 0.05);
  for (const sx of [-1.01, 1.01]) rug.box(sx, 0.02, 0, 0.05, 0.018, 0.72);

  // Planter: a trough of earth. The crops themselves are not implemented, and this is the
  // box they will go in when they are — put in now because a room wants one either way.
  const planter = new Carpentry();
  for (const sz of [-0.34, 0.34]) planter.box(0, 0.2, sz, 0.6, 0.2, 0.035);
  for (const sx of [-0.6, 0.6]) planter.box(sx, 0.2, 0, 0.035, 0.2, 0.34);
  planter.box(0, 0.05, 0, 0.6, 0.05, 0.34);
  // Soil, sitting just below the rim.
  planter.box(0, 0.32, 0, 0.55, 0.06, 0.3);
  for (const sx of [-0.62, 0.62]) planter.box(sx, 0.42, 0, 0.05, 0.03, 0.36);

  // Ceiling: boarding with its joists exposed underneath, because that is the face you see.
  //
  // Modelled downward from the slot level rather than upward like a floor. Placed overhead it
  // closes a room: the boards are the flat surface above your head and the beams cross below
  // them, which is what a ceiling looks like from a room. Walkable on top, so the same piece
  // is the next storey's floor.
  const ceiling = new Carpentry();
  {
    // The boarding itself, laid across the whole cell.
    ceiling.box(0, CEIL_TOP - b, 0, s, b, s);
    // Joists hanging below it, spaced so a lantern hook has something to sit between.
    const bays = 5;
    for (let i = 0; i < bays; i++) {
      const pitch = G / bays;
      ceiling.box(-s + (i + 0.5) * pitch, -CEIL_DROP / 2, 0, 0.055, CEIL_DROP / 2, s);
    }
    // A trimmer round the edge, so the underside has an outline instead of ending in air.
    for (const side of [1, -1]) {
      ceiling.box(0, -CEIL_DROP / 2, side * (s - 0.05), s, CEIL_DROP / 2, 0.05);
      ceiling.box(side * (s - 0.05), -CEIL_DROP / 2, 0, 0.05, CEIL_DROP / 2, s);
    }
  }

  const pillar = new Carpentry()
    .box(0, G / 2, 0, 0.15, G / 2, 0.15)
    .box(0, 0.09, 0, 0.22, 0.09, 0.22)
    .box(0, G - 0.09, 0, 0.22, 0.09, 0.22);

  // --- Furnishings ---------------------------------------------------------
  // Sized in real metres rather than to the grid: these sit inside a room, so what
  // matters is that a stool is stool-sized next to a table, not that either fills a
  // square.

  // A rope-and-plank bed with a headboard.
  const bed = new Carpentry();
  for (const sx of [-0.46, 0.46]) {
    for (const sz of [-0.95, 0.95]) {
      bed.box(sx, 0.16, sz, 0.07, 0.16, 0.07);
    }
  }
  bed.box(0, 0.36, 0, 0.5, 0.055, 1.02);
  for (let i = 0; i < 7; i++) {
    bed.box(0, 0.45, -0.88 + (i * 1.76) / 6, 0.46, 0.045, 0.1);
  }
  // Headboard.
  for (let i = 0; i < 4; i++) {
    bed.box(-0.34 + i * 0.23, 0.72, -1.0, 0.09, 0.36, 0.05);
  }
  bed.box(0, 0.94, -1.0, 0.52, 0.06, 0.07);

  // Trestle table.
  const table = new Carpentry();
  for (let i = 0; i < 5; i++) {
    table.box(0, 0.72, -0.5 + (i * 1.0) / 4, 0.85, 0.045, 0.11);
  }
  table.box(0, 0.62, 0, 0.78, 0.06, 0.5);
  for (const sz of [-0.4, 0.4]) {
    table.box(0, 0.31, sz, 0.09, 0.31, 0.09);
    table.box(0, 0.05, sz, 0.42, 0.05, 0.12);
  }
  table.box(0, 0.42, 0, 0.06, 0.05, 0.34);

  // Three-legged stool.
  const stool = new Carpentry();
  stool.box(0, 0.44, 0, 0.24, 0.04, 0.24);
  for (const [sx, sz] of [
    [-0.16, -0.16],
    [0.16, -0.16],
    [0, 0.18],
  ]) {
    stool.box(sx, 0.22, sz, 0.045, 0.22, 0.045);
  }

  // Cabinet with two doors.
  const cabinet = new Carpentry();
  cabinet.box(0, 0.9, -0.19, 0.55, 0.9, 0.03);
  for (const sx of [-0.52, 0.52]) cabinet.box(sx, 0.9, 0, 0.03, 0.9, 0.2);
  for (const y of [0.05, 0.62, 1.19, 1.76]) cabinet.box(0, y, 0, 0.55, 0.04, 0.2);
  for (const sx of [-0.27, 0.27]) {
    cabinet.box(sx, 0.9, 0.19, 0.25, 0.84, 0.025);
    cabinet.box(sx + (sx < 0 ? 0.19 : -0.19), 0.9, 0.23, 0.035, 0.06, 0.025);
  }

  // Barrel: staves in a ring, hooped twice. Twelve staves reads as round.
  const barrel = new Carpentry();
  const staves = 12;
  for (let i = 0; i < staves; i++) {
    const a = (i / staves) * Math.PI * 2;
    barrel.box(Math.cos(a) * 0.34, 0.42, Math.sin(a) * 0.34, 0.1, 0.42, 0.055);
  }
  for (const y of [0.12, 0.72]) {
    for (let i = 0; i < staves; i++) {
      const a = (i / staves) * Math.PI * 2;
      barrel.box(Math.cos(a) * 0.36, y, Math.sin(a) * 0.36, 0.11, 0.045, 0.03);
    }
  }
  barrel.box(0, 0.85, 0, 0.3, 0.03, 0.3);

  // Wall shelf, on two brackets.
  const shelf = new Carpentry();
  shelf.box(0, 1.42, 0.1, 0.7, 0.035, 0.16);
  shelf.box(0, 1.02, 0.1, 0.7, 0.035, 0.16);
  for (const sx of [-0.6, 0.6]) {
    shelf.box(sx, 1.24, 0.02, 0.045, 0.44, 0.045);
  }
  shelf.box(0, 1.24, -0.04, 0.66, 0.44, 0.025);

  // Torch: a stub on a wall bracket, with its flame as a separate emissive part.
  const torch = new Carpentry();
  torch.box(0, 1.5, 0.05, 0.05, 0.4, 0.05);
  torch.box(0, 1.24, 0.13, 0.045, 0.09, 0.14);
  torch.box(0, 1.14, 0.03, 0.07, 0.1, 0.07);
  const torchGlow = new Carpentry()
    .box(0, 1.95, 0.05, 0.075, 0.11, 0.075)
    .box(0, 2.08, 0.05, 0.05, 0.09, 0.05)
    .box(0, 2.18, 0.05, 0.028, 0.06, 0.028);

  // Campfire: a ring of stones with logs laid in, and flames above.
  const campfire = new Carpentry();
  const stones = 10;
  for (let i = 0; i < stones; i++) {
    const a = (i / stones) * Math.PI * 2;
    campfire.box(Math.cos(a) * 0.56, 0.1, Math.sin(a) * 0.56, 0.13, 0.1, 0.11);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI;
    campfire.box(Math.cos(a) * 0.12, 0.14, Math.sin(a) * 0.12, 0.38, 0.055, 0.055);
  }
  const campGlow = new Carpentry()
    .box(0, 0.24, 0, 0.34, 0.08, 0.34)
    .box(0, 0.42, 0, 0.22, 0.13, 0.22)
    .box(0, 0.62, 0, 0.13, 0.11, 0.13)
    .box(0, 0.76, 0, 0.07, 0.08, 0.07);

  // Brazier: a standing bowl of coals.
  const brazier = new Carpentry();
  for (const [sx, sz] of [
    [-0.2, -0.2],
    [0.2, -0.2],
    [0, 0.24],
  ]) {
    brazier.box(sx, 0.42, sz, 0.045, 0.42, 0.045);
  }
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    brazier.box(Math.cos(a) * 0.28, 0.9, Math.sin(a) * 0.28, 0.1, 0.11, 0.045);
  }
  brazier.box(0, 0.8, 0, 0.28, 0.035, 0.28);
  const brazierGlow = new Carpentry()
    .box(0, 0.92, 0, 0.22, 0.06, 0.22)
    .box(0, 1.04, 0, 0.13, 0.1, 0.13)
    .box(0, 1.18, 0, 0.07, 0.07, 0.07);

  // Lantern: a glazed box on a hook, lit inside.
  const lantern = new Carpentry();
  lantern.box(0, 2.0, 0.06, 0.035, 0.28, 0.035);
  lantern.box(0, 1.72, 0.1, 0.13, 0.03, 0.13);
  lantern.box(0, 1.3, 0.1, 0.14, 0.03, 0.14);
  for (const [sx, sz] of [
    [-0.11, -0.01],
    [0.11, -0.01],
    [-0.11, 0.21],
    [0.11, 0.21],
  ]) {
    lantern.box(sx, 1.51, sz, 0.02, 0.21, 0.02);
  }
  lantern.box(0, 1.75, 0.02, 0.05, 0.06, 0.06);
  const lanternGlass = new Carpentry().box(0, 1.51, 0.1, 0.1, 0.2, 0.1).finish();
  // A flame inside the glass, not a spark. Small enough to sit within the panes and
  // large enough to be a light you can see across a room, which the first one was not.
  const lanternGlow = new Carpentry()
    .box(0, 1.44, 0.1, 0.055, 0.055, 0.055)
    .box(0, 1.52, 0.1, 0.035, 0.045, 0.035)
    .box(0, 1.58, 0.1, 0.02, 0.03, 0.02)
    .finish();

  return {
    wall: { timber: wall.finish() },
    wallHalf: { timber: wallHalf.finish() },
    gable: { timber: gable.finish() },
    doorway: { timber: doorway.finish() },
    doorArch: { timber: doorArch.finish() },
    doorLeaf: { timber: doorLeaf.finish(), leaf: leaf.finish() },
    windowOpen: windowGeo(WIN_HALF, WIN_SILL, WIN_HEAD, false),
    windowGlass: windowGeo(WIN_HALF, WIN_SILL, WIN_HEAD, true),
    windowVent: windowGeo(VENT_HALF, VENT_SILL, VENT_HEAD, true),
    railing: { timber: rail.finish() },
    beam: { timber: beam.finish() },
    floor: { timber: floor.finish() },
    foundation: { timber: foundation.finish() },
    ramp: { timber: ramp.finish() },
    stairs: { timber: stairs.finish() },
    roofGable: { timber: roofGable.finish() },
    roofHip: { timber: roofHip.finish() },
    roofShed: { timber: roofShed.finish() },
    ceiling: { timber: ceiling.finish() },
    chair: { timber: chair.finish() },
    bench: { timber: bench.finish() },
    chest: { timber: chest.finish() },
    crate: { timber: crate.finish() },
    rug: { timber: rug.finish() },
    planter: { timber: planter.finish() },
    roofFlat: { timber: roofFlat.finish() },
    pillar: { timber: pillar.finish() },
    bed: { timber: bed.finish() },
    table: { timber: table.finish() },
    stool: { timber: stool.finish() },
    cabinet: { timber: cabinet.finish() },
    barrel: { timber: barrel.finish() },
    shelf: { timber: shelf.finish() },
    torch: { timber: torch.finish(), glow: torchGlow.finish() },
    campfire: { timber: campfire.finish(), glow: campGlow.finish() },
    brazier: { timber: brazier.finish(), glow: brazierGlow.finish() },
    lantern: { timber: lantern.finish(), glass: lanternGlass, glow: lanternGlow },
  };
}

/**
 * The solid parts of a piece, in its own frame.
 *
 * A doorway is the reason this is a list rather than one box: its opening has to be
 * walkable, so the piece is described as two jambs and a lintel with a gap between,
 * and collision, camera occlusion and picking all read the same description. Floors,
 * ramps, stairs and sloped roofs return nothing — they are things you stand on, and
 * giving them sides as well would trap you on top of them.
 */
function solidsOf(kind: PieceKind, open = false): Slab[] {
  const G = BUILD_GRID;
  const s = G / 2;
  const t = POST / 2;
  const full = (hx: number, cx = 0, y0 = 0, y1 = G): Slab => ({ cx, cz: 0, hx, hz: t, y0, y1 });

  /**
   * A sloped roof as bands of shell, mirrored either side of the ridge.
   *
   * Each band is only as tall as the boards are, sitting at the height the roof reaches
   * at that distance from the ridge — so the solid part is the roof rather than
   * everything beneath it.
   */
  /**
   * A slope rising along +Z, as a shell that follows the plane you actually walk on.
   *
   * Each band's top is the walking surface at the band's *near* edge, and that detail is
   * the whole point. A body is a square of its radius, so it touches a band about
   * 0.4 m before reaching it; if the band's top were the height the slope reaches at its
   * far edge — a tread height, say — then at the moment of contact the ground under the
   * body would be a full band lower than the thing in front of it, the step-up allowance
   * would not cover the difference, and the climb would stop dead. Which is exactly what
   * happened when this was four bands at tread height, and what filling it solid did
   * worse. Anchoring each band to the surface at its near edge means the body is always
   * standing level with, or above, the band it is about to enter.
   */
  const slope = (rise: number): Slab[] => {
    // Fine enough that the drop from one band to the next is less than the shell is
    // thick, so there is no seam between them for a body to slip through.
    const n = 20;
    const d = G / n;
    return Array.from({ length: n }, (_, i) => {
      const near = i * d;
      const top = Math.max(0.06, (rise * near) / G);
      return {
        cx: 0,
        cz: -s + near + d / 2,
        hx: s,
        hz: d / 2,
        y0: Math.max(0, top - SHELL),
        y1: top,
      };
    });
  };

  const shell = (height: (f: number) => number, along: 'z' | 'x' = 'z'): Slab[] => {
    const out: Slab[] = [];
    // Six bands a side: fine enough that the steps between them are smaller than the
    // shell, so the surface a body meets is continuous.
    const n = 6;
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i++) {
        const mid = 1 - (i + 0.5) / n;
        const top = Math.max(0.06, height(mid));
        const c = side * s * mid;
        const h = s / n;
        out.push(
          along === 'z'
            ? { cx: 0, cz: c, hx: s, hz: h, y0: Math.max(0, top - SHELL), y1: top }
            : { cx: c, cz: 0, hx: h, hz: s, y0: Math.max(0, top - SHELL), y1: top },
        );
      }
    }
    return out;
  };

  switch (kind) {
    case 'wall':
      return [full(s)];
    case 'wallHalf':
      return [full(s, 0, 0, HALF_WALL)];
    case 'gable':
      // Stepped like the cladding, so the triangle is solid where it is filled and
      // open where the roof slopes away.
      return Array.from({ length: 5 }, (_, i) => {
        const y0 = (i / 5) * RIDGE;
        const y1 = ((i + 1) / 5) * RIDGE;
        return full(Math.max(0.05, s * (1 - (y0 + y1) / 2 / RIDGE)), 0, y0, y1);
      });
    case 'doorway':
    case 'doorArch': {
      const side = (s - DOOR_HALF) / 2;
      return [
        full(side, -(DOOR_HALF + side)),
        full(side, DOOR_HALF + side),
        full(DOOR_HALF, 0, DOOR_HEAD, G),
      ];
    }
    case 'doorLeaf': {
      const side = (s - DOOR_HALF) / 2;
      const frame = [
        full(side, -(DOOR_HALF + side)),
        full(side, DOOR_HALF + side),
        full(DOOR_HALF, 0, DOOR_HEAD, G),
      ];
      // Shut, the leaf fills the opening; open, it has swung out of the way. Both
      // states come off the same description, so what you can walk through is always
      // what you can see.
      return open ? frame : [...frame, full(DOOR_HALF, 0, 0, DOOR_HEAD)];
    }
    case 'windowOpen':
    case 'windowGlass': {
      const side = (s - WIN_HALF) / 2;
      return [
        full(side, -(WIN_HALF + side)),
        full(side, WIN_HALF + side),
        full(WIN_HALF, 0, 0, WIN_SILL),
        full(WIN_HALF, 0, WIN_HEAD, G),
      ];
    }
    case 'windowVent': {
      const side = (s - VENT_HALF) / 2;
      return [
        full(side, -(VENT_HALF + side)),
        full(side, VENT_HALF + side),
        full(VENT_HALF, 0, 0, VENT_SILL),
        full(VENT_HALF, 0, VENT_HEAD, G),
      ];
    }
    case 'railing':
      return [{ cx: 0, cz: 0, hx: s, hz: 0.1, y0: 0, y1: RAIL_TOP }];
    case 'beam':
      return [{ cx: 0, cz: 0, hx: s, hz: 0.17, y0: 0, y1: 0.42 }];
    case 'pillar':
      return [{ cx: 0, cz: 0, hx: 0.22, hz: 0.22, y0: 0, y1: G }];
    case 'roofFlat': {
      // The parapet, so you cannot walk off a rooftop.
      const y0 = DECK_TOP;
      const y1 = DECK_TOP + PARAPET;
      return [
        { cx: 0, cz: s - 0.07, hx: s, hz: 0.07, y0, y1 },
        { cx: 0, cz: -(s - 0.07), hx: s, hz: 0.07, y0, y1 },
        { cx: s - 0.07, cz: 0, hx: 0.07, hz: s, y0, y1 },
        { cx: -(s - 0.07), cz: 0, hx: 0.07, hz: s, y0, y1 },
      ];
    }
    // Sloped roofs have no sides at all, and that is the considered answer rather than
    // an omission.
    //
    // They were briefly filled in, as bands rising to the ridge, so that walking into
    // one from the eaves was stopped. It stopped rather more than that: a roof stood on
    // the ground as a canopy became a solid wedge you could not get under, because a
    // band tall enough to be a roof over your head is also tall enough to block your
    // chest. There is no ceiling collision anywhere in this game, so the choice is
    // between "cannot walk under a roof" and "can put your head through one", and a
    // shelter you cannot shelter in is the worse of the two. You can stand on them —
    // `heightAt` gives them a real surface — and you can walk under them.
    // Sloped roofs are a thin shell that follows the slope, and that is the third and
    // correct answer after two wrong ones.
    //
    // Filled from the ground up, a canopy became a solid wedge nobody could get under.
    // With no sides at all, you could walk straight through the inside of your own roof.
    // A shell only as thick as the boards, at the height the roof actually is, gives
    // both: under the ridge your head passes well beneath it, at the eaves it is low
    // enough to step onto, and in between — where the slope crosses chest height — it
    // stops you, which is exactly where a real roof would.
    case 'roofGable':
      return shell((f) => RIDGE * (1 - f));
    case 'roofHip':
      return [...shell((f) => RIDGE * (1 - f)), ...shell((f) => RIDGE * (1 - f), 'x')];
    // A flight of stairs is a shell along its own slope, and this is the third answer
    // after two wrong ones — both of them mine, and the second one worse than the first.
    //
    // Hollow let a body walk in through the side and the high end as if the flight were
    // scenery. Filling the volume under the treads stopped that and broke climbing: the
    // ask had been for the camera to stop shaking on the way up, and the result was a
    // staircase you had to jump. Four bands of shell at tread height still blocked, for a
    // subtler reason — see `slope`, which is where the fix lives.
    //
    // What the shell gives, that neither of the others did: you walk up it, you are
    // stopped walking into its low treads from the side, and the space under the high end
    // is free, so a flight of stairs is somewhere you can build rather than a solid block.
    case 'stairs':
      return slope(G);
    case 'roofShed':
      // The same construction, and it fixes a fault here that had not been noticed: at
      // four bands the second one's top was 0.025 m too high for the step-up allowance to
      // clear, so a shed roof was climbable only by luck.
      return slope(RIDGE);
    // Furnishings are solid at their own size, so a table is furniture rather than
    // a hologram. Small enough that walking round them is never a nuisance.
    case 'bed':
      return [{ cx: 0, cz: 0, hx: 0.53, hz: 1.06, y0: 0, y1: 0.5 }];
    case 'table':
      return [{ cx: 0, cz: 0, hx: 0.85, hz: 0.55, y0: 0, y1: 0.77 }];
    case 'stool':
      return [{ cx: 0, cz: 0, hx: 0.26, hz: 0.26, y0: 0, y1: 0.48 }];
    case 'cabinet':
      return [{ cx: 0, cz: 0, hx: 0.56, hz: 0.22, y0: 0, y1: 1.8 }];
    case 'barrel':
      return [{ cx: 0, cz: 0, hx: 0.42, hz: 0.42, y0: 0, y1: 0.88 }];
    case 'chair':
      return [{ cx: 0, cz: 0, hx: 0.24, hz: 0.24, y0: 0, y1: 0.48 }];
    case 'bench':
      return [{ cx: 0, cz: 0, hx: 0.68, hz: 0.24, y0: 0, y1: 0.46 }];
    case 'chest':
      return [{ cx: 0, cz: 0, hx: 0.44, hz: 0.3, y0: 0, y1: 0.58 }];
    case 'crate':
      return [{ cx: 0, cz: 0, hx: 0.32, hz: 0.32, y0: 0, y1: 0.61 }];
    case 'planter':
      return [{ cx: 0, cz: 0, hx: 0.62, hz: 0.37, y0: 0, y1: 0.4 }];
    // A rug has no solid part at all. It is a centimetre thick and you walk across it, so
    // giving it a hitbox would mean tripping over a mat.
    case 'rug':
      return [];
    case 'campfire':
      return [{ cx: 0, cz: 0, hx: 0.68, hz: 0.68, y0: 0, y1: 0.2 }];
    case 'brazier':
      return [{ cx: 0, cz: 0, hx: 0.36, hz: 0.36, y0: 0, y1: 1.02 }];
    default:
      // Shelves, torches and lanterns hang on a wall and are not in the way.
      return [];
  }
}

/** The whole volume of a piece, for picking it with the crosshair. */
function pickBox(kind: PieceKind): Slab {
  const G = BUILD_GRID;
  const s = G / 2;
  const edge = (y1: number, hz = POST / 2): Slab => ({ cx: 0, cz: 0, hx: s, hz, y0: 0, y1 });
  switch (kind) {
    case 'wall':
    case 'doorway':
    case 'doorArch':
    case 'doorLeaf':
    case 'windowOpen':
    case 'windowGlass':
    case 'windowVent':
      return edge(G);
    case 'wallHalf':
      return edge(HALF_WALL);
    case 'gable':
      return edge(RIDGE);
    case 'railing':
      return edge(RAIL_TOP, 0.12);
    case 'beam':
      return edge(0.42, 0.18);
    case 'pillar':
      return { cx: 0, cz: 0, hx: 0.25, hz: 0.25, y0: 0, y1: G };
    case 'floor':
      return { cx: 0, cz: 0, hx: s, hz: s, y0: 0, y1: FLOOR_TOP };
    case 'foundation':
      return { cx: 0, cz: 0, hx: s, hz: s, y0: -0.65, y1: FOUNDATION_TOP };
    case 'roofFlat':
      return { cx: 0, cz: 0, hx: s, hz: s, y0: 0, y1: DECK_TOP + PARAPET };
    case 'roofGable':
    case 'roofHip':
    case 'roofShed':
      return { cx: 0, cz: 0, hx: s, hz: s, y0: 0, y1: RIDGE };
    default:
      return { cx: 0, cz: 0, hx: s, hz: s, y0: 0, y1: G };
  }
}

// --- The site -----------------------------------------------------------------

export function createBuildSite(assets: AssetManager): BuildSite {
  const group = new Group();
  group.name = 'Building';

  // The library is shared with the village streamer, so neither side owns it. See
  // `pieceAssets`.
  const shared = pieceAssets(assets);
  const timberMat = shared.materials.timber;

  /**
   * Furnishings, in a darker stain than the structure they stand in.
   *
   * Same boards, same grain, same normals — only the tint differs. Structural timber and a
   * table made of the identical texture read as one continuous surface: pushed up against
   * a wall, a cupboard disappeared into it and there was no edge to tell you where the
   * furniture ended. Darkening the furniture rather than lightening the walls is the right
   * way round because a room is mostly wall, and it matches how these things actually
   * look: framing is bare sawn pine, furniture is planed and oiled.
   *
   * Free, as far as the renderer is concerned. Colour is a uniform, not a shader feature,
   * so this shares its compiled program with the structural material — and every kind was
   * already its own instanced mesh, so no draw call has been added either.
   */
  const furnishMat = shared.materials.furnish;
  const FURNISHED = shared.furnished;

  // Glass, kept deliberately cheap: a smooth translucent standard material picks up
  // the scene's environment and the sun, which at a window's scale is the whole
  // effect. A physical material with real transmission would mean an extra render of
  // the backdrop per pane, for something you mostly see the sky through.
  const glassMat = shared.materials.glass;

  /**
   * Flame and ember.
   *
   * Emissive geometry, and deliberately not a light. A torch that actually lit the
   * room would need a shadow-casting point light per torch, and a player who lines a
   * corridor with twenty of them would be asking the renderer for twenty extra
   * shadow passes a frame. Emissive reads correctly at night — it is the fire you
   * see, not the wall it would have lit — and costs one draw call for every fire in
   * the world put together.
   */
  const glowMat = shared.materials.glow;

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
  const geometries = shared.geometries;

  interface Bucket {
    mesh: InstancedMesh;
    /** Panes, sharing the piece's transform. */
    glass: InstancedMesh | null;
    /** A door leaf, which gets the piece's transform composed with its hinge. */
    leaf: InstancedMesh | null;
    /** Flame or ember: emissive, casts nothing. */
    glow: InstancedMesh | null;
    live: Placed[];
  }

  // One instanced mesh per kind: a thousand pieces is a couple of dozen draw calls.
  // Culling is off deliberately — the alternative is recomputing a bounding sphere
  // over every instance on every placement, to save draws that cost nothing.
  const kinds = new Map<PieceKind, Bucket>();
  for (const kind of PIECES) {
    const geo = geometries[kind];
    const mesh = new InstancedMesh(
      geo.timber,
      kind === 'rug' ? shared.materials.cloth : FURNISHED.has(kind) ? furnishMat : timberMat,
      MAX_PER_KIND,
    );
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = `Build:${kind}`;
    group.add(mesh);
    /** A companion layer sharing the kind's instance count. */
    const layer = (
      g: BufferGeometry | undefined,
      mat: MeshStandardMaterial,
      prefix: string,
      casts: boolean,
    ): InstancedMesh | null => {
      if (!g) return null;
      const m = new InstancedMesh(g, mat, MAX_PER_KIND);
      m.count = 0;
      // Panes and flames do not cast. A shadow from translucent glass reads as a
      // solid board, a flame has no business casting one at all, and either would
      // add a shadow pass over every window and every fire in the scene.
      m.castShadow = casts;
      m.receiveShadow = false;
      m.frustumCulled = false;
      m.name = `${prefix}:${kind}`;
      // A flame is drawn after the glass around it, so it is visible through the pane
      // rather than sorted behind it by distance.
      if (prefix === 'Glow') m.renderOrder = 4;
      else if (prefix === 'Glass') m.renderOrder = 3;
      group.add(m);
      return m;
    };
    kinds.set(kind, {
      mesh,
      glass: layer(geo.glass, glassMat, 'Glass', false),
      leaf: layer(geo.leaf, timberMat, 'Leaf', true),
      glow: layer(geo.glow, glowMat, 'Glow', false),
      live: [],
    });
  }

  const placed = new Map<string, Placed>();
  const columns = new Map<string, Placed[]>();
  const colKey = (gx: number, gz: number): string => `${gx}|${gz}`;
  const columnOf = (x: number, z: number): string => colKey(Math.round(x / G), Math.round(z / G));

  let selected: PieceKind = 'wall';
  let quarter = 0;
  let active = false;

  const ghost = new Mesh(geometries.wall.timber, ghostOk);
  ghost.visible = false;
  ghost.castShadow = false;
  ghost.receiveShadow = false;
  group.add(ghost);

  const mark = new Mesh(geometries.wall.timber, markMaterial);
  mark.visible = false;
  mark.castShadow = false;
  mark.receiveShadow = false;
  group.add(mark);

  /**
   * The firelight pool. Four lights, shadowless, moved to whatever is burning nearest.
   *
   * Added to the group so they travel and are disposed with the site.
   */
  const firelights: PointLight[] = [];
  for (let i = 0; i < 4; i++) {
    const light = new PointLight(0xffb060, 0, 1, 1.7);
    // Always `visible`, dimmed with `intensity` — and never toggled with `visible`.
    //
    // This is the difference between a light pool that costs nothing and one that freezes
    // the game for five seconds the first time you light a fire, which is exactly what the
    // first version of this did. The renderer counts only visible lights when it builds
    // the lighting state, and that count is part of every material's program key — so
    // switching a light from hidden to shown takes the scene from zero point lights to
    // one and every single material has to be compiled again, on the spot, mid-frame.
    // Holding the count fixed from the moment the site is built means the shaders are
    // compiled once during loading and placing a torch is just a matrix write.
    light.visible = true;
    light.castShadow = false;
    light.name = `Firelight:${i}`;
    group.add(light);
    firelights.push(light);
  }
  /** Reused each frame, so choosing which fires are lit allocates nothing. */
  const candidates: { p: Placed; d2: number; glow: FireGlow }[] = [];

  const at = new Vector3();
  let atTurn = 0;
  /** The wall the crosshair found this frame, and the height it met it at. */
  let hungPanel: Placed | null = null;
  let hungAimY = 0;
  /** The ceiling the crosshair found overhead this frame, and where on it. */
  let hungSoffit: { piece: Placed; x: number; z: number; under: number } | null = null;
  /** The usable stretch of the aim ray, as distances from the camera. See `aimWindow`. */
  let aimNear = 0.35;
  let aimFar = 0.35 + REACH;
  let aimHit = 0;
  let free = true;
  let aimed: Placed | null = null;
  /** The door within reach, if any, so the HUD can offer to open it. */
  let reachable: Placed | null = null;
  const matrix = new Matrix4();
  const leafMatrix = new Matrix4();
  const hinge = new Matrix4();
  const spin = new Matrix4();

  /**
   * A slot's identity, on a half-cell index so cells, edges and corners all get
   * distinct keys from the same expression: a cell lands on two even indices, an
   * edge on one odd, a corner on two odd.
   */
  const slotKey = (kind: PieceKind, p: Vector3, turn: number): string => {
    // Fixtures slide along a wall in half-metre steps, so their slots have to be counted
    // in half metres too — on the half-cell grid, two torches a metre apart on the same
    // wall would be the same slot and the second would be refused.
    const h = MOUNTED.has(kind) || LATTICE[kind] === 'quarter' ? 0.5 : G / 2;
    // Hung fixtures move in quarter metres vertically, so their slots have to be counted
    // in quarter metres too. On two-metre buckets a shelf just under a cupboard was the
    // same slot as one just over it, and the second was refused.
    const vh = HUNG.has(kind) ? MOUNT_RISE : G / 2;
    const gx = Math.round(p.x / h);
    const gy = Math.round(p.y / vh);
    const gz = Math.round(p.z / h);
    // Which side of the wall a fixture is on is part of what it is, or the far side of a
    // wall could never hold one opposite the near side.
    const facing = ROTATABLE.has(kind) || MOUNTED.has(kind) ? turn % 4 : 0;
    return `${kind}:${gx}|${gy}|${gz}|${facing}`;
  };

  /**
   * Snaps the raw aim point to the lattice slot the selected piece belongs in, and
   * returns the rotation that slot implies.
   *
   * Edge pieces are the interesting case. The cell you are aiming at is found first,
   * then the side of it you are nearest — so a piece goes on the side you are looking
   * at, which makes enclosing a floor a matter of turning around rather than of
   * lining anything up. `rotate` steps to the next side from there.
   */
  /**
   * True when a wall, a door or a window stands at this point at this height.
   *
   * What a fixture needs to know: is there something here to hang on. Read off the pieces
   * themselves rather than from a slot key, because a doorway and a window sit on the same
   * line as a wall and are just as good to hang a torch beside.
   */
  const wallAt = (x: number, z: number, y: number): Placed | null => {
    const gx = Math.round(x / G);
    const gz = Math.round(z / G);
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const list = columns.get(colKey(gx + ix, gz + iz));
        if (!list) continue;
        for (const p of list) {
          if (LATTICE[p.kind] !== 'edge' || MOUNTED.has(p.kind)) continue;
          if (y < p.level - 0.6 || y > p.level + G) continue;
          // In the wall's own frame: close to its plane, and anywhere along its width.
          // Measuring to its centre instead meant a wall was only found when aimed at
          // dead middle — a torch a metre to one side of it reported bare ground.
          const [lx, lz] = toLocal(p, x, z);
          if (Math.abs(lz) > 0.45 || Math.abs(lx) > G / 2 + 0.05) continue;
          // The panel itself, not merely the fact of one: a fixture's height is measured
          // from the foot of the wall it hangs on, which is the only base that does not
          // move when something else is already mounted nearby.
          return p;
        }
      }
    }
    return null;
  };

  /**
   * Height a hung fixture should sit at, or null when it should stand on a floor instead.
   *
   * Read off the crosshair: where the aim ray meets the wall, snapped to a quarter metre,
   * with the fixture's own nominal height taken off so the visible part lands on the spot
   * aimed at. This replaced a height quantised to two-metre tiers and measured from
   * whatever the floor query returned underneath the fixture, which failed in two ways at
   * once. Two-metre tiers meant there were only ever three heights on a wall, so a shelf
   * could not go just above or just below anything. And measuring from the floor query
   * meant an existing cupboard *became* the floor for everything within its footprint —
   * which is precisely why a shelf would go above a cupboard and never below it or beside
   * it. Measured from the wall's own foot, neither happens.
   */
  /**
   * The underside of a ceiling or floor slab the aim ray passes into, or null.
   *
   * Marched like the hit search rather than tested against a slot key, because what counts as
   * something to hang from is "a slab whose underside is above me and in my way" — and a
   * floor slab one storey up is exactly as good a thing to hang a lamp from as a ceiling is.
   */
  const soffitAbove = (
    eye: Vector3,
    forward: Vector3,
  ): { piece: Placed; x: number; z: number; under: number } | null => {
    const STEP = 0.25;
    for (let t = aimNear; t <= aimFar; t += STEP) {
      const x = eye.x + forward.x * t;
      const y = eye.y + forward.y * t;
      const z = eye.z + forward.z * t;
      const gx = Math.round(x / G);
      const gz = Math.round(z / G);
      for (let ix = -1; ix <= 1; ix++) {
        for (let iz = -1; iz <= 1; iz++) {
          const list = columns.get(colKey(gx + ix, gz + iz));
          if (!list) continue;
          for (const p of list) {
            if (p.kind !== 'ceiling' && p.kind !== 'floor' && p.kind !== 'roofFlat') continue;
            const [lx, lz] = toLocal(p, x, z);
            if (Math.abs(lx) > G / 2 || Math.abs(lz) > G / 2) continue;
            const under = p.kind === 'ceiling' ? p.level - CEIL_DROP : p.level;
            const top = p.level + (p.kind === 'ceiling' ? CEIL_TOP : FLOOR_TOP);
            // Inside the slab's own thickness: the ray has reached it rather than passed it.
            if (y < under - 0.05 || y > top) continue;
            return { piece: p, x, z, under };
          }
        }
      }
    }
    return null;
  };

  const hungHeight = (
    kind: PieceKind,
    wall: Placed | null,
    aimY: number,
    surface: number,
  ): number | null => {
    if (!HUNG.has(kind)) return null;
    // Hanging from a ceiling: the fixture's top goes at the soffit, so it drops below it.
    if (hungSoffit) {
      const box = geometries[kind].timber.boundingBox;
      return hungSoffit.under - (box ? box.max.y : 1.8);
    }
    if (!wall) {
      // No wall under the crosshair, so it stands on whatever is there — a floor, a
      // foundation, a table, the top of a shelf, the bare ground.
      //
      // Without this a lantern could only ever be hung, because a fixture always snapped
      // to a wall line whether or not a wall existed on it. Setting it down on a surface
      // was impossible, which is why "I want to put a lamp on the shelf" did not work.
      //
      // The drop is taken from the model's own bounding box rather than a per-kind table,
      // so the piece rests on the surface whatever its shape, and a new fixture needs no
      // entry anywhere for this to be right.
      const box = geometries[kind].timber.boundingBox;
      return surface - (box ? box.min.y : 0);
    }
    const base = wall.level;
    const nominal = HUNG_NOMINAL[kind] ?? 1.2;
    // Kept on the panel: no fixture below its foot, none above its head.
    const lift = Math.min(G - 0.25, Math.max(0.45, aimY - base));
    return base + Math.round(lift / MOUNT_RISE) * MOUNT_RISE - nominal;
  };

  const snap = (raw: Vector3, out: Vector3, eye: Vector3, forward: Vector3): number => {
    const lattice = LATTICE[selected];

    if (MOUNTED.has(selected)) {
      // Fixtures are put where you point, not in the middle of a panel.
      //
      // Snapping them to the centre of a cell edge gave one position per wall and always
      // the same face of it, so hanging two torches along a corridor was impossible and
      // half the time the one torch appeared on the far side. Instead: find the wall line
      // the crosshair is nearest, slide along it in half-metre steps, and come out on
      // whichever side the player is standing on.
      const h = G / 2;
      const STEP_ALONG = 0.5;

      /**
       * Every wall line the ray crosses within reach, nearest first.
       *
       * Taking simply the first was wrong in the ordinary case: lines are every four
       * metres, so aiming across a room at a wall seven metres away crosses an empty line
       * at three — and the torch went there, four metres short of the wall it was pointed
       * at. What is wanted is the first line that has something to hang on.
       */
      const crossings: { t: number; axis: 'x' | 'z' }[] = [];
      for (const axis of ['x', 'z'] as const) {
        const o = axis === 'x' ? eye.x : eye.z;
        const d = axis === 'x' ? forward.x : forward.z;
        if (Math.abs(d) < 1e-4) continue;
        let k = d > 0 ? Math.ceil((o - h) / G) : Math.floor((o - h) / G);
        for (let n = 0; n < 4; n++) {
          const tt = (k * G + h - o) / d;
          // The same window the hit search uses. Hard-coding `REACH + 3` here was wrong the
          // moment reach started being measured from the character rather than the lens:
          // the wall being aimed at sat past the end of this list, so a fixture found
          // nothing to hang on and fell back to standing on the floor.
          if (tt > aimNear && tt <= aimFar + 1) crossings.push({ t: tt, axis });
          k += d > 0 ? 1 : -1;
        }
      }
      crossings.sort((a, b) => a.t - b.t);

      // The first crossing with a wall on it; failing that, the first crossing at all, so
      // a fixture can still be lined up before its wall exists.
      let chosen = crossings[0] ?? null;
      hungPanel = null;
      for (const c of crossings) {
        const px = eye.x + forward.x * c.t;
        const pz = eye.z + forward.z * c.t;
        // Tested at the height the ray has actually reached by then, not at eye height.
        // Aiming at the foot of a wall has to find that wall, and with a fixed eye height
        // it did not.
        const found = wallAt(px, pz, eye.y + forward.y * c.t);
        if (found) {
          chosen = c;
          hungPanel = found;
          break;
        }
      }
      hungAimY = eye.y + forward.y * (chosen ? chosen.t : aimFar);

      // Aimed upward at a ceiling: hang from it.
      //
      // Checked before the wall lines, because looking up at the ceiling of a room also
      // crosses the walls of it, and a lantern aimed at the ceiling should not end up on the
      // wall behind it. Only when the aim is genuinely upward, so nothing changes for the
      // ordinary case of pointing at a wall.
      hungSoffit = null;
      if (HUNG.has(selected) && forward.y > 0.25) {
        const lid = soffitAbove(eye, forward);
        if (lid) {
          hungSoffit = lid;
          out.x = Math.round(lid.x / STEP_ALONG) * STEP_ALONG;
          out.z = Math.round(lid.z / STEP_ALONG) * STEP_ALONG;
          return quarter;
        }
      }

      // Nothing to hang on under the crosshair: set it down where you are pointing
      // instead of snapping to an empty wall line metres away.
      //
      // This is what makes "put the lamp on the shelf" and "stand the torch on the floor"
      // possible at all. Before, a fixture snapped to the nearest cell edge whether or not
      // a wall stood on it, so a lantern could only ever be hung — and if there was no
      // wall it went to a line in mid-air. Standing pieces use the same half-metre lattice
      // the furniture uses, so a lamp still lines up with the table it is on.
      if (HUNG.has(selected) && !hungPanel) {
        out.x = Math.round(raw.x / STEP_ALONG) * STEP_ALONG;
        out.z = Math.round(raw.z / STEP_ALONG) * STEP_ALONG;
        return quarter;
      }

      if (chosen) {
        const t = chosen.t;
        const hx = eye.x + forward.x * t;
        const hz = eye.z + forward.z * t;
        /**
         * Extra clearance when a cupboard already occupies the spot on this wall.
         *
         * A fixture measures its stand-off from the wall line, and a cupboard is a box a
         * quarter of a metre deep sitting in front of that same line — so a lantern hung
         * where a cupboard already stands ended up inside it. The wall is still what the
         * fixture is mounted to; it is just mounted proud of what is in the way.
         *
         * Only the cupboard, and only when it is really there: the check is against the
         * pieces, so an empty wall gives an ordinary flush mount.
         */
        const clearCabinet = (fx: number, fz: number, fy: number): number => {
          if (!HUNG.has(selected)) return 0;
          const gx = Math.round(fx / G);
          const gz = Math.round(fz / G);
          for (let ix = -1; ix <= 1; ix++) {
            for (let iz = -1; iz <= 1; iz++) {
              const list = columns.get(colKey(gx + ix, gz + iz));
              if (!list) continue;
              for (const p of list) {
                if (p.kind !== 'cabinet') continue;
                if (fy < p.level - 0.3 || fy > p.level + 1.9) continue;
                // Measured in the cupboard's own frame, along and across it separately.
                //
                // A circle of radius 0.9 was the first version and it was wrong at exactly
                // the place the report named: a cupboard is 1.12 m wide and a quarter deep,
                // so a circle big enough to cover its width also reaches half a metre past
                // each end, and a fixture aimed at the bare wall beside it was pushed out as
                // though the cupboard were there. Which is why fixtures only worked in front
                // of the doors — anywhere along the sides they were shoved off the wall.
                const [lx, lz] = toLocal(p, fx, fz);
                if (Math.abs(lx) > 0.58 || Math.abs(lz) > 0.4) continue;
                return CABINET_FACE - mountOffset(selected);
              }
            }
          }
          return 0;
        };
        const hy = eye.y + forward.y * t;
        if (chosen.axis === 'x') {
          // The wall runs along Z. Slide along it in Z; stand off it in X, on the side
          // the ray came from, which is the side the player is on.
          const side = forward.x >= 0 ? -1 : 1;
          const line = Math.round((hx - h) / G) * G + h;
          const along = Math.round(hz / STEP_ALONG) * STEP_ALONG;
          out.x = line + side * mountOffset(selected);
          out.z = along;
          out.x += side * clearCabinet(line + side * CABINET_FACE, along, hy);
          return side > 0 ? 1 : 3;
        }
        const side = forward.z >= 0 ? -1 : 1;
        const line = Math.round((hz - h) / G) * G + h;
        const along = Math.round(hx / STEP_ALONG) * STEP_ALONG;
        out.z = line + side * mountOffset(selected);
        out.x = along;
        out.z += side * clearCabinet(along, line + side * CABINET_FACE, hy);
        return side > 0 ? 0 : 2;
      }

      // Looking along a wall rather than at one, or at nothing within reach: fall back to
      // the nearest line to the fixed aim point so there is always something to preview.
      const lineX = Math.round((raw.x - h) / G) * G + h;
      const lineZ = Math.round((raw.z - h) / G) * G + h;
      if (Math.abs(raw.x - lineX) <= Math.abs(raw.z - lineZ)) {
        const side = eye.x >= lineX ? 1 : -1;
        out.x = lineX + side * mountOffset(selected);
        out.z = Math.round(raw.z / STEP_ALONG) * STEP_ALONG;
        return side > 0 ? 1 : 3;
      }
      const side = eye.z >= lineZ ? 1 : -1;
      out.z = lineZ + side * mountOffset(selected);
      out.x = Math.round(raw.x / STEP_ALONG) * STEP_ALONG;
      return side > 0 ? 0 : 2;
    }

    if (lattice === 'cell') {
      out.x = Math.round(raw.x / G) * G;
      out.z = Math.round(raw.z / G) * G;
      return quarter;
    }
    if (lattice === 'corner') {
      out.x = (Math.round(raw.x / G - 0.5) + 0.5) * G;
      out.z = (Math.round(raw.z / G - 0.5) + 0.5) * G;
      return quarter;
    }
    if (lattice === 'quarter') {
      // Half-metre steps, not half-cell. Two metres is a coarse grid to arrange a room
      // on: a table and two stools around it, or a bed against one side of a platform,
      // simply are not expressible when everything lands on a two-metre lattice. Fine
      // enough to place furniture where you mean it, coarse enough that two pieces still
      // line up with each other.
      const step = 0.5;
      out.x = Math.round(raw.x / step) * step;
      out.z = Math.round(raw.z / step) * step;
      return quarter;
    }
    const cx = Math.round(raw.x / G) * G;
    const cz = Math.round(raw.z / G) * G;
    let ox = raw.x - cx;
    let oz = raw.z - cz;
    // Near the middle of a cell, where you are inside it, the offset carries no information
    // about which side was meant — so the direction you are facing is used instead.
    //
    // This is why a gable could not be placed. A gable belongs two tiers up, which means
    // looking up steeply, and looking up steeply puts the aim point less than a metre in
    // front of the character: both offsets come out near zero, the side falls to a tie-break
    // plus whatever rotation the tool had accumulated, and the piece appears on an arbitrary
    // edge of the square you are standing in rather than on the wall you are looking at. It
    // was being placed every time; just never where it was aimed.
    if (Math.hypot(ox, oz) < 0.7) {
      ox = forward.x;
      oz = forward.z;
    }
    let side: number;
    if (Math.abs(ox) >= Math.abs(oz)) side = ox >= 0 ? 0 : 2;
    else side = oz >= 0 ? 1 : 3;
    side = (side + quarter) % 4;
    const half = G / 2;
    out.x = cx + (side === 0 ? half : side === 2 ? -half : 0);
    out.z = cz + (side === 1 ? half : side === 3 ? -half : 0);

    return side === 0 || side === 2 ? 1 : 0;
  };

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
          const ex = eye.x - p.x;
          const ez = eye.z - p.z;
          const ox = c * ex - sn * ez - b.cx;
          const oz = sn * ex + c * ez - b.cz;
          const oy = eye.y - p.level;
          const dx = c * forward.x - sn * forward.z;
          const dz = sn * forward.x + c * forward.z;
          const dy = forward.y;

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
   * Bounded to just over half a cell, so it can only ever name something the preview
   * is sitting on top of — never a piece somewhere off to the side.
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

  /**
   * The nearest door you could reach, or null.
   *
   * Doors have to work whether or not build mode is open — you close a door behind
   * you, you do not enter a construction mode to do it. So this runs off the same
   * per-frame call, and the placement preview is what is skipped when the mode is
   * shut, not the whole update.
   */
  const findReachable = (body: Vector3, forward: Vector3): Placed | null => {
    if (placed.size === 0) return null;
    const gx = Math.round(body.x / G);
    const gz = Math.round(body.z / G);
    let best: Placed | null = null;
    let bestScore = -1;
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const list = columns.get(colKey(gx + ix, gz + iz));
        if (!list) continue;
        for (const p of list) {
          if (!OPENABLE.has(p.kind)) continue;
          const dx = p.x - body.x;
          const dz = p.z - body.z;
          const dist = Math.hypot(dx, dz);
          if (dist > INTERACT_RANGE) continue;
          if (Math.abs(p.level - body.y) > G * 0.6) continue;
          // Facing it, not merely beside it: the door you are looking at is the one
          // you meant, and a corridor of doors should offer exactly one.
          const facing = dist < 0.01 ? 1 : (dx / dist) * forward.x + (dz / dist) * forward.z;
          if (facing < 0.35) continue;
          const score = facing / Math.max(0.4, dist);
          if (score > bestScore) {
            bestScore = score;
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
    body: Vector3,
    floorAt: (x: number, z: number, fromY?: number) => number,
  ): void => {
    reachable = findReachable(body, forward);
    if (!active) {
      ghost.visible = false;
      mark.visible = false;
      aimed = null;
      return;
    }

    // Where the crosshair actually lands, not a fixed distance ahead.
    //
    // A fixed seven metres was the single worst thing about building in here, and it
    // explains a whole family of complaints at once. Stand inside a four-metre room and
    // the point seven metres ahead is on the far side of the wall — so once you had walls
    // and a ceiling, *nothing could be placed indoors at all*, because the slot being
    // aimed at was outside the building. It is also why furniture had to be positioned by
    // backing away from where you wanted it rather than by pointing at it.
    //
    // Still not a `Raycaster`: pieces are instanced, so there are no per-piece objects to
    // intersect. This marches the ray and asks the same two analytic questions the camera
    // clamp asks — is this point under the surface, is it inside something built — then
    // bisects the last step so the point returned sits just in front of what was hit
    // rather than a fifth of a metre inside it.
    aimWindow(eye, forward, body);
    const step = G / 2;
    // The tier depends only on the look angle, so it can be settled before the slot is —
    // and it has to be, because on an upper tier the slot depends on the tier.
    const tier = Math.max(0, Math.floor(((forward.y * REACH) / step) * 1)) | 0;
    let hit = aimDistance(eye, forward, floorAt);
    // Looking up to build above yourself: take the point where the ray crosses the level
    // the piece will stand on, not where the ray eventually runs out.
    //
    // This is the other half of why a house could not be finished. Looking up inside a room
    // there is nothing for the ray to strike — it leaves over the top of the walls — so the
    // aim ran to full reach, which at that angle is two cells away horizontally, and the
    // ceiling was built over next door. Crossing the tier's own plane puts it directly
    // overhead, which is where anyone looking up is pointing.
    if (tier > 0 && forward.y > 0.05) {
      // The level the player is standing on, not the highest thing in their column: under a
      // roof the latter is the roof, and the tier would then be measured from it.
      const tierY = floorAt(body.x, body.z, body.y) + tier * step;
      const tPlane = (tierY - eye.y) / forward.y;
      if (tPlane > aimNear * 0.2 && tPlane < hit) hit = Math.max(aimNear * 0.2, tPlane);
    }
    aimHit = hit;
    // The height the crosshair landed at, kept before `at.y` is overwritten with the slot's
    // own height. This is what bounds the floor query: surfaces above where you are pointing
    // are not the floor you meant, and a roof is the case that proved it.
    const hitY = eye.y + forward.y * hit;
    at.copy(eye).addScaledVector(forward, hit);
    atTurn = snap(at, at, eye, forward);

    // The tier comes from how far you looked up, and the base from the terrain under
    // the target. Measuring the aim height against the ground instead mixed the two
    // together: eye height is about 1.7 m, so looking straight ahead already read as
    // most of a tier, and whether it tipped over depended on the slope in front.
    const ground = floorAt(at.x, at.z, hitY);
    // A hung fixture takes its height from the crosshair on the wall; everything else
    // takes a tier off the ground. Two different questions, and they were being answered
    // by one formula — see `hungHeight`.
    const hung = hungHeight(selected, hungPanel, hungAimY, ground);
    at.y = hung !== null ? hung : ground + tier * step;

    ghost.geometry = geometries[selected].timber;
    ghost.position.copy(at);
    ghost.rotation.set(0, (atTurn * Math.PI) / 2, 0);
    const bucket = kinds.get(selected);
    free = !placed.has(slotKey(selected, at, atTurn)) && (bucket?.live.length ?? 0) < MAX_PER_KIND;
    ghost.material = free ? ghostOk : ghostBad;
    ghost.visible = true;

    // What would be removed, shown before it is.
    //
    // The ray is the primary answer and the honest one. The fallback exists for a
    // real case it cannot serve: a floor is three hundred millimetres thick lying on
    // the ground, so a level gaze from eye height passes clean over it and you could
    // not delete the slab beside you without staring at your feet. When the ray finds
    // nothing, whatever sits in the slot the preview is already drawing is taken
    // instead — predictable, because that slot is on screen.
    aimed = pick(eye, forward) ?? nearestToPreview();
    if (aimed) {
      mark.geometry = geometries[aimed.kind].timber;
      mark.position.set(aimed.x, aimed.level, aimed.z);
      mark.rotation.set(0, (aimed.turn * Math.PI) / 2, 0);
      mark.visible = true;
    } else {
      mark.visible = false;
    }
  };

  /** Writes a piece's transform into every layer of its kind. */
  const writeInstance = (p: Placed): void => {
    const bucket = kinds.get(p.kind);
    if (!bucket) return;
    matrix.makeRotationY((p.turn * Math.PI) / 2);
    matrix.setPosition(p.x, p.level, p.z);
    bucket.mesh.setMatrixAt(p.slot, matrix);
    bucket.mesh.instanceMatrix.needsUpdate = true;
    for (const follower of [bucket.glass, bucket.glow]) {
      if (!follower) continue;
      follower.setMatrixAt(p.slot, matrix);
      follower.instanceMatrix.needsUpdate = true;
    }
    if (bucket.leaf) {
      // The leaf hangs on the left jamb, so it turns about that edge rather than
      // about the piece's own centre: shift the hinge to the origin, turn, shift
      // back, then apply the piece's placement on top.
      hinge.makeTranslation(-DOOR_HALF, 0, 0);
      spin.makeRotationY(p.open ? -DOOR_SWING : 0);
      leafMatrix.makeTranslation(DOOR_HALF, 0, 0).multiply(spin).multiply(hinge);
      leafMatrix.premultiply(matrix);
      bucket.leaf.setMatrixAt(p.slot, leafMatrix);
      bucket.leaf.instanceMatrix.needsUpdate = true;
    }
  };

  const setCounts = (bucket: Bucket): void => {
    const n = bucket.live.length;
    bucket.mesh.count = n;
    if (bucket.glass) bucket.glass.count = n;
    if (bucket.leaf) bucket.leaf.count = n;
    if (bucket.glow) bucket.glow.count = n;
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
      open: false,
    };
    bucket.live.push(entry);
    setCounts(bucket);
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
   * The instance buffers are kept dense: the last live instance of that kind is
   * moved into the freed slot and the count drops by one. That keeps the draw over a
   * contiguous range, so removing from the middle of a large structure costs the same
   * as removing the last thing placed.
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
    setCounts(bucket);

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

  const clear = (): void => {
    for (const bucket of kinds.values()) {
      bucket.live.length = 0;
      setCounts(bucket);
      bucket.mesh.instanceMatrix.needsUpdate = true;
      if (bucket.glass) bucket.glass.instanceMatrix.needsUpdate = true;
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
   * Worked out from the piece's own slot and rotation rather than from the world's
   * collider registry. That registry holds circles with one flat top each, which is
   * right for a tree trunk, wrong for a floor slab, and hopeless for a slope: it
   * reports the highest top containing the point, so a slope approximated by
   * overlapping circles collapses into a flat block.
   */
  const surfaceAt = (p: Placed, x: number, z: number): number | null => {
    const s = G / 2;
    const [lx, lz] = toLocal(p, x, z);
    // Bounded by the cell for the pieces that fill one, and by the piece's own solid
    // parts for everything else — which is what the fall-through below does. A cell
    // test here would claim a stool holds up the whole four-metre square around it.
    if (LATTICE[p.kind] !== 'quarter' && (Math.abs(lx) > s || Math.abs(lz) > s)) return null;
    switch (p.kind) {
      case 'floor':
        return p.level + FLOOR_TOP;
      case 'foundation':
        return p.level + FOUNDATION_TOP;
      case 'ceiling':
        return p.level + CEIL_TOP;
      case 'roofFlat':
        return p.level + DECK_TOP;
      case 'ramp':
        return p.level + Math.max(0, Math.min(G, lz + s));
      case 'stairs':
        // The same smooth plane a ramp uses, even though the treads are modelled.
        //
        // Returning the tread you are standing on read well on paper and shook the camera
        // apart in practice: the controller snaps to the floor every frame, so a surface
        // that jumps half a metre between one step and the next hands it a jolt per
        // tread. Real staircases are climbed by a smoothed capsule in every engine that
        // has them, for exactly this reason. The steps are still what you see.
        return p.level + Math.max(0, Math.min(G, lz + s));
      case 'roofGable':
        return p.level + Math.max(0, RIDGE * (1 - Math.abs(lz) / s));
      case 'roofHip':
        // Four slopes to a point: the further out in either direction, the lower.
        return p.level + Math.max(0, RIDGE * (1 - Math.max(Math.abs(lx), Math.abs(lz)) / s));
      case 'roofShed':
        return p.level + Math.max(0, Math.min(RIDGE, (RIDGE * (lz + s)) / G));
      default:
        break;
    }
    // Everything else stands on its own solid parts.
    //
    // This is what lets you get on top of a wall, a railing or a table at all.
    // Previously only the shapes with an analytic surface had one, so a wall was
    // something you could be pushed sideways by and never land on: you jumped, there
    // was nothing to stand on, and the pushout slid you off along its face. Reading
    // the same slab list the collision uses means the top of a piece is exactly as
    // wide as the piece — you balance on a wall's own thickness, not on its cell.
    let top: number | null = null;
    for (const b of solidsOf(p.kind, p.open)) {
      if (Math.abs(lx - b.cx) > b.hx || Math.abs(lz - b.cz) > b.hz) continue;
      const y = p.level + b.y1;
      if (top === null || y > top) top = y;
    }
    return top;
  };

  const heightAt = (x: number, z: number, ground: number, fromY?: number): number => {
    if (placed.size === 0) return ground;
    // A surface far above the body asking is a ceiling, not a floor. Without this
    // limit, walking under a roof or a raised floor snapped the player onto it,
    // because the only question the query could answer was "what is the highest
    // thing in this column".
    const ceiling = fromY === undefined ? Infinity : fromY + STEP_UP;
    let h = ground;
    // The neighbouring columns as well as the point's own, which the collision pass
    // already did and this did not. A bed is over two metres long and a table nearly
    // two wide, so either can be bucketed in one column and reach well into the next —
    // and standing on the part that reached across found nothing underfoot. That is why
    // a bed could be walked through near its ends while being solid in the middle.
    const gx = Math.round(x / G);
    const gz = Math.round(z / G);
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const list = columns.get(colKey(gx + ix, gz + iz));
        if (!list) continue;
        for (const p of list) {
          const surface = surfaceAt(p, x, z);
          if (surface !== null && surface > h && surface <= ceiling) h = surface;
        }
      }
    }
    return h;
  };

  /**
   * Pushes a body out of the pieces it overlaps.
   *
   * Box against box, in each piece's own frame — not the circle the collider registry
   * would have used. A wall is four metres wide and a fifth of a metre thick;
   * describing it with a circle big enough to cover its width stops the player two
   * metres short of it in every direction, which is exactly what it used to do.
   *
   * The body is treated as a square of its radius. At a flat face — which is where a
   * body meets a wall essentially always — that is exact; at an outside corner it is
   * a few centimetres generous, and paying for a true distance test there is not
   * worth a square root per box per frame.
   */
  const collide = (p: Vector3, radius: number): void => {
    if (placed.size === 0) return;
    const gx = Math.round(p.x / G);
    const gz = Math.round(p.z / G);
    const footY = p.y;
    const headY = p.y + 1.7;
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const list = columns.get(colKey(gx + ix, gz + iz));
        if (!list) continue;
        for (const piece of list) {
          const slabs = solidsOf(piece.kind, piece.open);
          if (slabs.length === 0) continue;
          const ang = (piece.turn * Math.PI) / 2;
          const c = Math.cos(ang);
          const sn = Math.sin(ang);
          for (const b of slabs) {
            const y0 = piece.level + b.y0;
            const y1 = piece.level + b.y1;
            // Within a step of the top counts as being on top of it, not against it.
            //
            // This is a step-up allowance, and it is the other half of being able to
            // get onto a wall. The pushout runs before the ground snap does, so with
            // a tight margin here a body that had risen level with the top was still
            // shoved off sideways a frame before the floor query could put it on top
            // — which is exactly the "I try to jump onto the fence and it throws me
            // left and right". A step's worth of slack lets the landing happen, and
            // it is the same allowance that carries you up a stair tread or a roof.
            if (footY >= y1 - STEP_UP || headY <= y0) continue;

            const dx = p.x - piece.x;
            const dz = p.z - piece.z;
            const lx = c * dx - sn * dz - b.cx;
            const lz = sn * dx + c * dz - b.cz;

            const ox = b.hx + radius - Math.abs(lx);
            const oz = b.hz + radius - Math.abs(lz);
            if (ox <= 0 || oz <= 0) continue;

            let nx = lx;
            let nz = lz;
            if (oz <= ox) nz += (lz >= 0 ? 1 : -1) * oz;
            else nx += (lx >= 0 ? 1 : -1) * ox;
            nx += b.cx;
            nz += b.cz;

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
          const slabs = solidsOf(piece.kind, piece.open);
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

  /**
   * How far along the aim ray the crosshair lands, capped at reach.
   *
   * Marched rather than raycast, for the reason given where it is called: the pieces are
   * instanced and there are no objects to intersect. Steps of a fifth of a metre over
   * seven — under forty samples of two analytic tests, once a frame — then five rounds of
   * bisection on the step that hit, which pins the surface to about half a centimetre.
   */
  /**
   * The stretch of the aim ray that counts, as distances from the camera.
   *
   * Recomputed once a frame and shared, because two different things walk this ray — the
   * hit search and the wall-line search a fixture uses — and when they disagreed about
   * where it started and ended, fixtures broke: the reach grew by the camera's own set-back
   * and the wall the player was pointing at fell outside the fixture search's window, so
   * nothing was found to hang on.
   *
   * It begins just past the character's head, not at the lens. The ray has to come from
   * the camera to agree with the crosshair, but in third person the camera sits several
   * metres behind the character and that stretch is underground as often as not — pulled in
   * against a hillside, or below the floor being stood on. Marching from zero reported a
   * hit at once and dropped every piece at the player's feet.
   */
  const aimWindow = (eye: Vector3, forward: Vector3, body: Vector3): void => {
    const head = body.y + 1.7;
    const ahead =
      (body.x - eye.x) * forward.x + (head - eye.y) * forward.y + (body.z - eye.z) * forward.z;
    aimNear = Math.max(0.35, ahead + 0.35);
    aimFar = aimNear + REACH;
  };

  const aimDistance = (
    eye: Vector3,
    forward: Vector3,
    floorAt: (x: number, z: number) => number,
  ): number => {
    const STEP = 0.2;
    const solid = (t: number): boolean => {
      const x = eye.x + forward.x * t;
      const y = eye.y + forward.y * t;
      const z = eye.z + forward.z * t;
      // Unbounded here, and correctly so: this asks "is this point inside the ground",
      // which is a question about the surface at that point whatever height it is at.
      return y <= floorAt(x, z) || blocksCamera(x, y, z);
    };

    const from = aimNear;
    const to = aimFar;

    for (let t = from; t <= to; t += STEP) {
      if (!solid(t)) continue;
      let lo = Math.max(from, t - STEP);
      let hi = t;
      for (let i = 0; i < 5; i++) {
        const mid = (lo + hi) / 2;
        if (solid(mid)) hi = mid;
        else lo = mid;
      }
      return lo;
    }
    return to;
  };

  /**
   * Points the firelight pool at the nearest burning things.
   *
   * A fixed pool of four lights, no shadows, reassigned each frame — not one light per
   * fire. A light per torch is the obvious implementation and the wrong one: somebody
   * lining a corridor with twenty of them would be asking the renderer for twenty more
   * lights in every material's shader, which is a recompile and then a permanent cost in
   * every lit pixel. Four is enough that the fires you are standing among are lit, and it
   * costs the same whether there are four fires in the world or four hundred.
   *
   * Reassignment is a partial sort over the pieces in the columns around the player, so it
   * does not care how much has been built either.
   */
  const lightUp = (near: Vector3, dt = 1): void => {
    const gx = Math.round(near.x / G);
    const gz = Math.round(near.z / G);
    candidates.length = 0;
    for (let ix = -2; ix <= 2; ix++) {
      for (let iz = -2; iz <= 2; iz++) {
        const list = columns.get(colKey(gx + ix, gz + iz));
        if (!list) continue;
        for (const p of list) {
          const glow = FIRELIGHT[p.kind];
          if (!glow) continue;
          const d2 = (p.x - near.x) ** 2 + (p.z - near.z) ** 2;
          if (d2 > LIGHT_RANGE * LIGHT_RANGE) continue;
          candidates.push({ p, d2, glow });
        }
      }
    }
    candidates.sort((a, b) => a.d2 - b.d2);

    // Eased, so light arrives and leaves instead of snapping on.
    //
    // Two separate fades, because the abruptness had two separate causes. A fire at the
    // edge of the pool's range went from full brightness to nothing the moment it crossed
    // the cut-off, so the target is now faded out over the last third of the range. And a
    // fire entering the pool at all jumped straight to full, so the light eases toward
    // whatever the target is rather than being assigned it. Exponential, which is
    // frame-rate independent — a fixed step per frame would fade at different speeds on
    // different machines.
    const k = 1 - Math.exp(-dt / 0.13);
    const FADE_FROM = LIGHT_RANGE * 0.66;
    for (let i = 0; i < firelights.length; i++) {
      const light = firelights[i]!;
      const pick = candidates[i];
      let target = 0;
      if (pick) {
        light.position.set(pick.p.x, pick.p.level + pick.glow.y, pick.p.z);
        light.distance = pick.glow.reach;
        const d = Math.sqrt(pick.d2);
        const near01 = Math.min(1, Math.max(0, (LIGHT_RANGE - d) / (LIGHT_RANGE - FADE_FROM)));
        // Smoothstep rather than linear: it leaves and arrives at zero slope, so there is
        // no moment where the brightness visibly starts moving.
        target = pick.glow.power * near01 * near01 * (3 - 2 * near01);
      }
      // Dimmed, never hidden. See the constructor: hiding a light changes how many the
      // renderer counts and costs a full shader rebuild.
      light.intensity += (target - light.intensity) * k;
      if (light.intensity < 0.01) light.intensity = 0;
    }
  };

  const categoryOf = (kind: PieceKind): number =>
    CATEGORIES.findIndex((c) => c.pieces.includes(kind));

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
    get category() {
      return Math.max(0, categoryOf(selected));
    },
    setCategory: (index) => {
      const cat = CATEGORIES[((index % CATEGORIES.length) + CATEGORIES.length) % CATEGORIES.length];
      if (cat) selected = cat.pieces[0]!;
    },
    cycle: (n) => {
      // Within the category, so the wheel never jumps you from a window to a roof.
      const cat = CATEGORIES[Math.max(0, categoryOf(selected))]!;
      const i = cat.pieces.indexOf(selected);
      const len = cat.pieces.length;
      selected = cat.pieces[((i + n) % len + len) % len]!;
    },
    rotate: () => {
      quarter = (quarter + 1) % 4;
    },
    place,
    lightUp,
    reachableKind: () => reachable?.kind ?? null,
    reachableOpen: () => reachable?.open ?? false,
    interact: () => {
      if (!reachable) return false;
      reachable.open = !reachable.open;
      writeInstance(reachable);
      return true;
    },
    aimedKind: () => aimed?.kind ?? null,
    removeAimed: () => {
      if (!aimed) return false;
      remove(aimed);
      return true;
    },
    count: () => placed.size,
    clear,
    update,
    heightAt,
    collide,
    blocksCamera,
    aimInfo: () => ({
      near: aimNear,
      far: aimFar,
      hit: aimHit,
      panel: hungPanel ? hungPanel.kind : null,
      aimY: hungAimY,
    }),
    geometryFor: (kind) => geometries[kind].timber,
    dispose: () => {
      clear();
      for (const bucket of kinds.values()) {
        bucket.mesh.dispose();
        bucket.glass?.dispose();
        bucket.leaf?.dispose();
        bucket.glow?.dispose();
      }
      // Neither the geometries nor the four timber materials are disposed here: they are
      // the shared library, used by the village streamer as well, and released once by
      // `disposePieceAssets` at scene teardown. Disposing them from here is what would
      // strip the geometry out from under every village in the world.
      ghostOk.dispose();
      ghostBad.dispose();
      markMaterial.dispose();
      group.removeFromParent();
    },
  };
}
