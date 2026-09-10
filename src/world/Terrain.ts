import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector2,
  Vector3,
  type Texture,
} from 'three';
import type { SnowTrackMap } from './SnowTracks.ts';
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

/**
 * Where the fresh-snow line sits with the barest cover, and where it reaches when
 * cover is total, in metres.
 *
 * The ceiling is the permanent snow line: a dusting only freshens ground that is
 * white anyway, which is what a light fall on a range actually does. The floor is
 * just above the sea, so a long hard winter can bring snow all the way down — and
 * because the shader interpolates between the two, everything in between happens
 * on its own, in the right order, with the summits going first.
 */
const SNOW_CEILING = WORLD.snowLine;
const SNOW_FLOOR = WORLD.waterLevel + 6;

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
   * How much snow is lying, 0..1, plus the map of tracks walked through it.
   * As cheap as `setWetness` and for the same reason: one shared material.
   */
  setSnow(cover: number, tracks: SnowTrackMap | null): void;
  /**
   * Build pending chunks until `deadline` (a `performance.now()` timestamp).
   * Returns work remaining.
   *
   * `force` allows exactly one build to start even if the deadline has already
   * passed, which is what guarantees progress on a frame that was slow before
   * streaming even began. It is granted to one streamer per frame, in turn.
   */
  pump(deadline: number, force?: boolean): number;
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
  /** How much of the grass texture's colour survives at each vertex. */
  const chroma = new Float32Array(total);

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
      // The height ramp spans the world's actual altitude range. It used to
      // saturate at 96 m, which was the top of the map when it was written; with
      // peaks past 350 m that put every mountain flank at the same tint.
      const band = Math.min(1, Math.max(0, (h - WORLD.waterLevel) / 210));
      tmp.copy(lowC).lerp(highC, band);
      const slope = Math.hypot(nx, nz) / (2 * SURFACE_STEP);
      // Rock appears on faces, not on slopes. The ramp deliberately starts at
      // about 24° and reaches full stone near 58°: the previous version began at
      // zero, so a gentle snowfield came out half slate-grey, while a genuine
      // cliff was never more than four fifths rock.
      const steep = Math.min(1, Math.max(0, (slope - 0.45) / 1.15));
      tmp.lerp(rockC, steep * 0.95);
      // Snow, scree and any steep face stop borrowing the grass texture's green
      // (see `BiomeStyle.chroma`). Without this the vertex colour is fighting a
      // saturated green multiply it cannot win: the snow line was a lawn.
      chroma[i] = style.chroma * (1 - steep * 0.85);
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
    chroma[s] = chroma[gridIndex]!;
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
  geo.setAttribute('aChroma', new BufferAttribute(chroma, 1));
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
   * Lets the ground texture contribute relief without contributing colour.
   *
   * The detail map is a lush green grass, and a standard material multiplies it
   * by the vertex colour. Multiplication cannot brighten or shift a hue, so above
   * the tree line the biome colours were powerless: a snowfield rendered as a
   * bright green lawn, and every cliff face as moss. Grading each vertex's
   * texture toward its own luminance keeps the grain, the normal map and the
   * roughness exactly as they were, and lets the palette decide the colour.
   *
   * Done with `onBeforeCompile` on the one shared material rather than with a
   * second material: this is a two-line change to the map fetch, and a separate
   * rock material would double the streamed world's draw calls.
   */
  /**
   * Lying snow, and the tracks walked through it.
   *
   * Held on the material rather than passed per chunk: every chunk in the world
   * shares this one material, so a whole mountain range turns white for the cost
   * of four uniform writes. The alternative — a second snow material, or a
   * coverage attribute baked into each chunk's geometry — would either double the
   * streamed world's draw calls or make snowfall require rebuilding the terrain.
   *
   * `uSnowCover` is how far down the range the snowline has crept, 0..1, and the
   * shader turns that into coverage per fragment from the fragment's own height
   * and slope. That is the whole reason one scalar is enough: snow settling high
   * first and creeping down is exactly what an altitude ramp against a rising
   * threshold produces, and it costs no memory and no streaming work at all.
   */
  const snowUniforms = {
    uSnowCover: { value: 0 },
    /** Where the tracks map is centred, and how many metres across it is. */
    uTrackOrigin: { value: new Vector2() },
    uTrackExtent: { value: 1 },
    uTrackMap: { value: null as Texture | null },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, snowUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aChroma;\nvarying float vChroma;\nvarying vec3 vSurfaceWorld;\nvarying vec3 vSurfaceUp;',
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        vChroma = aChroma;
        vSurfaceWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        // The *world* normal, carried separately. three's own \`vNormal\` is in view
        // space, so its y is "towards the top of the screen" rather than "up" — a
        // slope test built on it changes answer as the camera turns, which showed
        // up as snow that came and went depending on which way you were facing.
        vSurfaceUp = normalize( mat3( modelMatrix ) * normal );
        `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying float vChroma;
        varying vec3 vSurfaceWorld;
        varying vec3 vSurfaceUp;
        uniform float uSnowCover;
        uniform vec2 uTrackOrigin;
        uniform float uTrackExtent;
        uniform sampler2D uTrackMap;

        /**
         * How much snow is lying on this fragment, 0..1.
         *
         * Three things decide it, and all three are read from the surface itself
         * rather than stored anywhere. Height, because snow settles at altitude
         * first and the line creeps down as more falls. Slope, because snow does
         * not cling to a cliff — that is why real mountains show bare rock on
         * their faces and white on their shoulders, and it is most of what makes
         * a covering read as snow rather than as white paint. And the tracks map,
         * so walking through it leaves it behind.
         */
        float snowAt( vec3 world, vec3 surfaceNormal ) {
          if ( uSnowCover <= 0.001 ) return 0.0;

          // The height the cover has reached. At full cover it comes down to the
          // valley floor; with a dusting it only touches the summits.
          float snowHeight = mix( ${SNOW_CEILING.toFixed(1)}, ${SNOW_FLOOR.toFixed(1)}, uSnowCover );
          float lying = smoothstep( snowHeight, snowHeight + 42.0, world.y );

          // Steepness, from the surface normal. Snow holds to about 50 degrees and
          // sheds above that. Deliberately not called "flat": that is an
          // interpolation qualifier in GLSL ES 3.0, and using it as an identifier
          // fails to compile — which the snow probe is what caught.
          float holds = smoothstep( 0.62, 0.86, surfaceNormal.y );
          lying *= holds;

          // Broken up so a covering has a shape. Without this the snowline is a
          // clean contour ring around every hill, which is the one thing that
          // never happens outdoors — wind strips ridges and fills hollows.
          float drift =
            sin( world.x * 0.021 ) * cos( world.z * 0.019 ) * 0.5 +
            sin( world.x * 0.006 + world.z * 0.008 ) * 0.5;
          lying = clamp( lying + drift * 0.16 * ( 1.0 - uSnowCover ), 0.0, 1.0 );

          // Tracks. The map is a single channel of "how trodden", in world space
          // around the player, so a footprint has to be looked up rather than
          // baked — the ground it sits on may be streamed away and rebuilt.
          vec2 uv = ( world.xz - uTrackOrigin ) / uTrackExtent + 0.5;
          if ( all( greaterThan( uv, vec2( 0.0 ) ) ) && all( lessThan( uv, vec2( 1.0 ) ) ) ) {
            float trodden = texture2D( uTrackMap, uv ).r;
            // Compressed rather than erased: a boot pushes snow aside and exposes
            // what is underneath, it does not clear the ground.
            lying *= 1.0 - trodden * 0.82;
          }
          return lying;
        }
        `,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #ifdef USE_MAP
          vec4 groundTexel = texture2D( map, vMapUv );
          float groundLum = dot( groundTexel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          // Normalised against the map's own mean luminance (about 0.24 in linear
          // light — it is a mid-green), then pulled back toward 1. Plain
          // luminance would be a 0.24 multiply, so a snowfield asking for 0.9
          // white would render at 0.2 and read as wet slate. This way the grain
          // still modulates the surface but the average multiply is unity, and
          // the palette gets to decide how bright the ground is.
          float groundDetail = mix( 1.0, clamp( groundLum * 4.1, 0.0, 2.0 ), 0.45 );
          groundTexel.rgb = mix( vec3( groundDetail ), groundTexel.rgb, vChroma );
          diffuseColor *= groundTexel;
        #endif

        float snowLying = snowAt( vSurfaceWorld, normalize( vSurfaceUp ) );
        if ( snowLying > 0.0 ) {
          // Fresh snow is close to white but not at it: pure white clips the
          // moment the sun is on it and the shape of the ground disappears. The
          // ground's own grain is kept at a fraction of its strength, which is
          // what stops a slope reading as flat card.
          vec3 snowColour = vec3( 0.88, 0.91, 0.96 ) * ( 0.9 + groundDetail * 0.1 );
          diffuseColor.rgb = mix( diffuseColor.rgb, snowColour, snowLying );
        }
        `,
      )
      // Snow is rough and not remotely metallic, and it has to say so *after* the
      // wetness has set both — otherwise a snowfield in the rain came out as
      // polished slate, since wet ground lowers roughness and lifts metalness.
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.94, snowLying );
        `,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `
        #include <metalnessmap_fragment>
        metalnessFactor = mix( metalnessFactor, 0.0, snowLying );
        `,
      );
  };

  /**
   * Publishes the lying-snow depth. Two writes for the entire streamed world.
   */
  const setSnow = (cover: number, tracks: SnowTrackMap | null): void => {
    snowUniforms.uSnowCover.value = Math.min(1, Math.max(0, cover));
    // Mirrored where a probe can see it. The uniform itself lives inside a
    // compiled program and is not readable from outside, so without this there is
    // no way to tell "the value never arrived" from "the ground was already white".
    material.userData.snowCover = snowUniforms.uSnowCover.value;
    if (tracks) {
      snowUniforms.uTrackMap.value = tracks.texture;
      snowUniforms.uTrackOrigin.value.copy(tracks.origin);
      snowUniforms.uTrackExtent.value = tracks.extent;
    }
  };

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

  const pump = (deadline: number, force = true): number => {
    if (pending.size === 0) return 0;
    // Nearest first, so the ground under the player always exists.
    const queue = [...pending.entries()].sort((a, b) => a[1].dist - b[1].dist);
    for (let i = 0; i < BUILD_BUDGET && i < queue.length; i++) {
      // A time budget, not just a count: chunk cost varies with LOD and with how
      // much of the height lattice is already cached, so a fixed count either
      // wastes headroom or blows the frame.
      //
      // `force` is the guarantee of progress: the streamer it is granted to may
      // start one build even with the budget already gone, so a run of slow frames
      // cannot stall streaming forever. It used to be unconditional here and in
      // every other streamer, which meant four of them each overran the shared
      // budget by a whole chunk on the same frame — see `Exterior.update`.
      if ((i > 0 || !force) && performance.now() >= deadline) break;
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
    setSnow,
    pump,
    prime,
    loadedChunks: () => loaded.size,
    pendingChunks: () => pending.size,
    dispose,
  };
}

export { CHUNK as TERRAIN_CHUNK_SIZE, VIEW_RADIUS as TERRAIN_VIEW_RADIUS };
