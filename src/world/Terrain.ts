import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import type { AssetManager } from '../core/AssetManager.ts';
import type { QualitySettings } from '../core/QualityManager.ts';
import {
  biomeStyle,
  surfaceBiomeAt,
  surfaceHeightAtLattice,
  SURFACE_STEP,
  WORLD,
} from './WorldGen.ts';

/** Metres per terrain chunk. Must be a whole number of `SURFACE_STEP` cells. */
const CHUNK = 256;
/** How many chunks out from the player stay loaded (view ≈ this × CHUNK). */
const VIEW_RADIUS = 4;
/**
 * Grid resolution per LOD ring (index = ring distance, clamped).
 *
 * Rings 0-2 deliberately share one resolution, and that resolution is exactly
 * `CHUNK / SURFACE_STEP`. Everything the player can touch or see a prop stand on
 * lives inside ring 2, so within that range the drawn triangles and
 * `surfaceHeightAt` are the same surface — no hovering props, no falling
 * through hillsides. Rings 3+ get coarser, and nothing is placed out there.
 */
const NEAR_SEGMENTS = CHUNK / SURFACE_STEP; // 32
/**
 * Rings 0-3 share the near resolution. Ring 3 is included because vegetation
 * chunks are kept one ring beyond their build radius as hysteresis, so a tree
 * placed at ring 2 can end up sitting on ring-3 ground — and if that ground were
 * coarser, the tree would start hovering as you walked away from it.
 */
const LOD_SEGMENTS = [NEAR_SEGMENTS, NEAR_SEGMENTS, NEAR_SEGMENTS, NEAR_SEGMENTS, 8];
/** Rings that share the near resolution. Props may only stream this far out. */
export const TERRAIN_NEAR_RINGS = 3;
/**
 * Chunks built per frame. Low enough that a build never blows the frame budget,
 * high enough that walking briskly doesn't outrun the loader.
 */
const BUILD_BUDGET = 4;
/** How far chunk edges drop, to hide cracks between differing LOD levels. */
const SKIRT_DEPTH = 26;

interface Chunk {
  key: string;
  cx: number;
  cz: number;
  ring: number;
  /** Grid resolution this chunk was built at, so LOD changes can be detected. */
  segments: number;
  mesh: Mesh;
  geometry: BufferGeometry;
}

export interface TerrainStreamer {
  group: Group;
  /** Queue/unload chunks around a position. Call every frame. */
  update(position: Vector3): void;
  /**
   * How wet the ground looks, 0..1. Cheap on purpose: every chunk shares one
   * material, so this is two property writes for the entire streamed world.
   */
  setWetness(amount: number): void;
  /**
   * Build pending chunks until `deadline` (a `performance.now()` timestamp).
   * Returns work remaining.
   */
  pump(deadline: number): number;
  /** Force-build everything within `rings` of a point (used before play starts). */
  prime(position: Vector3, rings: number): void;
  loadedChunks(): number;
  pendingChunks(): number;
  dispose(): void;
}

/**
 * Builds one terrain chunk.
 *
 * The mesh is generated directly rather than by displacing a PlaneGeometry so we
 * can attach a "skirt": a ring of vertices dropped below the edge. Neighbouring
 * chunks may use different LOD levels, which leaves hairline cracks along the
 * seam — the skirt fills them with geometry that is hidden under the surface.
 */
