import {
  cellRandom,
  riverAt,
  SURFACE_STEP,
  surfaceHeightAt,
  surfaceSlopeAt,
  WORLD,
} from './WorldGen.ts';

/**
 * WaterfallSites
 * --------------
 * Finds where the rivers fall off the cliffs.
 *
 * This is deliberately pure maths with no three.js in it, for the same reason
 * `WorldGen` is: the visuals, the diagnostics and anything that later wants to
 * put a sound or a rainbow at the bottom of a fall all have to agree on where
 * the falls *are*, and the only way to guarantee that is for there to be exactly
 * one definition. `Waterfalls.ts` renders what this returns and decides nothing.
 *
 * Nothing here invents terrain. A waterfall is a consequence of two things the
 * generator already does — `riverAt` says where the water runs, and the
 * escarpments in `baseElevationAt` put steep faces across it — so the search is
 * for the intersection: a point in a channel where the ground ahead drops away
 * faster than water could run down it.
 *
 * Everything is measured on the *drawn* surface (`surfaceHeightAt`), never on the
 * analytic field. A sheet of water hung off the analytic curve would float in
 * front of the cliff, or vanish into it, by up to a metre — which is the same
 * mistake that used to leave campfires hovering.
 */

/** Streaming chunk for waterfalls. Matches the terrain chunk. */
export const WATERFALL_CHUNK = 256;

/** Candidate spacing inside a chunk. A multiple of `SURFACE_STEP` by design. */
const SCAN_STEP = 16;
/** How far into a channel a point has to be before it can carry a fall. */
const MIN_FLOW = 0.28;
/** Gradient at the lip that makes it a cliff rather than a rapid (~42°). */
const LIP_GRADE = 0.9;
/** Gradient the face has to keep while the drop is being measured (~40°). */
const FACE_GRADE = 0.85;
/** Shortest fall worth drawing. Below this it is white water, not a waterfall. */
const MIN_DROP = 7.5;
/** How far down the face the walk will follow, in lattice steps. */
const MAX_STEPS = 8;
/** Two lips closer together than this are one waterfall. */
const MIN_SPACING = 44;
/** A fall needs somewhere to fall from. */
const MIN_LIP_HEIGHT = WORLD.waterLevel + 8;

export interface WaterfallSite {
  /** The lip: where the water leaves the rock. */
  x: number;
  z: number;
  topY: number;
  /** The plunge point at the foot of the face. */
  bottomX: number;
  bottomZ: number;
  bottomY: number;
  /** Total fall in metres. */
  drop: number;
  /** Width of the sheet in metres, measured across the channel. */
  width: number;
  /** Downstream heading: `(sin, cos)` is the horizontal flow direction. */
  heading: number;
  /** Deterministic 0..1, for per-fall variation in the shader. */
  seed: number;
}

/** Scratch for the downhill direction, so the scan allocates nothing. */
const dir = { x: 0, z: 0, grade: 0 };

/** Fills `dir` with the downhill unit vector and the gradient magnitude. */
function downhill(x: number, z: number): void {
  const s = SURFACE_STEP;
  const dx = (surfaceHeightAt(x + s, z) - surfaceHeightAt(x - s, z)) / (2 * s);
  const dz = (surfaceHeightAt(x, z + s) - surfaceHeightAt(x, z - s)) / (2 * s);
  const mag = Math.hypot(dx, dz);
  dir.grade = mag;
  if (mag < 1e-6) {
    dir.x = 0;
    dir.z = 0;
    return;
  }
  // Downhill is the negative gradient.
  dir.x = -dx / mag;
  dir.z = -dz / mag;
}

/**
 * Steepness × flow at a point. Used only to compare a candidate against its
 * neighbours, so a long cliff produces one fall at its steepest crossing instead
 * of one every scan step. Deriving it from world coordinates alone is what keeps
 * that decision the same whichever chunk happens to be looking at it.
 */
function lipScore(x: number, z: number): number {
  const flow = riverAt(x, z);
  if (flow < MIN_FLOW * 0.8) return 0;
  return flow * surfaceSlopeAt(x, z);
}

/**
 * Width of the sheet, from how much water the channel is carrying at the lip.
 *
 * An earlier version measured the channel by walking outward until `riverAt`
 * fell below a contour. That is the honest way to size a river and the wrong way
 * to size a waterfall: the carve is a valley two hundred metres across, so every
 * fall came back at the clamp. What the eye reads as the width of a fall is the
 * fast core of the stream, and that tracks the flow.
 */
