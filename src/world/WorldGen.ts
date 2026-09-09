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

/** Approximate slope (metres of rise per metre) at a point. */
export function slopeAt(x: number, z: number, step = 4): number {
  const hx = elevationAt(x + step, z) - elevationAt(x - step, z);
  const hz = elevationAt(x, z + step) - elevationAt(x, z - step);
  return Math.hypot(hx, hz) / (step * 2);
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
