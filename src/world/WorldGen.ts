import { Color } from 'three';

/**
 * WorldGen
 * --------
 * The single source of truth for what the open world looks like at any point.
 * It is pure maths — no three.js objects, no state — so terrain chunks,
 * vegetation scattering, points of interest and gameplay collision all agree
 * with each other and can be evaluated lazily as the player streams around.
 *
 * Layout is driven by three independent fields, Minecraft-style:
 *   • elevation  — continents, mountain ridges, valleys
 *   • temperature — cold at altitude and toward the poles of the map
 *   • moisture   — wet coasts and river basins, dry interiors
 * The biome is then looked up from (temperature, moisture, elevation).
 */

export const WORLD = {
  /** Half-extent in metres. The world spans 2× this on each axis. */
  halfSize: 3000,
  waterLevel: 6,
  /** Flat, buildable area around the spawn portal. */
  plazaRadius: 55,
  plazaHeight: 14,
  /** Anything above this is bare rock and snow. */
  snowLine: 118,
  treeLine: 96,
} as const;

export type BiomeId =
  | 'ocean'
  | 'beach'
  | 'wetland'
  | 'jungle'
  | 'sakura'
  | 'meadow'
  | 'savanna'
  | 'pine'
  | 'highland'
  | 'snow';

export interface BiomeStyle {
  id: BiomeId;
  /** Ground colours: low/base, mid, and the tint used on steep slopes. */
  ground: Color;
  groundAlt: Color;
  rock: Color;
  /** Density multipliers for scattering, 0..1-ish. */
  trees: number;
  bushes: number;
  grass: number;
  rocks: number;
  flowers: number;
  /** Which tree palette this biome scatters. */
  treeKind: 'jungle' | 'palm' | 'sakura' | 'pine' | 'acacia' | 'dead' | 'none';
}

const BIOMES: Record<BiomeId, BiomeStyle> = {
  ocean: {
    id: 'ocean',
    ground: new Color(0.38, 0.36, 0.28),
    groundAlt: new Color(0.3, 0.3, 0.24),
    rock: new Color(0.32, 0.32, 0.3),
    trees: 0,
    bushes: 0,
    grass: 0,
    rocks: 0.2,
    flowers: 0,
    treeKind: 'none',
  },
  beach: {
    id: 'beach',
    ground: new Color(0.82, 0.76, 0.56),
    groundAlt: new Color(0.72, 0.66, 0.48),
    rock: new Color(0.5, 0.48, 0.44),
    trees: 0.18,
    bushes: 0.1,
    grass: 0.25,
    rocks: 0.5,
    flowers: 0.05,
    treeKind: 'palm',
  },
  wetland: {
    id: 'wetland',
    ground: new Color(0.28, 0.4, 0.24),
    groundAlt: new Color(0.22, 0.32, 0.2),
    rock: new Color(0.34, 0.36, 0.32),
    trees: 0.5,
    bushes: 1,
    grass: 1.2,
    rocks: 0.2,
    flowers: 0.4,
    treeKind: 'dead',
  },
  jungle: {
    id: 'jungle',
    ground: new Color(0.24, 0.42, 0.2),
    groundAlt: new Color(0.18, 0.32, 0.16),
    rock: new Color(0.36, 0.38, 0.34),
    trees: 1.4,
    bushes: 1.2,
    grass: 1,
    rocks: 0.4,
    flowers: 0.5,
    treeKind: 'jungle',
  },
  sakura: {
    id: 'sakura',
    ground: new Color(0.42, 0.5, 0.32),
    groundAlt: new Color(0.5, 0.44, 0.44),
    rock: new Color(0.46, 0.42, 0.44),
    trees: 1,
    bushes: 0.6,
    grass: 1.1,
    rocks: 0.3,
    flowers: 1.6,
    treeKind: 'sakura',
  },
  meadow: {
    id: 'meadow',
    ground: new Color(0.38, 0.52, 0.26),
    groundAlt: new Color(0.3, 0.44, 0.22),
    rock: new Color(0.42, 0.42, 0.38),
    trees: 0.35,
    bushes: 0.5,
    grass: 1.4,
    rocks: 0.35,
    flowers: 1.2,
    treeKind: 'jungle',
  },
  savanna: {
    id: 'savanna',
    ground: new Color(0.62, 0.56, 0.3),
    groundAlt: new Color(0.52, 0.46, 0.26),
    rock: new Color(0.5, 0.44, 0.36),
    trees: 0.3,
    bushes: 0.35,
    grass: 0.9,
    rocks: 0.5,
    flowers: 0.25,
    treeKind: 'acacia',
  },
  pine: {
    id: 'pine',
    ground: new Color(0.26, 0.36, 0.24),
    groundAlt: new Color(0.3, 0.34, 0.26),
    rock: new Color(0.42, 0.42, 0.42),
    trees: 1.2,
    bushes: 0.5,
    grass: 0.6,
    rocks: 0.7,
    flowers: 0.2,
    treeKind: 'pine',
  },
  highland: {
    id: 'highland',
    ground: new Color(0.44, 0.44, 0.36),
    groundAlt: new Color(0.5, 0.48, 0.42),
    rock: new Color(0.46, 0.46, 0.46),
    trees: 0.25,
    bushes: 0.2,
    grass: 0.3,
    rocks: 1,
    flowers: 0.1,
    treeKind: 'pine',
  },
  snow: {
    id: 'snow',
    ground: new Color(0.88, 0.9, 0.92),
    groundAlt: new Color(0.78, 0.82, 0.88),
    rock: new Color(0.54, 0.55, 0.58),
    trees: 0.06,
    bushes: 0,
    grass: 0,
    rocks: 0.8,
    flowers: 0,
    treeKind: 'pine',
  },
};

