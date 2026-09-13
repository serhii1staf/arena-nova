import {
  AdditiveBlending,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PointLight,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
import type { AssetManager } from '../core/AssetManager.ts';
import {
  BUILD_GRID,
  createPieceField,
  type FieldPiece,
  type PieceField,
  latticeOf,
  pieceAssets,
  pieceFootprint,
  PIECE_METRICS,
  type PieceKind,
} from './Building.ts';
import type { PropRegistry } from './PropRegistry.ts';
import {
  cellRandom,
  surfaceBiomeAt,
  surfaceHeightAt,
  surfaceSlopeAt,
  villageSiteFor,
  VILLAGE_CELL,
  type BiomeId,
} from './WorldGen.ts';

/**
 * Village
 * -------
 * Settlements laid out from the *same* pieces the player builds with — the walls, roofs,
 * doors, windows and furniture of `Building.ts`, on the same four-metre lattice, instanced
 * the same way. Not a separate set of models, and deliberately so: a village built out of
 * its own private geometry would drift from the building system the first time either one
 * changed, and a player who can put up a wall should be able to recognise the wall in a
 * village as the same wall.
 *
 * The plan is authored rather than random. A settlement is a square with roads leaving it,
 * houses fronting onto those roads, workshops on the outskirts and fields beyond — because
 * that is what a village is, and scattering buildings at random radii is exactly what makes
 * generated ones read as a heap. What varies between villages is which plans are used, how
 * many, their orientation, the materials the biome dictates, and what is inside them.
 *
 * Everything is streamed on the same contract as the other world layers, so a village that
 * is far away costs nothing at all.
 */

/** How far out villages stream, in cells. One is plenty at a kilometre a cell. */
const VIEW_CELLS = 1;

/**
 * Cap per piece kind per village.
 *
 * A guard against a runaway plan, not a budget: each mesh is allocated to the number of
 * pieces actually produced, so the only thing this number does is silently drop anything
 * past it. Two hundred, because paving is the crowded kind — a settlement's roads and
 * building plinths together come to something over a hundred foundation slabs, and at
 * seventy-two the roads simply stopped halfway along.
 */
const MAX_PER_KIND = 200;

/** Lanterns lit at night, per village. A pool, for the reason every light pool exists. */
const LAMP_POOL = 3;
const LAMP_RANGE = 46;

/** Fixtures that hang against a wall rather than standing on the boundary line. */
const MOUNTED_KINDS: ReadonlySet<PieceKind> = new Set(['shelf', 'torch', 'lantern']);
/** How far back off the wall line a fixture's origin sits. Matches `BuildSite`. */
const MOUNT_OFF = 0.14;
/** Inside face of a wall, from the cell boundary: half its thickness plus a little clearance. */
const WALL_IN = 0.25;
/** Radius around a village centre the player may not build inside. Built-up area plus five. */
const VILLAGE_KEEP_OUT = 57;

/**
 * How many people live in a settlement.
 *
 * Declared here, with the village itself, because two separate things have to agree on it: the
 * crew of bodies that walks around, and the number of beds the houses must provide. They were
 * two literals in two files, which is how a village ends up with more villagers than beds.
 */
export const VILLAGE_POPULATION = 6;

/**
 * How far above a slot's own level the floor of that slot is.
 *
 * Ground floors are laid on `foundation`, whose deck is 0.42 m up; upper storeys are `floor`
 * at 0.3 m. Anything standing in a room has to be lifted by this or it is sunk into the
 * plinth — which is what happened to every bed and table in the first villages.
 */
function floorLift(s: { tier: number }): number {
  return s.tier === 0 ? PIECE_METRICS.foundationTop : PIECE_METRICS.floorTop;
}

/**
 * A slot on the building lattice: which piece, which cell, which storey, which way round.
 *
 * Expressed in *cells* rather than metres, exactly as the player's own placement is, so a
 * plan is readable and so two pieces meant to meet cannot miss each other by a rounding
 * error. `turn` is quarter turns; `tier` is storeys of half a cell, matching the tiers the
 * placement preview offers.
 */
/** Where a plan put its door, so somebody can stand outside it. */
interface DoorAt {
  /** Cell within the plan, and which of its four sides the door is on. */
  cx: number;
  cz: number;
  side: number;
}

interface Slot {
  kind: PieceKind;
  /** Cell coordinates, relative to the village centre. */
  cx: number;
  cz: number;
  /** Storeys above the pad, in units of half a cell — the same tier the player uses. */
  tier: number;
  turn: number;
  /** Sub-cell offset in metres, for the half-lattice furnishings. */
  ox?: number;
  oz?: number;
  /** Metres below the slot level, for anything hanging from a ceiling. */
  hang?: number;
}

/** Which timber a biome builds in, and what it roofs with. */
interface BiomeStyle {
  /** Wall piece for the ground floor. */
  wall: PieceKind;
  /** Roof piece. */
  roof: PieceKind;
  /** Window let into a wall. */
  window: PieceKind;
  /** Whether the settlement fences its plots. */
  fenced: boolean;
  /** How many farm plots, before size scaling. */
  farms: number;
  /** Tint multiplied into the village's own timber. */
  tint: number;
}

/**
 * Architecture per biome.
 *
 * The differences are made out of the piece library rather than out of new models, which
 * bounds what "a stone village" can mean here: what can actually vary is the wall kind, the
 * roof profile, the glazing, whether plots are fenced, how much farmland there is, and the
 * timber's tint. That is enough for a pine village and a savanna village to be recognisably
 * different at a glance, and it is honest about the fact that there is no stone wall piece.
 */
const STYLES: Record<BiomeId, BiomeStyle> = {
  // Nobody lives here; `villageSiteFor` refuses these, and the entries exist so the record
  // is total rather than because they are reachable.
  ocean: { wall: 'wall', roof: 'roofGable', window: 'windowOpen', fenced: false, farms: 0, tint: 0xffffff },
  beach: { wall: 'wall', roof: 'roofShed', window: 'windowOpen', fenced: false, farms: 1, tint: 0xf3e2c4 },
  snow: { wall: 'wall', roof: 'roofGable', window: 'windowGlass', fenced: true, farms: 0, tint: 0xd8dee8 },
  // Wetland: raised decks, open shutters, little farmland on soft ground.
  wetland: { wall: 'wall', roof: 'roofShed', window: 'windowOpen', fenced: false, farms: 1, tint: 0xbfd0b4 },
  // Jungle: steep roofs to shed rain, glazing against the insects.
  jungle: { wall: 'wall', roof: 'roofHip', window: 'windowVent', fenced: false, farms: 2, tint: 0xc9b394 },
  // Sakura: light timber, glazed windows, ornamental rather than agricultural.
  sakura: { wall: 'wall', roof: 'roofHip', window: 'windowGlass', fenced: true, farms: 2, tint: 0xf0dcd6 },
  // Meadow: the archetype. Gabled, glazed, well fenced, plenty of fields.
  meadow: { wall: 'wall', roof: 'roofGable', window: 'windowGlass', fenced: true, farms: 3, tint: 0xffffff },
  // Savanna: flat roofs against the sun, half walls for airflow, dry fields.
  savanna: { wall: 'wall', roof: 'roofFlat', window: 'windowOpen', fenced: true, farms: 2, tint: 0xe8cfa2 },
  // Pine: heavy gables for snow load, small glazed windows, few fields.
  pine: { wall: 'wall', roof: 'roofGable', window: 'windowGlass', fenced: true, farms: 1, tint: 0xcbbfae },
  // Highland: stone-grey timber, shed roofs braced against the wind.
  highland: { wall: 'wall', roof: 'roofShed', window: 'windowVent', fenced: true, farms: 1, tint: 0xc4c4c0 },
};

/** A building plan, in cells, with its own furniture. */
interface Plan {
  /** Footprint in cells. */
  w: number;
  d: number;
  /** Storeys. Two means walls at tier 0 and tier 2, with a floor between. */
  storeys: number;
  /** What the building is for, which decides its furniture and its sign of life. */
  role: 'home' | 'forge' | 'store' | 'workshop' | 'hall';
}

/**
 * The plan book.
 *
 * Sizes are in cells and every one is at least two by two, because a one-cell building is a
 * four-metre shed and reads as a crate. The hall is the only two-storey plan: stacking
 * storeys doubles a building's piece count, and a village of them costs more than the whole
 * rest of the settlement.
 */
const PLANS: readonly Plan[] = [
  { w: 2, d: 2, storeys: 1, role: 'home' },
  { w: 3, d: 2, storeys: 1, role: 'home' },
  { w: 2, d: 3, storeys: 1, role: 'home' },
  { w: 3, d: 3, storeys: 1, role: 'store' },
  { w: 2, d: 2, storeys: 1, role: 'forge' },
  { w: 3, d: 2, storeys: 1, role: 'workshop' },
  { w: 3, d: 3, storeys: 2, role: 'hall' },
];

/**
 * A place in a village somebody belongs to.
 *
 * Recorded while the layout is generated rather than searched for afterwards, because the
 * generator is the only thing that knows which building is a home and which is a forge — and
 * reverse-engineering that from placed geometry would be guessing at what it had just decided.
 */
export interface VillagePlace {
  x: number;
  y: number;
  z: number;
  /**
   * Outside the door, on the ground.
   *
   * Recorded separately from the centre because they are not interchangeable and treating
   * them as such is what made the first villagers walk into walls: a building's middle is
   * behind a wall, so anybody sent there arrives at the wall and stops. There is no interior
   * navigation here and there does not need to be — people stand at their doors.
   */
  doorX: number;
  doorZ: number;
  role: Plan['role'];
}

/** What a settlement offers whoever lives in it. */
export interface VillageInfo {
  key: string;
  x: number;
  y: number;
  z: number;
  /** Radius the settlement occupies, for wandering and for spawning animals. */
  radius: number;
  homes: VillagePlace[];
  works: VillagePlace[];
  /** The square, where everyone ends up in the evening. */
  centre: VillagePlace;
}

export interface VillageStreamer {
  group: Group;
  update(position: Vector3, elapsed: number): void;
  pump(deadline: number, force?: boolean): number;
  prime(position: Vector3, cells: number): void;
  /**
   * The loaded settlement nearest a point, or null. Villagers and livestock read this
   * rather than holding their own copy of the layout.
   */
  nearest(position: Vector3): VillageInfo | null;
  /**
   * The settlements' own collision, to be composed into the world's.
   *
   * Analytic boxes, not the circle registry � see `createPieceField` for why that mattered.
   */
  field: PieceField;
  /**
   * True where the player may not build: inside a settlement, plus a margin.
   *
   * A village is somebody else's, and letting a player drop a wall through the middle of one
   * is both rude and a way to make a house unenterable. Five metres of clearance outside the
   * built-up area, so you can build up against a village but never in it.
   */
  buildBlocked(x: number, z: number): boolean;
  /** Shows or hides the keep-out ring. Driven by whether build mode is open. */
  showBoundary(on: boolean): void;
  dispose(): void;
}

interface Built {
  key: string;
  cx: number;
  cz: number;
  root: Group;
  /** Fires and lamps in this village, in world space, for the light pool. */
  lamps: { x: number; y: number; z: number }[];
  /** Instanced meshes owned by this village, to be disposed with it. */
  meshes: InstancedMesh[];
  /** Null for an empty cell. */
  info: VillageInfo | null;
  /** This cell's own collision entries, kept so the shared field can be rebuilt on unload. */
  pieces: FieldPiece[];
}

/**
 * Lays out one building and returns its slots.
 *
 * Walls go on the perimeter edges, the front wall gets a door, the sides get windows, the
 * inside gets a floor and a roof. Written as a loop over the perimeter rather than as four
 * separate runs, because the corners are where a hand-written version goes wrong.
 */
function planBuilding(
  plan: Plan,
  style: BiomeStyle,
  rand: (n: number) => number,
  seed: number,
  /** Which side of the building faces the road. The door goes here. */
  facing: number,
  door: { at: DoorAt | null },
): Slot[] {
  const out: Slot[] = [];
  const { w, d, storeys } = plan;
  const push = (kind: PieceKind, cx: number, cz: number, tier: number, turn: number, ox = 0, oz = 0) =>
    out.push({ kind, cx, cz, tier, turn, ox, oz });

  /**
   * The door faces the road, and that is given rather than rolled.
   *
   * It used to be a random one of the four sides, which is half the "doors are on the wrong
   * side" report: a house fronting a street with its only door round the back is wrong however
   * plausible the randomness was. The caller knows which way the road is, because it chose the
   * plot by stepping off one.
   */
  const doorSide = facing;
  const doorAt = Math.floor(rand(seed + 2) * (doorSide % 2 === 0 ? d : w));

  for (let storey = 0; storey < storeys; storey++) {
    // Tiers are half-cells; a wall is a full cell tall, so a storey is two tiers.
    const tier = storey * 2;
    for (let ix = 0; ix < w; ix++) {
      for (let iz = 0; iz < d; iz++) {
        // Floor for every cell of every storey. The ground floor gets a foundation
        // instead, which is thicker and reads as a plinth.
        push(storey === 0 ? 'foundation' : 'floor', ix, iz, tier, 0);

        // Perimeter walls. `side` 0 = +X, 1 = +Z, 2 = -X, 3 = -Z, matching the edge
        // lattice's own numbering.
        const edges: [number, boolean][] = [
          [0, ix === w - 1],
          [1, iz === d - 1],
          [2, ix === 0],
          [3, iz === 0],
        ];
        for (const [side, onEdge] of edges) {
          if (!onEdge) continue;
          // Position along the wall this side runs down: sides 0 and 2 face along X, so they
          // run down Z and are indexed by iz. This was inverted, which put the door's index
          // on the wrong axis and so sometimes on no cell at all — a house with no door.
          const along = side % 2 === 0 ? iz : ix;
          let kind: PieceKind = style.wall;
          if (storey === 0 && side === doorSide && along === doorAt) {
            // An arch, never a shut leaf: villagers stand at their doors and a shut door is
            // solid, so a leaf here walls somebody out of their own house.
            kind = 'doorArch';
            door.at = { cx: ix, cz: iz, side };
          } else if (rand(seed + 20 + ix * 7 + iz * 13 + side) < 0.42) {
            kind = style.window;
          }
          push(kind, ix, iz, tier, side);
        }
      }
    }
  }

  /**
   * A ceiling under the roof, and a deck on top of it.
   *
   * Two separate things, and the first villages had neither. A `ceiling` closes the room from
   * the inside — its joists hang below the slot, which is the face you see from a room — and a
   * `roofFlat` above it is the weathered top with its own parapet.
   *
   * The pitched roofs are deliberately not used here, and that is worth being explicit about.
   * `roofGable`, `roofHip` and `roofShed` each carry a *complete* roof within one four-metre
   * cell: `roofGable` has both slopes and its own ridge. Tiled across a three-by-two building
   * that produces six separate little roofs with six ridges — a row of tents, with the
   * triangular `gable` piece then landing between them instead of at the ends. That is exactly
   * the "roofs wrong, corners wrong" report, and it is not a placement mistake I can correct
   * from here: tiling a pitched roof needs half-slope and ridge pieces that do not exist yet.
   * A flat deck is correct at any footprint, so villages use one until those pieces do exist.
   */
  const roofTier = storeys * 2;
  for (let ix = 0; ix < w; ix++) {
    for (let iz = 0; iz < d; iz++) {
      push('ceiling', ix, iz, roofTier, 0);
      push('roofFlat', ix, iz, roofTier, 0);
    }
  }

  /**
   * A flight of stairs, in anything with an upper storey.
   *
   * Reported as: a two-storey building, and no way to get up it. Correct — there was none. The
   * stairs occupy a cell of the ground floor and rise a full cell, which is exactly what the
   * piece does, and the cell above them gets no floor so there is a hole to come up through.
   * Placed in the last cell of the back row, out of the way of the door.
   */
  if (storeys > 1) {
    const sx = w - 1;
    const sz = 0;
    push('stairs', sx, sz, 0, 1);
    // The landing has to be open. Removing the upper floor over the stairwell is the only way
    // up: a floor there is a lid on the staircase.
    for (let i = out.length - 1; i >= 0; i--) {
      const s = out[i]!;
      if (s.kind === 'floor' && s.cx === sx && s.cz === sz && s.tier === 2) out.splice(i, 1);
    }
  }

  return out;
}

/**
 * Furniture for a building, by what it is for.
 *
 * Positions are given as a fraction of the *interior*, from 0 to 1 on each axis, and turned
 * into metres against the room's real bounds minus the piece's own half-size. That indirection
 * is the whole fix for "elements stick out past the walls": the first version placed furniture
 * at hand-picked sub-cell offsets like −1.9 m, which is ten centimetres from a cell boundary —
 * and a bed is 2.1 m long, so half of it went through the wall behind it. Nothing here can do
 * that, because a piece is inset by its own measured footprint before it is placed.
 */
function furnishBuilding(
  plan: Plan,
  rand: (n: number) => number,
  seed: number,
  /** Where the door ended up, so the way in can be kept clear. */
  doorAt: DoorAt | null,
): Slot[] {
  const out: Slot[] = [];
  const { w, d } = plan;
  const G = BUILD_GRID;
  /** Interior half-extents, inside the wall faces. */
  const roomHX = (w * G) / 2 - WALL_IN;
  const roomHZ = (d * G) / 2 - WALL_IN;

  /**
   * `fx`/`fz` are −1..1 across the room. The piece is then pulled in by its own size, so a
   * value of exactly −1 means "against that wall" for a bed as much as for a stool.
   */
  /**
   * Rectangles already claimed, in room coordinates, so nothing is placed on top of anything
   * else and nothing is placed in the way of the door.
   *
   * The previous version placed every item independently with no notion of what was already
   * there, which is why a bed could be inside a cupboard and why a chair could stand in a
   * doorway with the house then unenterable. A claim list is the smallest thing that cannot do
   * that: a piece that does not fit is simply not placed.
   */
  let claims: { x0: number; x1: number; z0: number; z1: number }[] = [];
  const fits = (x0: number, x1: number, z0: number, z1: number): boolean =>
    !claims.some((c) => x0 < c.x1 && x1 > c.x0 && z0 < c.z1 && z1 > c.z0);

  /** Claims a whole cell, used for the staircase and its landing. */
  const claimCell = (cx: number, cz: number): void => {
    const x = (cx - (w - 1) / 2) * G;
    const z = (cz - (d - 1) / 2) * G;
    claims.push({ x0: x - G / 2, x1: x + G / 2, z0: z - G / 2, z1: z + G / 2 });
  };

  /** The strip in front of the door, claimed before anything else so it stays walkable. */
  const clearDoorway = (): void => {
    if (!doorAt) return;
    const nx = doorAt.side === 0 ? 1 : doorAt.side === 2 ? -1 : 0;
    const nz = doorAt.side === 1 ? 1 : doorAt.side === 3 ? -1 : 0;
    // The door's own cell centre in room coordinates, then a 2 m wide, 2.4 m deep corridor
    // running inward from it.
    const cx = (doorAt.cx - (w - 1) / 2) * G;
    const cz = (doorAt.cz - (d - 1) / 2) * G;
    const doorX = cx + nx * (G / 2);
    const doorZ = cz + nz * (G / 2);
    const halfAcross = 1.1;
    const depth = 2.4;
    claims.push({
      x0: Math.min(doorX, doorX - nx * depth) - (nx === 0 ? halfAcross : 0),
      x1: Math.max(doorX, doorX - nx * depth) + (nx === 0 ? halfAcross : 0),
      z0: Math.min(doorZ, doorZ - nz * depth) - (nz === 0 ? halfAcross : 0),
      z1: Math.max(doorZ, doorZ - nz * depth) + (nz === 0 ? halfAcross : 0),
    });
  };

  /** Places a piece if it fits, and reports whether it did. */
  const put = (kind: PieceKind, fx: number, fz: number, turn = 0, tier = 0): boolean => {
    const fp = pieceFootprint(kind);
    // A turned piece presents its other axis to the wall.
    const halfX = turn % 2 === 0 ? fp.hx : fp.hz;
    const halfZ = turn % 2 === 0 ? fp.hz : fp.hx;
    const x = Math.max(-1, Math.min(1, fx)) * Math.max(0, roomHX - halfX);
    const z = Math.max(-1, Math.min(1, fz)) * Math.max(0, roomHZ - halfZ);
    // A rug is walked over, so it claims nothing and is blocked by nothing.
    if (kind !== 'rug') {
      if (!fits(x - halfX, x + halfX, z - halfZ, z + halfZ)) return false;
      claims.push({ x0: x - halfX, x1: x + halfX, z0: z - halfZ, z1: z + halfZ });
    }
    // Back to cell coordinates: the building's own origin is the corner of cell (0,0), whose
    // centre is at (0,0) in the plan's frame, so the room's middle is offset by half of it.
    const midX = ((w - 1) * G) / 2;
    const midZ = ((d - 1) * G) / 2;
    out.push({ kind, cx: 0, cz: 0, tier, turn, ox: midX + x, oz: midZ + z });
    return true;
  };

  // Everything sits on the half-cell lattice, offset from its cell's centre, so a table and
  // the stools round it line up with each other the way the player's own do.
  /**
   * How much furniture, scaled to the room.
   *
   * A three-by-two building is twice the floor of a two-by-two, and the first version gave
   * both the same four items — which is the "big buildings are empty inside" report. Sets
   * repeat along the long axis instead of being stretched.
   */
  const runs = Math.max(1, Math.floor(w / 2));
  /** Spreads `n` items evenly along the long axis, in −1..1. */
  const spread = (i: number, n: number): number => (n === 1 ? 0 : (i / (n - 1)) * 1.7 - 0.85);

  /**
   * Every storey gets furnished, not just the ground floor.
   *
   * "On the upper floor you again added nothing" was accurate: the layout ran once, at tier 0,
   * and a two-storey building was a furnished room with an empty loft over it. The layout is
   * now a function of the storey, so an upstairs is a bedroom or a store room depending on what
   * the building is for.
   *
   * Claims reset per storey — a table downstairs cannot block a bed upstairs — but the
   * staircase is claimed on *every* floor: it occupies a ground-floor cell, and the floor above
   * it is deliberately left open so there is a hole to come up through. Furniture in either
   * place would block the way up or hang over a void.
   */
  for (let storey = 0; storey < plan.storeys; storey++) {
    const tier = storey * 2;
    claims = [];
    if (plan.storeys > 1) claimCell(w - 1, 0);
    // Only the ground floor has a door to keep clear.
    if (storey === 0) clearDoorway();

    if (storey > 0) {
      // Upstairs. Sleeping quarters over a home or a hall, stores over a workplace.
      if (plan.role === 'home' || plan.role === 'hall') {
        for (let i = 0; i < runs; i++) put('bed', spread(i, runs), -1, 0, tier);
        for (let i = 0; i < runs; i++) put('bed', spread(i, runs), 1, 2, tier);
        put('cabinet', -1, 0, 1, tier);
        put('chest', 1, 0, 3, tier);
        put('rug', 0, 0, 0, tier);
      } else {
        for (let i = 0; i < runs * 2; i++) put('crate', spread(i, runs * 2), -1, 0, tier);
        for (let i = 0; i < runs; i++) put('barrel', spread(i, runs), 1, 0, tier);
        put('shelf', -1, 0, 1, tier);
        put('table', 0.5, 0.4, 0, tier);
      }
      continue;
    }

    switch (plan.role) {
      case 'home':
        // A bed per two metres of long wall, so a larger house sleeps more people rather than
        // being a bigger room with one bed in it.
        for (let i = 0; i < runs; i++) put('bed', spread(i, runs), -1, 0, tier);
        put('table', 0.55, 0.6, 0, tier);
        put('stool', 0.05, 0.6, 0, tier);
        put('stool', 0.95, 0.1, 0, tier);
        put('cabinet', -0.2, -1, 0, tier);
        put('rug', 0.2, 0.1, 0, tier);
        for (let i = 0; i < runs; i++) put('chest', spread(i, runs), 1, 0, tier);
        break;
      case 'forge':
        put('brazier', 0, -0.5, 0, tier);
        put('bench', -1, 0.7, 0, tier);
        for (let i = 0; i < runs + 1; i++) put('barrel', spread(i, runs + 1), 1, 0, tier);
        put('crate', 1, -1, 0, tier);
        put('table', 0.7, 0.2, 0, tier);
        break;
      case 'store':
        for (let i = 0; i < runs * 2; i++) {
          put('crate', spread(i, runs * 2), -1, 0, tier);
          put('barrel', spread(i, runs * 2), 1, 0, tier);
        }
        put('chest', -1, 0, 0, tier);
        put('table', 0.4, 0, 0, tier);
        break;
      case 'workshop':
        put('table', -0.4, -0.6, 0, tier);
        put('bench', -0.4, 0.4, 0, tier);
        for (let i = 0; i < runs; i++) put('crate', spread(i, runs), 1, 0, tier);
        put('chest', 1, -1, 0, tier);
        put('barrel', 1, 0.6, 0, tier);
        break;
      case 'hall':
        // A long table down the middle with benches either side, which is what a hall is.
        put('table', 0, 0, 0, tier);
        put('bench', 0, -0.55, 0, tier);
        put('bench', 0, 0.55, 0, tier);
        put('chair', -1, 0, 0, tier);
        put('chair', 1, 0, 0, tier);
        put('rug', 0, 0, 0, tier);
        for (let i = 0; i < runs; i++) put('barrel', spread(i, runs), -1, 0, tier);
        break;
    }
  }

  /**
   * Light inside, on a wall, always: a room you cannot see into is not somewhere anybody
   * lives.
   *
   * Fixtures are edge pieces, so they are pushed separately from the furniture — a fraction of
   * the room means nothing to something that hangs on a boundary. The lantern goes on the back
   * wall, which is the side opposite the door, so it is not behind you as you walk in.
   */
  /**
   * A lantern hanging from the ceiling of every storey, and a shelf on a wall.
   *
   * From the *ceiling*, which is what was asked for and what the player's own placement already
   * supports: a lantern was previously put on a wall bracket and read as floating in the middle
   * of the room. Hung means its top goes at the soffit and it drops below it, so the height is
   * the ceiling's level minus the model's own reach — the same arithmetic `hungHeight` does.
   */
  for (let storey = 0; storey < plan.storeys; storey++) {
    const ceilingTier = (storey + 1) * 2;
    const box = pieceFootprint('lantern');
    out.push({
      kind: 'lantern',
      cx: Math.floor(w / 2),
      cz: Math.floor(d / 2),
      tier: ceilingTier,
      turn: 0,
      // Hung from the soffit rather than resting on the slot: the ceiling's boards hang below
      // its own level, and the lantern hangs below those.
      hang: PIECE_METRICS.ceilDrop + box.top,
      ox: 0,
      oz: 0,
    });
  }
  if (rand(seed + 40) < 0.6) {
    out.push({ kind: 'shelf', cx: 0, cz: Math.floor(d / 2), tier: 0, turn: 2 });
  }
  return out;
}

export function createVillages(assets: AssetManager, registry: PropRegistry): VillageStreamer {
  const group = new Group();
  group.name = 'Villages';
  void registry;

  /**
   * One field for every settlement loaded at once.
   *
   * Rebuilt from scratch whenever a cell loads or unloads. That is cheap � at most a few
   * thousand entries, and it happens once per cell rather than per frame � and it avoids the
   * bookkeeping a per-cell field would need to answer a query that straddles two of them.
   */
  const field = createPieceField();
  /** Whether the keep-out ring is wanted this frame. */
  let showRing = false;

  const shared = pieceAssets(assets);
  const G = BUILD_GRID;

  /**
   * A per-village tint on the shared timber.
   *
   * The material is shared with the player's own building and with every other village, so
   * it cannot be recoloured in place. A clone per *style* rather than per village keeps the
   * count to one per biome, and because colour is a uniform and not a shader feature every
   * clone shares the compiled program with the original — the tint is free.
   */
  const tinted = new Map<number, { timber: MeshStandardMaterial; furnish: MeshStandardMaterial }>();
  const tintFor = (hex: number) => {
    let pair = tinted.get(hex);
    if (!pair) {
      const timber = shared.materials.timber.clone();
      timber.color.setHex(hex);
      const furnish = shared.materials.furnish.clone();
      furnish.color.setHex(hex).multiplyScalar(0.78);
      tinted.set(hex, (pair = { timber, furnish }));
    }
    return pair;
  };

  const loaded = new Map<string, Built>();
  const pending = new Map<string, { cx: number; cz: number; dist: number }>();
  // Namespaced: `PropRegistry.byOwner` is one flat map and the other streamers use their own
  // prefixes on different grids, so a bare `cx|cz` would let one layer delete another's
  // colliders.
  const key = (cx: number, cz: number): string => `village:${cx}|${cz}`;

  // Lamps are a pool for the same reason every other light in this project is: three.js
  // bakes the light count into every compiled program, so a light appearing changes the
  // count and recompiles the whole scene.
  const lamps: PointLight[] = [];
  for (let i = 0; i < LAMP_POOL; i++) {
    const light = new PointLight(0xffc070, 0, 18, 1.8);
    light.visible = true;
    light.castShadow = false;
    group.add(light);
    lamps.push(light);
  }

  /**
   * The keep-out boundary, drawn.
   *
   * A rule you cannot see is a rule that reads as a bug: the pieces turned red and there was
   * nothing to say why. One ring, moved and resized to whichever settlement is nearest, shown
   * only while build mode is on — it is a builder's guide, not scenery.
   *
   * A cylinder open at both ends rather than a flat disc, so it reads as a boundary you are
   * inside or outside of rather than as a mark on the ground, and it is visible from within the
   * village as well as from the approach. Additive and depth-write-free so it never occludes
   * anything and never fights the sort order.
   */
  const ringGeo = new CylinderGeometry(1, 1, 3.4, 72, 1, true);
  const ringMat = new MeshBasicMaterial({
    color: 0xff6a4a,
    transparent: true,
    opacity: 0.16,
    side: DoubleSide,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false,
  });
  const ring = new Mesh(ringGeo, ringMat);
  ring.visible = false;
  ring.renderOrder = 6;
  group.add(ring);

  const matrix = new Matrix4();
  const quat = new Quaternion();
  const pos = new Vector3();
  const one = new Vector3(1, 1, 1);
  const up = new Vector3(0, 1, 0);

  const buildCell = (cx: number, cz: number): void => {
    const k = key(cx, cz);
    if (loaded.has(k)) return;
    const site = villageSiteFor(cx, cz);
    if (!site) {
      // Recorded as loaded so an empty cell is not retried every frame.
      loaded.set(k, {
        key: k,
        cx,
        cz,
        root: new Group(),
        lamps: [],
        meshes: [],
        info: null,
        pieces: [],
      });
      return;
    }

    const rand = (n: number): number => cellRandom(cx * 61 + n, cz * 43 - n, 991);
    const biome = surfaceBiomeAt(site.x, site.z);
    const style = STYLES[biome];
    // The pad is level by construction, but read the drawn surface rather than the site's
    // own `y`: on the flat they agree exactly, and reading the surface is what guarantees a
    // building never floats when a distant chunk drops to a coarser LOD.
    const baseY = surfaceHeightAt(site.x, site.z);

    /**
     * Every slot in the village, gathered before anything is instanced.
     *
     * Two passes rather than one, because the instanced meshes have to be sized to what is
     * actually there — and because a slot map lets a later building refuse a cell an earlier
     * one already took, which is the difference between a plan and a pile.
     */
    const slots: Slot[] = [];
    const homes: VillagePlace[] = [];
    const works: VillagePlace[] = [];
    const taken = new Set<string>();
    const cellKey = (gx: number, gz: number) => `${gx}|${gz}`;
    /** Cells the roads run through, kept clear of buildings. */
    const roads = new Set<string>();

    // Village cells are measured from the centre in building cells. A settlement is laid out
    // around a square with two roads crossing it, which is what gives the buildings
    // something to front onto.
    const reach = 4 + Math.floor(site.size * 3);
    for (let i = -reach; i <= reach; i++) {
      roads.add(cellKey(i, 0));
      roads.add(cellKey(0, i));
    }
    // The square itself: a paved block at the crossing.
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        roads.add(cellKey(ix, iz));
        slots.push({ kind: 'foundation', cx: ix, cz: iz, tier: 0, turn: 0 });
        taken.add(cellKey(ix, iz));
      }
    }
    // A well-lit centre, and somewhere to sit.
    slots.push({ kind: 'campfire', cx: 0, cz: 0, tier: 0, turn: 0 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      slots.push({
        kind: 'bench',
        cx: Math.round(Math.cos(a) * 1.2),
        cz: Math.round(Math.sin(a) * 1.2),
        tier: 0,
        turn: i % 4,
        ox: 0,
        oz: 0,
      });
    }

    // Roads, as plain foundation slabs. Deliberately the same piece a player would use: a
    // road is a paved strip and there is no road piece, so it is paving.
    for (const r of roads) {
      if (taken.has(r)) continue;
      const [gx, gz] = r.split('|').map(Number) as [number, number];
      slots.push({ kind: 'foundation', cx: gx, cz: gz, tier: 0, turn: 0 });
      taken.add(r);
    }

    /**
     * Beds laid in this settlement, counted as they are placed.
     *
     * "There must be beds in every house — as many villagers as there are in the village, that
     * many beds." A bed is only placed if it fits, so the count cannot be assumed from the
     * number of houses: it has to be tallied and then topped up.
     */
    let bedTally = 0;

    /** Tries to fit a plan with its near edge on a road. Returns true when it lands. */
    const tryPlace = (plan: Plan, seed: number): boolean => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const turn = Math.floor(rand(seed + attempt * 3) * 4) % 4;
        // Pick a road cell to front onto, then step off the road by one cell.
        const alongRoad = Math.floor((rand(seed + attempt * 3 + 1) - 0.5) * 2 * reach);
        const onX = rand(seed + attempt * 3 + 2) < 0.5;
        const side = rand(seed + attempt * 3 + 3) < 0.5 ? 1 : -1;
        const w = turn % 2 === 0 ? plan.w : plan.d;
        const d = turn % 2 === 0 ? plan.d : plan.w;
        const originX = onX ? alongRoad : side * 2;
        const originZ = onX ? side * 2 : alongRoad;
        // Buildings sit on the far side of the verge, never on the road itself.
        const baseX = originX - (onX ? Math.floor(w / 2) : side > 0 ? 0 : w - 1);
        const baseZ = originZ - (onX ? (side > 0 ? 0 : d - 1) : Math.floor(d / 2));
        // Which of the building's four sides looks back at the road it was placed against.
        // Sides are 0 = +X, 1 = +Z, 2 = -X, 3 = -Z.
        const roadSide = onX ? (side > 0 ? 3 : 1) : side > 0 ? 2 : 0;

        let free = true;
        for (let ix = 0; ix < w && free; ix++) {
          for (let iz = 0; iz < d && free; iz++) {
            const ck = cellKey(baseX + ix, baseZ + iz);
            if (taken.has(ck) || roads.has(ck)) free = false;
            // Nothing may hang off the levelled pad: 62 m flat is fifteen cells, and a
            // building whose corner leaves the terrace sits on noise and floats.
            const wx = site.x + (baseX + ix) * G;
            const wz = site.z + (baseZ + iz) * G;
            if (Math.hypot(wx - site.x, wz - site.z) > 52) free = false;
            if (surfaceSlopeAt(wx, wz) > 0.08) free = false;
          }
        }
        if (!free) continue;

        for (let ix = 0; ix < w; ix++) {
          for (let iz = 0; iz < d; iz++) taken.add(cellKey(baseX + ix, baseZ + iz));
        }
        // Turn the plan's own layout into village cells. The plan is written in its own
        // frame, so a quarter turn swaps the axes and mirrors one of them.
        const rotated = { ...plan, w, d };
        const door: { at: DoorAt | null } = { at: null };
        const inner = [
          // The side facing the road: the plot was chosen by stepping off one, so `onX` and
          // `side` between them say which way that is. The door goes there.
          ...planBuilding(rotated, style, rand, seed + 100, roadSide, door),
          ...furnishBuilding(rotated, rand, seed + 200, door.at),
        ];
        for (const s of inner) {
          slots.push({ ...s, cx: baseX + s.cx, cz: baseZ + s.cz });
          if (s.kind === 'bed') bedTally++;
        }
        // Record what this building is for and where its middle is, so somebody can live or
        // work in it. Taken from the plan while it is being laid out — the only moment
        // anything knows the difference between a home and a forge.
        const midX = site.x + (baseX + (w - 1) / 2) * G;
        const midZ = site.z + (baseZ + (d - 1) / 2) * G;
        // The doorstep: the door's own cell, half a cell out to its boundary, and another
        // 1.4 m clear of it so somebody standing there is outside the wall rather than in it.
        let doorX = midX;
        let doorZ = midZ;
        if (door.at) {
          const nx = door.at.side === 0 ? 1 : door.at.side === 2 ? -1 : 0;
          const nz = door.at.side === 1 ? 1 : door.at.side === 3 ? -1 : 0;
          doorX = site.x + (baseX + door.at.cx) * G + nx * (G / 2 + 1.4);
          doorZ = site.z + (baseZ + door.at.cz) * G + nz * (G / 2 + 1.4);
        }
        const place: VillagePlace = {
          x: midX,
          y: baseY,
          z: midZ,
          doorX,
          doorZ,
          role: plan.role,
        };
        if (plan.role === 'home') homes.push(place);
        else works.push(place);
        return true;
      }
      return false;
    };

    // The hall first, at the centre, then homes and workplaces outward. Order matters: the
    // largest plan has the least room to fit, so giving it first refusal is what stops a
    // village from being all cottages.
    const wanted = 4 + Math.floor(site.size * 5);
    tryPlace(PLANS[6]!, 300);
    let placedCount = 1;
    for (let i = 0; i < wanted * 3 && placedCount < wanted; i++) {
      const pick = Math.floor(rand(400 + i) * 6) % 6;
      if (tryPlace(PLANS[pick]!, 500 + i * 17)) placedCount++;
    }

    /**
     * Enough beds for everyone who lives here.
     *
     * The crew is a fixed size, so the settlement keeps taking homes until it has at least that
     * many beds. Bounded, because a small terrace can genuinely run out of plots — and in that
     * case fewer beds is the honest outcome rather than a hang.
     */
    for (let i = 0; i < 24 && bedTally < VILLAGE_POPULATION; i++) {
      // Plans 0..2 are the homes, and they are the small footprints, so they still fit when
      // the roadside is mostly taken.
      const home = PLANS[i % 3]!;
      if (tryPlace(home, 900 + i * 23)) placedCount++;
    }

    // Farm plots: planters in rows, fenced if the biome fences.
    const farms = Math.round(style.farms * (0.6 + site.size));
    for (let f = 0; f < farms; f++) {
      const a = rand(700 + f) * Math.PI * 2;
      const rad = 6 + Math.floor(rand(710 + f) * 4);
      const fx = Math.round(Math.cos(a) * rad);
      const fz = Math.round(Math.sin(a) * rad);
      let free = true;
      for (let ix = 0; ix < 2 && free; ix++) {
        for (let iz = 0; iz < 2 && free; iz++) {
          const ck = cellKey(fx + ix, fz + iz);
          if (taken.has(ck) || roads.has(ck)) free = false;
          if (Math.hypot((fx + ix) * G, (fz + iz) * G) > 52) free = false;
        }
      }
      if (!free) continue;
      for (let ix = 0; ix < 2; ix++) {
        for (let iz = 0; iz < 2; iz++) {
          taken.add(cellKey(fx + ix, fz + iz));
          // Four planters to a cell, on the half lattice.
          for (const [ox, oz] of [
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
          ]) {
            slots.push({ kind: 'planter', cx: fx + ix, cz: fz + iz, tier: 0, turn: 0, ox, oz });
          }
          if (style.fenced) {
            // Rail the outside edges only, so a plot is enclosed but reachable.
            if (ix === 0) slots.push({ kind: 'railing', cx: fx, cz: fz + iz, tier: 0, turn: 2 });
            if (ix === 1) slots.push({ kind: 'railing', cx: fx + 1, cz: fz + iz, tier: 0, turn: 0 });
            if (iz === 0) slots.push({ kind: 'railing', cx: fx + ix, cz: fz, tier: 0, turn: 3 });
            if (iz === 1) slots.push({ kind: 'railing', cx: fx + ix, cz: fz + 1, tier: 0, turn: 1 });
          }
        }
      }
    }

    /**
     * Street lighting, and fences to walk between.
     *
     * Braziers rather than torches: a torch is a wall fixture, and stood in the open with
     * nothing behind it, it is a bracket floating over the paving — which is exactly what the
     * first villages looked like. A brazier is a standing fire bowl and reads correctly on its
     * own.
     *
     * No fencing along the roads any more, and that is a retraction. Railings lining both
     * verges with a gap only every third cell walled the houses off from the street: the report
     * "I cannot get into the village" was literally true, because every route from a road to a
     * front door crossed a solid fence. Fences belong round the farm plots, which is where they
     * are now, and a street wants to be open.
     */
    for (let i = -reach; i <= reach; i++) {
      if (Math.abs(i) < 2) continue;
      if (i % 3 === 0) {
        // Lamps at the roadside, offset onto the verge so they are not underfoot.
        slots.push({ kind: 'brazier', cx: i, cz: 0, tier: 0, turn: 0, ox: 0, oz: 1.6 });
        slots.push({ kind: 'brazier', cx: 0, cz: i, tier: 0, turn: 0, ox: 1.6, oz: 0 });
      }
    }
    for (let i = 0; i < 5; i++) {
      const a = rand(800 + i) * Math.PI * 2;
      const rad = 2 + rand(810 + i) * 3;
      slots.push({
        kind: rand(820 + i) < 0.5 ? 'barrel' : 'crate',
        cx: Math.round(Math.cos(a) * rad),
        cz: Math.round(Math.sin(a) * rad),
        tier: 0,
        turn: Math.floor(rand(830 + i) * 4) % 4,
        ox: 0.5,
        oz: 0.5,
      });
    }

    /**
     * Which cells actually got a deck laid.
     *
     * Its own pass over the finished slot list, deliberately, rather than being filled during
     * the instancing loop: that loop walks the slots grouped by kind, so a chair could be
     * positioned long before the floor it stands on was seen, and the answer would depend on
     * the order the kinds happened to come out of the map.
     */
    const paved = new Set<string>();
    const cellKeyOf = cellKey;
    for (const s of slots) {
      if (s.kind === 'foundation' || s.kind === 'floor') paved.add(cellKeyOf(s.cx, s.cz));
    }

    // ---- Instancing -------------------------------------------------------------------
    // One mesh per kind per village, sized to what the plan actually produced. A village is
    // then thirty-odd draw calls however many buildings it has, and a village out of range is
    // zero because the whole thing is disposed with the cell.
    const byKind = new Map<PieceKind, Slot[]>();
    for (const s of slots) {
      let list = byKind.get(s.kind);
      if (!list) byKind.set(s.kind, (list = []));
      if (list.length < MAX_PER_KIND) list.push(s);
    }

    const root = new Group();
    root.name = `Village:${cx}|${cz}`;
    /** This cell's collision entries, so the shared field can be rebuilt when it unloads. */
    const pieces: FieldPiece[] = [];
    const meshes: InstancedMesh[] = [];
    const lampSpots: { x: number; y: number; z: number }[] = [];
    const mats = tintFor(style.tint);

    for (const [kind, list] of byKind) {
      const geo = shared.geometries[kind];
      if (!geo) continue;
      const lattice = latticeOf(kind);
      const addLayer = (g: BufferGeometry | undefined, mat: MeshStandardMaterial, casts: boolean, order?: number) => {
        if (!g) return null;
        const mesh = new InstancedMesh(g, mat, list.length);
        mesh.count = list.length;
        mesh.castShadow = casts;
        mesh.receiveShadow = casts;
        mesh.frustumCulled = true;
        mesh.name = `Village:${kind}`;
        if (order !== undefined) mesh.renderOrder = order;
        root.add(mesh);
        meshes.push(mesh);
        return mesh;
      };
      const isFurnish = shared.furnished.has(kind);
      const bodyMat =
        kind === 'rug' ? shared.materials.cloth : isFurnish ? mats.furnish : mats.timber;
      const timber = addLayer(geo.timber, bodyMat, true);
      const glass = addLayer(geo.glass, shared.materials.glass, false, 3);
      const glow = addLayer(geo.glow, shared.materials.glow, false, 4);

      for (let i = 0; i < list.length; i++) {
        const s = list[i]!;
        const cellX = site.x + s.cx * G;
        const cellZ = site.z + s.cz * G;
        let y = baseY + s.tier * (G / 2);
        let turn = s.turn;
        let px = cellX + (s.ox ?? 0);
        let pz = cellZ + (s.oz ?? 0);

        if (s.hang !== undefined) {
          // Hanging from a ceiling: measured down from the slot, not up from a floor. Checked
          // before the lattice, because a lantern is an edge piece and would otherwise be
          // pushed onto a wall by the branch below.
          y -= s.hang;
        } else if (lattice === 'edge') {
          /**
           * Edge pieces stand on a cell *boundary*, and getting this wrong is why the first
           * villages had no walls, no doors and no fences at all.
           *
           * The geometry is modelled centred on its own origin — a wall runs four metres
           * along local X and is a fifth of a metre thick in local Z — so the origin has to
           * be moved half a cell out to the boundary, and the piece turned so its length
           * runs along that boundary. Placed at the cell's centre with the side index used
           * directly as a rotation, as it was, every wall in the village ended up lying
           * inside its own floor slab: from outside a house you saw paving and a roof with
           * nothing between them.
           *
           * This is exactly what `BuildSite.snap` does for the edge lattice. The rotation is
           * *not* the side index: sides 0 and 2 face along X, so the piece is turned a
           * quarter to run along Z, while sides 1 and 3 are already aligned.
           */
          const nx = s.turn === 0 ? 1 : s.turn === 2 ? -1 : 0;
          const nz = s.turn === 1 ? 1 : s.turn === 3 ? -1 : 0;
          px = cellX + nx * (G / 2);
          pz = cellZ + nz * (G / 2);
          turn = s.turn === 0 || s.turn === 2 ? 1 : 0;

          if (MOUNTED_KINDS.has(kind)) {
            // A fixture stands *against* the wall rather than on the line, pushed back into
            // the room by the wall's own half-thickness and turned to face inward — its
            // local +Z is the side its bracket sticks out of.
            px -= nx * MOUNT_OFF;
            pz -= nz * MOUNT_OFF;
            turn = s.turn === 0 ? 3 : s.turn === 1 ? 2 : s.turn === 2 ? 1 : 0;
            // Chest height on the wall, not at its foot.
            y += s.tier === 0 ? floorLift(s) : 0;
          }
        } else if (lattice === 'corner') {
          px = cellX + G / 2 + (s.ox ?? 0);
          pz = cellZ + G / 2 + (s.oz ?? 0);
        } else if (lattice === 'quarter') {
          /**
           * Furnishings sit *on* the floor of the room, not at the slot's own level.
           *
           * A floor piece's walking surface is above its origin — 0.42 m for a foundation,
           * 0.3 m for a floor — so furniture placed at the bare slot level is buried in the
           * plinth up to its knees. Every bed and table in the first villages was.
           *
           * But only where there *is* a deck. Outdoor clutter round the square was being lifted
           * by a foundation's thickness whether or not that cell was paved, which is the
           * "barrels and stools hovering above the ground" report. The paved set is the record
           * of what was actually laid, so the lift is looked up rather than assumed.
           */
          if (paved.has(cellKeyOf(s.cx, s.cz)) || s.tier > 0) y += floorLift(s);
        }

        pos.set(px, y, pz);
        quat.setFromAxisAngle(up, (turn * Math.PI) / 2);
        matrix.compose(pos, quat, one);
        timber?.setMatrixAt(i, matrix);
        glass?.setMatrixAt(i, matrix);
        glow?.setMatrixAt(i, matrix);

        if (kind === 'lantern' || kind === 'torch' || kind === 'campfire') {
          lampSpots.push({ x: pos.x, y: pos.y + 1.6, z: pos.z });
        }
        // Walls, doors and windows are what you bump into. Registered as a short row of
        // circles along the piece, because the registry holds circles and a wall is four
        // metres long by a fifth thick — one circle covering its length would stop you two
        // metres out from it in every direction.
        /**
         * Decks are registered as standable ground, and this is the fix for the report that
         * your own furniture falls through a village floor.
         *
         * The player's placement preview asks the world how high the ground is, and the world
         * answers from the terrain plus the prop registry. A village's floors were in neither:
         * they are instanced geometry with no collider at all. So standing on a paved square,
         * the answer was the *terrain*, half a metre below the paving — and anything placed
         * went there, under the deck. The same absence is why you could walk through a
         * village floor.
         *
         * One circle per cell, `top` at the deck. `r` is a little over half a cell so that the
         * registry's own 0.85 factor still covers the whole square; `solid` is false because a
         * floor is something you stand on, not something you bump into.
         */
        /**
         * Collision, through the analytic piece field rather than the circle registry.
         *
         * Every kind, one entry, with its real shape read from the same description the
         * player's own building uses. This replaces a row of circles per wall, and it is the
         * fix for three separate reports at once: walls that stopped you a metre out, doorways
         * that felt shut, and — the worst — being teleported onto the roof on walking through a
         * door, which happened because the registry's `floorHeightAt` takes the highest `top`
         * over a point with no notion of how high the asker is, so a ceiling registered as a
         * deck always won.
         *
         * Rugs are skipped: they have no solid part and no surface worth standing on, and a
         * field entry for one is work for nothing.
         */
        if (kind !== 'rug') {
          const entry: FieldPiece = { kind, x: px, z: pz, level: y, turn };
          pieces.push(entry);
          field.add(entry);
        }
      }
      timber?.instanceMatrix.setUsage(35044);
      if (timber) timber.instanceMatrix.needsUpdate = true;
      if (glass) glass.instanceMatrix.needsUpdate = true;
      if (glow) glow.instanceMatrix.needsUpdate = true;
      timber?.computeBoundingSphere();
      glass?.computeBoundingSphere();
      glow?.computeBoundingSphere();
    }

    group.add(root);
    loaded.set(k, {
      key: k,
      cx,
      cz,
      root,
      lamps: lampSpots,
      meshes,
      pieces,
      info: {
        key: k,
        x: site.x,
        y: baseY,
        z: site.z,
        radius: reach * G,
        homes,
        works,
        centre: {
          x: site.x,
          y: baseY,
          z: site.z,
          // The square is open ground, so its "doorstep" is the square itself.
          doorX: site.x,
          doorZ: site.z,
          role: 'hall',
        },
      },
    });
  };

  const nearest_ = (position: Vector3): VillageInfo | null => {
    let best: VillageInfo | null = null;
    let bestD2 = Infinity;
    for (const cell of loaded.values()) {
      if (!cell.info) continue;
      const d2 = (cell.info.x - position.x) ** 2 + (cell.info.z - position.z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = cell.info;
      }
    }
    return best;
  };

  const dropCell = (cell: Built): void => {
    group.remove(cell.root);
    // Only the instance buffers: the geometry and the materials are the shared library's,
    // and disposing them here would strip every other village and the player's own site.
    for (const mesh of cell.meshes) mesh.dispose();
    loaded.delete(cell.key);
    rebuildField();
  };

  /**
   * Rebuilds the shared collision field from every loaded cell.
   *
   * Wholesale rather than removing one cell's entries, because the field buckets by column and
   * a settlement straddles many of them — tracking which entry went in which bucket to take it
   * out again is bookkeeping for a rebuild that costs a few thousand array pushes and happens
   * only when a cell loads or unloads, never per frame.
   */
  const rebuildField = (): void => {
    field.clear();
    for (const cell of loaded.values()) {
      for (const piece of cell.pieces) field.add(piece);
    }
  };

  const nearest: { d2: number; x: number; y: number; z: number }[] = [];

  const update = (position: Vector3, elapsed: number): void => {
    const pcx = Math.floor(position.x / VILLAGE_CELL);
    const pcz = Math.floor(position.z / VILLAGE_CELL);
    for (let dz = -VIEW_CELLS; dz <= VIEW_CELLS; dz++) {
      for (let dx = -VIEW_CELLS; dx <= VIEW_CELLS; dx++) {
        const k = key(pcx + dx, pcz + dz);
        if (loaded.has(k) || pending.has(k)) continue;
        pending.set(k, { cx: pcx + dx, cz: pcz + dz, dist: dx * dx + dz * dz });
      }
    }
    for (const cell of [...loaded.values()]) {
      const ring = Math.max(Math.abs(cell.cx - pcx), Math.abs(cell.cz - pcz));
      if (ring > VIEW_CELLS + 1) dropCell(cell);
    }
    for (const [k, want] of [...pending]) {
      const ring = Math.max(Math.abs(want.cx - pcx), Math.abs(want.cz - pcz));
      if (ring > VIEW_CELLS + 1) pending.delete(k);
    }

    // Hand the lamp pool to the nearest lights in the nearest village.
    nearest.length = 0;
    for (const cell of loaded.values()) {
      for (const l of cell.lamps) {
        const d2 = (l.x - position.x) ** 2 + (l.z - position.z) ** 2;
        if (d2 > LAMP_RANGE * LAMP_RANGE) continue;
        nearest.push({ d2, ...l });
      }
    }
    // The keep-out ring follows the nearest settlement, and only while building.
    const near = nearest_(position);
    if (showRing && near) {
      ring.visible = true;
      ring.position.set(near.x, near.y + 1.7, near.z);
      ring.scale.set(VILLAGE_KEEP_OUT, 1, VILLAGE_KEEP_OUT);
    } else {
      ring.visible = false;
    }

    nearest.sort((a, b) => a.d2 - b.d2);
    for (let i = 0; i < lamps.length; i++) {
      const light = lamps[i]!;
      const spot = nearest[i];
      if (!spot) {
        light.intensity = 0;
        continue;
      }
      light.position.set(spot.x, spot.y, spot.z);
      const flicker = Math.sin(elapsed * 9 + spot.x) * 0.12;
      light.intensity = 13 * (1 + flicker);
    }
  };

  const pump = (deadline: number, force = true): number => {
    if (pending.size === 0) return 0;
    const queue = [...pending.entries()].sort((a, b) => a[1].dist - b[1].dist);
    // Clock only, no count cap: a cell is either a whole settlement or empty, so a count
    // would mean nothing either way. `force` lets one build start past the deadline.
    for (let i = 0; i < queue.length; i++) {
      if ((i > 0 || !force) && performance.now() >= deadline) break;
      const [k, want] = queue[i]!;
      pending.delete(k);
      buildCell(want.cx, want.cz);
    }
    return pending.size;
  };

  const prime = (position: Vector3, cells: number): void => {
    const pcx = Math.floor(position.x / VILLAGE_CELL);
    const pcz = Math.floor(position.z / VILLAGE_CELL);
    for (let dz = -cells; dz <= cells; dz++) {
      for (let dx = -cells; dx <= cells; dx++) {
        buildCell(pcx + dx, pcz + dz);
        pending.delete(key(pcx + dx, pcz + dz));
      }
    }
  };

  const dispose = (): void => {
    for (const cell of [...loaded.values()]) dropCell(cell);
    pending.clear();
    for (const pair of tinted.values()) {
      pair.timber.dispose();
      pair.furnish.dispose();
    }
    tinted.clear();
    ringGeo.dispose();
    ringMat.dispose();
    group.remove(ring);
    for (const light of lamps) group.remove(light);
    lamps.length = 0;
  };

  /**
   * Asked of every placement preview, so it reads the deterministic site function rather than
   * the loaded set: a village one cell away is still somewhere you may not build, even before
   * its houses have streamed in.
   */
  const buildBlocked = (x: number, z: number): boolean => {
    const vx = Math.floor(x / VILLAGE_CELL);
    const vz = Math.floor(z / VILLAGE_CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const site = villageSiteFor(vx + dx, vz + dz);
        if (!site) continue;
        if (Math.hypot(x - site.x, z - site.z) < VILLAGE_KEEP_OUT) return true;
      }
    }
    return false;
  };

  return {
    group,
    update,
    pump,
    prime,
    nearest: nearest_,
    field,
    buildBlocked,
    showBoundary: (on) => {
      showRing = on;
    },
    dispose,
  };
}

/** Metrics the diagnostics read. Exported so a probe can assert on layout, not pixels. */
export const VILLAGE_METRICS = {
  cell: VILLAGE_CELL,
  plans: PLANS.length,
  maxPerKind: MAX_PER_KIND,
  metrics: PIECE_METRICS,
} as const;