function buildChunkGeometry(cx: number, cz: number, segments: number): BufferGeometry {
  const verts = segments + 1;
  const step = CHUNK / segments;
  const originX = cx * CHUNK;
  const originZ = cz * CHUNK;
  // Vertices are addressed by lattice index rather than by world position, which
  // guarantees they land on the shared lattice `surfaceHeightAt` interpolates.
  const originGX = cx * NEAR_SEGMENTS;
  const originGZ = cz * NEAR_SEGMENTS;
  const stride = NEAR_SEGMENTS / segments; // integer by construction of LOD_SEGMENTS
  const gridCount = verts * verts;
  const skirtCount = verts * 4;
  const total = gridCount + skirtCount;

  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);

  const tmp = new Color();
  const lowC = new Color();
  const highC = new Color();
  const rockC = new Color();

  // --- Surface grid ---
  for (let iz = 0; iz < verts; iz++) {
    for (let ix = 0; ix < verts; ix++) {
      const i = iz * verts + ix;
      const gx = originGX + ix * stride;
      const gz = originGZ + iz * stride;
      const wx = originX + ix * step;
      const wz = originZ + iz * step;
      const h = surfaceHeightAtLattice(gx, gz);

      positions[i * 3] = ix * step;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = iz * step;

      // Normals come from the shared lattice, not from this chunk's triangles.
      // Geometry-based normals differ either side of a chunk border (each chunk
      // only sees its own triangles), which shows up as a hard lighting seam.
      // Reading the same global lattice gives identical normals on both sides,
      // and every sample is already cached by the neighbouring vertex.
      const hxm = surfaceHeightAtLattice(gx - 1, gz);
      const hxp = surfaceHeightAtLattice(gx + 1, gz);
      const hzm = surfaceHeightAtLattice(gx, gz - 1);
      const hzp = surfaceHeightAtLattice(gx, gz + 1);
      const nx = hxm - hxp;
      const nz = hzm - hzp;
      const ny = 2 * SURFACE_STEP;
      const len = Math.hypot(nx, ny, nz) || 1;
      normals[i * 3] = nx / len;
      normals[i * 3 + 1] = ny / len;
      normals[i * 3 + 2] = nz / len;

      // Biome colouring, blended by height and steepness. Both the biome and the
      // steepness reuse the lattice samples above, so no extra noise evaluation.
      const style = biomeStyle(surfaceBiomeAt(wx, wz));
      lowC.copy(style.ground);
      highC.copy(style.groundAlt);
      rockC.copy(style.rock);
      const band = Math.min(1, Math.max(0, (h - WORLD.waterLevel) / 90));
      tmp.copy(lowC).lerp(highC, band);
      const slope = Math.hypot(nx, nz) / (2 * SURFACE_STEP);
      const steep = Math.min(1, slope * 1.35);
      tmp.lerp(rockC, steep * 0.85);
      // Large-scale mottling so big areas never read as one flat colour.
      const mottle = 0.88 + ((Math.sin(wx * 0.013) + Math.cos(wz * 0.011)) * 0.5 + 0.5) * 0.22;
      colors[i * 3] = tmp.r * mottle;
      colors[i * 3 + 1] = tmp.g * mottle;
      colors[i * 3 + 2] = tmp.b * mottle;

      // World-space UVs keep the detail texture at a constant real-world scale.
      uvs[i * 2] = wx * 0.06;
      uvs[i * 2 + 1] = wz * 0.06;
    }
  }

  const indices: number[] = [];
  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = iz * verts + ix;
      const b = a + 1;
      const c = a + verts;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // --- Skirt: duplicate each border vertex, pushed straight down ---
  let s = gridCount;
  const addSkirt = (gridIndex: number): number => {
    const src = gridIndex * 3;
    positions[s * 3] = positions[src]!;
    positions[s * 3 + 1] = positions[src + 1]! - SKIRT_DEPTH;
    positions[s * 3 + 2] = positions[src + 2]!;
    normals[s * 3] = normals[src]!;
    normals[s * 3 + 1] = normals[src + 1]!;
    normals[s * 3 + 2] = normals[src + 2]!;
    colors[s * 3] = colors[src]!;
    colors[s * 3 + 1] = colors[src + 1]!;
    colors[s * 3 + 2] = colors[src + 2]!;
    uvs[s * 2] = uvs[gridIndex * 2]!;
    uvs[s * 2 + 1] = uvs[gridIndex * 2 + 1]!;
    return s++;
  };

  const stitch = (edge: number[], flip: boolean): void => {
    const lowered = edge.map(addSkirt);
    for (let k = 0; k < edge.length - 1; k++) {
      const a = edge[k]!;
      const b = edge[k + 1]!;
      const c = lowered[k]!;
      const d = lowered[k + 1]!;
      if (flip) indices.push(a, c, b, b, c, d);
      else indices.push(a, b, c, b, d, c);
    }
  };

  const north: number[] = [];
  const south: number[] = [];
  const west: number[] = [];
  const east: number[] = [];
  for (let i = 0; i < verts; i++) {
    north.push(i);
    south.push((verts - 1) * verts + i);
    west.push(i * verts);
    east.push(i * verts + (verts - 1));
  }
  stitch(north, false);
  stitch(south, true);
  stitch(west, true);
  stitch(east, false);

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('normal', new BufferAttribute(normals, 3));
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  geo.setAttribute('uv', new BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Streams terrain chunks around the player: nearest-first construction with a
 * per-frame budget so a huge world can be walked without loading screens or
 * frame-time spikes.
 */
export function createTerrain(assets: AssetManager, settings?: QualitySettings): TerrainStreamer {
  const group = new Group();
  group.name = 'Terrain';

  /**
   * How far the ground streams, by quality tier.
   *
   * This has to scale with the tier. The near rings deliberately share one
   * resolution so the mesh matches `surfaceHeightAt` exactly, but that made the
   * cost per chunk the same everywhere — so turning quality down did nothing for
   * the terrain, and a weak laptop still paid for 49 full-detail chunks. Only the
   * *count* of chunks can be traded away, never their resolution: dropping the
   * resolution would reintroduce props floating above the ground.
   */
  const viewRadius = Math.max(
    TERRAIN_NEAR_RINGS,
    Math.min(VIEW_RADIUS, Math.round((settings?.vegetationDensity ?? 1) * 3) + 1),
  );

  const tex = assets.ground();
  const material = new MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    roughnessMap: tex.roughnessMap,
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });

  /**
   * Wet ground, done by darkening the surface and taking the edge off its
   * roughness rather than by adding a second material or a wetness map.
   *
   * That is what water on soil actually does optically — it fills the pores, so
   * less light scatters back out and the remaining reflection gets sharper — and
   * it costs nothing here, because all the chunks share this one material and its
   * vertex colours are multiplied by `material.color`. A wet variant of the
   * material would have doubled the terrain's draw calls to say the same thing.
   *
   * The ramp itself lives in the weather state; this only applies the result.
   */
  const DRY_TINT = new Color(1, 1, 1);
  const WET_TINT = new Color(0.6, 0.62, 0.64);
  /** Starts out of range so the first call always writes. */
  let wetness = -1;

  const setWetness = (amount: number): void => {
    const a = Math.min(1, Math.max(0, amount));
    // Drying is a slow ramp, so most frames ask for a value indistinguishable
    // from the last one. Nothing is allocated either way; this just skips work.
    if (Math.abs(a - wetness) < 0.002) return;
    wetness = a;
    material.color.copy(DRY_TINT).lerp(WET_TINT, a);
    material.roughness = 1 - a * 0.42;
    // A touch of metalness sharpens the sheen the sun leaves on wet ground.
    // Kept small: with no environment map on the terrain, metalness mostly eats
    // diffuse light, and any more than this reads as mud turning to plastic.
    material.metalness = a * 0.1;
  };

  const loaded = new Map<string, Chunk>();
  /** Chunks we want, sorted by distance when drained. */
  const pending = new Map<string, { cx: number; cz: number; ring: number; dist: number }>();

  const key = (cx: number, cz: number): string => `${cx}|${cz}`;
  const maxChunk = Math.ceil(WORLD.halfSize / CHUNK);

  const ringSegments = (ring: number): number =>
    LOD_SEGMENTS[Math.min(ring, LOD_SEGMENTS.length - 1)] ?? 8;

  const buildChunk = (cx: number, cz: number, ring: number): void => {
    const k = key(cx, cz);
    const segments = ringSegments(ring);
    const existing = loaded.get(k);
    // Already there at the right detail level — nothing to do.
    if (existing && existing.segments === segments) return;

    const geometry = buildChunkGeometry(cx, cz, segments);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(cx * CHUNK, 0, cz * CHUNK);
    mesh.receiveShadow = true;
    // Only the closest chunks bother casting shadows.
    mesh.castShadow = ring <= 1;
    group.add(mesh);
    // Swap in the new mesh before releasing the old one, so the ground is never
    // missing for a frame while a chunk is refined.
    if (existing) {
      group.remove(existing.mesh);
      existing.geometry.dispose();
    }
    loaded.set(k, { key: k, cx, cz, ring, segments, mesh, geometry });
  };

  const dropChunk = (chunk: Chunk): void => {
    group.remove(chunk.mesh);
    chunk.geometry.dispose();
    loaded.delete(chunk.key);
  };

  const update = (position: Vector3): void => {
    // `floor`, not `round`: a chunk spans [cx·CHUNK, cx·CHUNK + CHUNK), so the
    // chunk containing the player is floor(pos / CHUNK). Rounding measured rings
    // from the nearest *corner*, which classified the ground underfoot as ring 1
    // or 2 across roughly three quarters of every chunk — the player would then
    // be standing on a coarser grid than the near-field contract assumes.
    const pcx = Math.floor(position.x / CHUNK);
    const pcz = Math.floor(position.z / CHUNK);

    // Queue anything missing inside the view radius.
    for (let dz = -viewRadius; dz <= viewRadius; dz++) {
      for (let dx = -viewRadius; dx <= viewRadius; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dz));
        if (ring > viewRadius) continue;
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (Math.abs(cx) > maxChunk || Math.abs(cz) > maxChunk) continue;
        const k = key(cx, cz);
        if (pending.has(k)) continue;
        const have = loaded.get(k);
        // Queue when absent, and also when the chunk is loaded at the wrong
        // detail level. Without this a chunk first seen far away kept its 32 m
        // grid forever, including once the player walked onto it.
        if (have && have.segments === ringSegments(ring)) continue;
        pending.set(k, { cx, cz, ring, dist: dx * dx + dz * dz });
      }
    }

    // Release anything that drifted well outside the radius (hysteresis of 1
    // chunk stops thrashing when walking along a boundary).
    for (const chunk of [...loaded.values()]) {
      const ring = Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz));
      if (ring > viewRadius + 1) dropChunk(chunk);
    }
    for (const [k, want] of [...pending]) {
      const ring = Math.max(Math.abs(want.cx - pcx), Math.abs(want.cz - pcz));
      if (ring > viewRadius + 1) pending.delete(k);
    }
  };

  const pump = (deadline: number): number => {
    if (pending.size === 0) return 0;
    // Nearest first, so the ground under the player always exists.
    const queue = [...pending.entries()].sort((a, b) => a[1].dist - b[1].dist);
    for (let i = 0; i < BUILD_BUDGET && i < queue.length; i++) {
      // A time budget, not just a count: chunk cost varies with LOD and with how
      // much of the height lattice is already cached, so a fixed count either
      // wastes headroom or blows the frame. Always build at least one, otherwise
      // a slow frame could stall streaming forever.
      if (i > 0 && performance.now() >= deadline) break;
      const [k, want] = queue[i]!;
      pending.delete(k);
      buildChunk(want.cx, want.cz, want.ring);
    }
    return pending.size;
  };

  const prime = (position: Vector3, rings: number): void => {
    const pcx = Math.floor(position.x / CHUNK);
    const pcz = Math.floor(position.z / CHUNK);
    for (let dz = -rings; dz <= rings; dz++) {
      for (let dx = -rings; dx <= rings; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dz));
        buildChunk(pcx + dx, pcz + dz, ring);
        pending.delete(key(pcx + dx, pcz + dz));
      }
    }
  };

  const dispose = (): void => {
    for (const chunk of [...loaded.values()]) dropChunk(chunk);
    pending.clear();
    material.dispose();
  };

  return {
    group,
    update,
    setWetness,
    pump,
    prime,
    loadedChunks: () => loaded.size,
    pendingChunks: () => pending.size,
    dispose,
  };
}

export { CHUNK as TERRAIN_CHUNK_SIZE, VIEW_RADIUS as TERRAIN_VIEW_RADIUS };