export function biomeStyle(id: BiomeId): BiomeStyle {
  return BIOMES[id];
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/** Integer hash → [0,1). Cheap, stable and deterministic across runs. */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695040) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function smoothStep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinear value noise. */
function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothStep(x - x0);
  const ty = smoothStep(y - y0);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Fractal sum of value noise. */
function fbm(x: number, y: number, seed: number, octaves: number, lacunarity = 2.03): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o * 17) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged noise — sharp crests, good for mountain spines. */
function ridge(x: number, y: number, seed: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise(x * freq, y * freq, seed + o * 31) - 0.5) * 2;
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

const SEED = 1337;

/**
 * Raw terrain height in metres. This is *the* definition of the ground: chunk
 * meshes, prop placement and player collision all read it, so they can never
 * disagree.
 */
export function elevationAt(x: number, z: number): number {
  return applyLandmarkTerrace(baseElevationAt(x, z), x, z);
}

/**
 * Terrain height before landmarks carve their terraces. Used when deciding where
 * a landmark goes, which is what keeps `elevationAt` from recursing into itself.
 */
function baseElevationAt(x: number, z: number): number {
  // Continent mask: large, slow undulation that decides land vs. sea.
  const continent = fbm(x * 0.00022, z * 0.00022, SEED, 4);
  // Rolling hills at mid scale.
  const hills = fbm(x * 0.0016, z * 0.0016, SEED + 100, 5);
  // Mountain ridges, masked so they only appear inland.
  const mountainMask = Math.max(0, continent - 0.52) * 2.4;
  const mountains = ridge(x * 0.0009, z * 0.0009, SEED + 200, 5) * mountainMask;
  // Fine detail so slopes aren't glassy.
  const detail = fbm(x * 0.012, z * 0.012, SEED + 300, 3);

  let h = -34 + continent * 150 + hills * 46 + mountains * 210 + detail * 5;

  // River valleys: carve where a separate ridged field peaks.
  const river = ridge(x * 0.0011, z * 0.0011, SEED + 400, 3);
  const carve = Math.max(0, river - 0.72) * 3.4;
  h -= carve * 34;

  // Flatten a plaza around the spawn portal so the start area is walkable.
  const d = Math.hypot(x, z);
  if (d < WORLD.plazaRadius * 2.6) {
    const blend = smoothStep(
      Math.min(1, Math.max(0, (d - WORLD.plazaRadius) / (WORLD.plazaRadius * 1.6))),
    );
    h = WORLD.plazaHeight * (1 - blend) + h * blend;
  }

  // Coastal falloff so the map ends in open ocean instead of a cliff.
  const edge = Math.max(Math.abs(x), Math.abs(z)) / WORLD.halfSize;
  if (edge > 0.82) {
    h -= Math.pow((edge - 0.82) / 0.18, 2) * 260;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Landmark terraces
// ---------------------------------------------------------------------------
//
// Campfires, camps and ruins sit on a flat pad cut into the terrain. That is
// partly art direction — a levelled site reads as somewhere people chose to
// build — but mostly it is what makes their placement robust: a constant height
// is represented exactly at every LOD, so a landmark can never end up floating
// above (or buried in) a coarser distant chunk. Sampling the raw noise instead
// was why campfires hovered once you looked at them from far enough away.

/** Placement grid for landmarks. `Landmarks.ts` must use the same value. */
export const LANDMARK_CELL = 420;
/** Fully level radius, then the terrace eases back into the natural ground. */
const TERRACE_FLAT = 15;
const TERRACE_BLEND = 30;

export interface LandmarkSite {
  x: number;
  z: number;
  /** Levelled ground height of the pad. */
  y: number;
}

function baseSlopeAt(x: number, z: number, step: number): number {
  const hx = baseElevationAt(x + step, z) - baseElevationAt(x - step, z);
  const hz = baseElevationAt(x, z + step) - baseElevationAt(x, z - step);
  return Math.hypot(hx, hz) / (step * 2);
}

const siteCache = new Map<number, LandmarkSite | null>();

/**
 * The landmark for one cell, or `null` when the cell stays empty. Deterministic
 * and cached: `elevationAt` consults the nine surrounding cells, so this has to
 * be cheap and it has to be the *only* definition — `Landmarks.ts` builds from
 * exactly this, which is what keeps the pad and the props on the same spot.
 */
export function landmarkSiteFor(cx: number, cz: number): LandmarkSite | null {
  const key = cx * 8192 + cz;
  const hit = siteCache.get(key);
  if (hit !== undefined) return hit;

  const rand = (n: number): number => cellRandom(cx * 31 + n, cz * 17 - n, 555);
  let site: LandmarkSite | null = null;
  // Some cells stay empty — landmarks should feel like a find, not a checklist.
  if (rand(3) >= 0.3) {
    const x = (cx + 0.15 + rand(1) * 0.7) * LANDMARK_CELL;
    const z = (cz + 0.15 + rand(2) * 0.7) * LANDMARK_CELL;
    const y = baseElevationAt(x, z);
    const insideWorld =
      Math.abs(x) < WORLD.halfSize - 80 && Math.abs(z) < WORLD.halfSize - 80;
    const clearOfSpawn = Math.hypot(x, z) > WORLD.plazaRadius * 2;
    const aboveWater = y > WORLD.waterLevel + 1.5;
    // Refuse cliff faces: terracing one would punch an obvious shelf into the
    // mountain rather than looking like a levelled clearing.
    const gentle = baseSlopeAt(x, z, 10) < 0.42;
    if (insideWorld && clearOfSpawn && aboveWater && gentle) site = { x, z, y };
  }

  if (siteCache.size > 20_000) siteCache.clear();
  siteCache.set(key, site);
  return site;
}

/** Levels the ground toward any nearby landmark pad. */
function applyLandmarkTerrace(h: number, x: number, z: number): number {
  const cx = Math.floor(x / LANDMARK_CELL);
  const cz = Math.floor(z / LANDMARK_CELL);
  let out = h;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const site = landmarkSiteFor(cx + dx, cz + dz);
      if (!site) continue;
      const d = Math.hypot(x - site.x, z - site.z);
      if (d > TERRACE_FLAT + TERRACE_BLEND) continue;
      const t = smoothStep(Math.min(1, Math.max(0, (d - TERRACE_FLAT) / TERRACE_BLEND)));
      out = site.y * (1 - t) + out * t;
    }
  }
  return out;
}