function sheetWidth(flow: number, seed: number): number {
  return (7 + flow * 15) * (0.85 + seed * 0.3);
}

/**
 * Follows the face downhill from a lip and returns the site, or null when the
 * drop turns out to be too short to be worth drawing.
 */
function measure(x: number, z: number): WaterfallSite | null {
  const topY = surfaceHeightAt(x, z);
  if (topY < MIN_LIP_HEIGHT) return null;

  downhill(x, z);
  if (dir.grade < LIP_GRADE) return null;
  const heading = Math.atan2(dir.x, dir.z);
  const seed = cellRandom(Math.round(x), Math.round(z), 8123);
  const width = sheetWidth(riverAt(x, z), seed);

  let px = x;
  let pz = z;
  let py = topY;
  for (let step = 0; step < MAX_STEPS; step++) {
    const nx = px + dir.x * SURFACE_STEP;
    const nz = pz + dir.z * SURFACE_STEP;
    const ny = surfaceHeightAt(nx, nz);
    // Stop the moment the ground stops falling away: that is the plunge pool.
    if (ny >= py - FACE_GRADE * SURFACE_STEP) break;
    px = nx;
    pz = nz;
    py = ny;
    // Keep following the face rather than the straight line off the lip, so a
    // fall that curves down a gully stays attached to it.
    downhill(px, pz);
    if (dir.grade < FACE_GRADE) break;
  }

  const drop = topY - py;
  if (drop < MIN_DROP) return null;
  // Falling, not merely running downhill fast. The sheet is drawn as a flat quad
  // between the lip and the pool, so a shallow cascade that wanders across 60 m
  // of hillside would have the water cutting straight through the rock.
  const run = Math.hypot(px - x, pz - z);
  if (run > drop * 0.85) return null;

  return {
    x,
    z,
    topY,
    bottomX: px,
    bottomZ: pz,
    // The pool cannot be below the sea.
    bottomY: Math.max(py, WORLD.waterLevel),
    drop,
    width,
    heading,
    seed,
  };
}

const chunkCache = new Map<number, WaterfallSite[]>();

/**
 * Every waterfall whose lip lies inside one chunk. Deterministic, memoised, and
 * keyed on the chunk so the streamer and the diagnostics see the same list.
 */
export function waterfallSitesInChunk(cx: number, cz: number): WaterfallSite[] {
  const key = cx * 8192 + cz;
  const hit = chunkCache.get(key);
  if (hit) return hit;

  const out: WaterfallSite[] = [];
  const originX = cx * WATERFALL_CHUNK;
  const originZ = cz * WATERFALL_CHUNK;
  const steps = WATERFALL_CHUNK / SCAN_STEP;

  for (let iz = 0; iz < steps; iz++) {
    for (let ix = 0; ix < steps; ix++) {
      const x = originX + ix * SCAN_STEP;
      const z = originZ + iz * SCAN_STEP;
      if (Math.abs(x) > WORLD.halfSize - 60 || Math.abs(z) > WORLD.halfSize - 60) continue;

      const flow = riverAt(x, z);
      if (flow < MIN_FLOW) continue;

      // Only the steepest crossing of a cliff gets the fall. Without this a long
      // escarpment sprouts a curtain of them every 16 m.
      const score = flow * surfaceSlopeAt(x, z);
      if (score <= 0) continue;
      if (
        score < lipScore(x + SCAN_STEP, z) ||
        score < lipScore(x - SCAN_STEP, z) ||
        score < lipScore(x, z + SCAN_STEP) ||
        score < lipScore(x, z - SCAN_STEP)
      ) {
        continue;
      }

      const site = measure(x, z);
      if (!site) continue;

      // Chunk-local guard for the case the neighbour test cannot see: two
      // separate crests of the same cliff a few metres apart.
      let tooClose = false;
      for (const other of out) {
        if (Math.hypot(other.x - site.x, other.z - site.z) < MIN_SPACING) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      out.push(site);
    }
  }

  if (chunkCache.size > 4000) chunkCache.clear();
  chunkCache.set(key, out);
  return out;
}

/** Drops the memo. Called when the exterior scene is torn down. */
export function resetWaterfallSites(): void {
  chunkCache.clear();
}