/** Approximate slope (metres of rise per metre) at a point. */
export function slopeAt(x: number, z: number, step = 4): number {
  const hx = elevationAt(x + step, z) - elevationAt(x - step, z);
  const hz = elevationAt(x, z + step) - elevationAt(x, z - step);
  return Math.hypot(hx, hz) / (step * 2);
}

// ---------------------------------------------------------------------------
// The rendered surface
// ---------------------------------------------------------------------------
//
// `elevationAt` is a smooth analytic field, but the terrain you actually see is
// a triangle grid sampled from it on a fixed lattice. Those are NOT the same
// surface: across one 8 m cell the curve can sit a metre away from its own
// secant. Anything that reads `elevationAt` directly therefore disagrees with
// the picture — which is exactly what made trees and campfires hover over
// crests, and let the player sink through the visible ground in dips.
//
// So the lattice is the contract. `surfaceHeightAt` reproduces the rendered
// triangles bit-for-bit, and the terrain mesh, prop placement and player
// collision all go through it.

/**
 * Grid spacing of the near-field terrain mesh, in metres. Chunk size must be an
 * exact multiple of this, and the near LOD rings must use exactly this step, or
 * the mesh and this function drift apart again.
 */
export const SURFACE_STEP = 8;

/**
 * Lattice height cache. Every consumer hits the same points — a chunk's own
 * vertices, its neighbours' vertices for normals, and thousands of scatter
 * candidates inside the same cells — so memoising turns `elevationAt` from the
 * hot path into a one-off cost per lattice point. That is what makes dense
 * grass affordable: ~9 600 candidates per chunk went from ~2.7M noise
 * evaluations to a few map lookups.
 *
 * Two generations instead of one map with a clear: eviction stays O(1) and
 * recently used points survive, so walking a long way never causes a hitch
 * while the cache refills.
 */
const LATTICE_GENERATION_LIMIT = 150_000;
let latticeHot = new Map<number, number>();
let latticeCold = new Map<number, number>();

/** Packs lattice coords into one exact integer key. */
function latticeKey(gx: number, gz: number): number {
  return gx * 8192 + gz;
}

function latticeHeight(gx: number, gz: number): number {
  const key = latticeKey(gx, gz);
  const hot = latticeHot.get(key);
  if (hot !== undefined) return hot;
  let v = latticeCold.get(key);
  if (v === undefined) v = elevationAt(gx * SURFACE_STEP, gz * SURFACE_STEP);
  latticeHot.set(key, v);
  if (latticeHot.size >= LATTICE_GENERATION_LIMIT) {
    latticeCold = latticeHot;
    latticeHot = new Map();
  }
  return v;
}

/**
 * Height of the ground *as drawn*.
 *
 * The interpolation deliberately mirrors the mesh triangulation: each lattice
 * quad is split along its anti-diagonal (see the index order in Terrain), so
 * this returns the height of the very triangle you are standing on rather than
 * a bilinear approximation of it.
 */
export function surfaceHeightAt(x: number, z: number): number {
  const sx = x / SURFACE_STEP;
  const sz = z / SURFACE_STEP;
  const gx = Math.floor(sx);
  const gz = Math.floor(sz);
  const tx = sx - gx;
  const tz = sz - gz;
  if (tx + tz <= 1) {
    // Lower-left triangle: (gx,gz) → (gx,gz+1) → (gx+1,gz)
    const h00 = latticeHeight(gx, gz);
    return (
      h00 + (latticeHeight(gx + 1, gz) - h00) * tx + (latticeHeight(gx, gz + 1) - h00) * tz
    );
  }
  // Upper-right triangle: (gx+1,gz) → (gx,gz+1) → (gx+1,gz+1)
  const h11 = latticeHeight(gx + 1, gz + 1);
  return (
    h11 +
    (latticeHeight(gx, gz + 1) - h11) * (1 - tx) +
    (latticeHeight(gx + 1, gz) - h11) * (1 - tz)
  );
}

/** Height at a lattice point. For mesh vertices, which are always on-lattice. */
export function surfaceHeightAtLattice(gx: number, gz: number): number {
  return latticeHeight(gx, gz);
}

/**
 * Steepness of the drawn surface (metres of rise per metre), from the same
 * lattice. Replaces four `elevationAt` calls with four cache hits.
 */
export function surfaceSlopeAt(x: number, z: number): number {
  const gx = Math.floor(x / SURFACE_STEP);
  const gz = Math.floor(z / SURFACE_STEP);
  const h00 = latticeHeight(gx, gz);
  const h10 = latticeHeight(gx + 1, gz);
  const h01 = latticeHeight(gx, gz + 1);
  const h11 = latticeHeight(gx + 1, gz + 1);
  const dx = (h10 + h11 - h00 - h01) * 0.5;
  const dz = (h01 + h11 - h00 - h10) * 0.5;
  return Math.hypot(dx, dz) / SURFACE_STEP;
}

/**
 * Biome lookup, snapped and memoised on the lattice. Biomes span hundreds of
 * metres, so 8 m granularity is invisible, and this removes two fbm evaluations
 * from every single scatter candidate.
 */
let biomeHot = new Map<number, BiomeId>();
let biomeCold = new Map<number, BiomeId>();

export function surfaceBiomeAt(x: number, z: number): BiomeId {
  const gx = Math.round(x / SURFACE_STEP);
  const gz = Math.round(z / SURFACE_STEP);
  const key = latticeKey(gx, gz);
  const hot = biomeHot.get(key);
  if (hot !== undefined) return hot;
  let v = biomeCold.get(key);
  if (v === undefined) {
    v = biomeAt(gx * SURFACE_STEP, gz * SURFACE_STEP, latticeHeight(gx, gz));
  }
  biomeHot.set(key, v);
  if (biomeHot.size >= LATTICE_GENERATION_LIMIT) {
    biomeCold = biomeHot;
    biomeHot = new Map();
  }
  return v;
}

/** Walkable height of the drawn ground — never below the shoreline. */
export function surfaceGroundHeightAt(x: number, z: number): number {
  return Math.max(surfaceHeightAt(x, z), WORLD.waterLevel + 0.4);
}

/** Drops every cache. Called when the exterior scene is torn down. */
export function resetSurfaceCache(): void {
  latticeHot = new Map();
  latticeCold = new Map();
  biomeHot = new Map();
  biomeCold = new Map();
}

/** 0 (cold) .. 1 (hot). Falls with altitude and toward the map's north edge. */
export function temperatureAt(x: number, z: number, elevation: number): number {
  const base = fbm(x * 0.00035, z * 0.00035, SEED + 900, 3);
  const latitude = 1 - Math.min(1, Math.max(0, (z + WORLD.halfSize) / (WORLD.halfSize * 2)));
  const altitude = Math.min(1, Math.max(0, (elevation - 20) / 130));
  return Math.min(1, Math.max(0, base * 0.45 + latitude * 0.55 - altitude * 0.75));
}

/** 0 (arid) .. 1 (swampy). Wetter near sea level and in noise basins. */
export function moistureAt(x: number, z: number, elevation: number): number {
  const base = fbm(x * 0.0005, z * 0.0005, SEED + 1500, 4);
  const coastal = 1 - Math.min(1, Math.max(0, (elevation - WORLD.waterLevel) / 90));
  return Math.min(1, Math.max(0, base * 0.68 + coastal * 0.32));
}

/**
 * Classifies a point into a biome. Ordered from the strongest constraints
 * (water, snow) down to the climate lookup.
 */
export function biomeAt(x: number, z: number, elevation?: number): BiomeId {
  const h = elevation ?? elevationAt(x, z);
  if (h < WORLD.waterLevel) return 'ocean';
  if (h < WORLD.waterLevel + 3.5) return 'beach';
  if (h > WORLD.snowLine) return 'snow';

  const temp = temperatureAt(x, z, h);
  const wet = moistureAt(x, z, h);

  if (h > WORLD.treeLine) return 'highland';
  if (wet > 0.74 && h < WORLD.waterLevel + 16) return 'wetland';

  if (temp < 0.34) return 'pine';
  if (temp > 0.68) return wet > 0.5 ? 'jungle' : 'savanna';

  // Temperate band: sakura groves bloom in pockets of high moisture.
  if (wet > 0.62) return 'sakura';
  if (wet > 0.4) return 'meadow';
  return 'savanna';
}

/** Walkable ground height — never below the shoreline. */
export function groundHeightAt(x: number, z: number): number {
  return Math.max(elevationAt(x, z), WORLD.waterLevel + 0.4);
}

/** Deterministic per-cell random, used for scattering. */
export function cellRandom(ix: number, iz: number, salt: number): number {
  return hash2(ix, iz, SEED + salt * 7919);
}
