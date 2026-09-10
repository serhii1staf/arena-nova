import {
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';
import {
  resetWaterfallSites,
  WATERFALL_CHUNK,
  waterfallSitesInChunk,
  type WaterfallSite,
} from './WaterfallSites.ts';
import { surfaceGroundHeightAt } from './WorldGen.ts';

/**
 * Waterfalls
 * ----------
 * Falling water where a river runs off a cliff.
 *
 * `WaterfallSites` decides where they are; this module only draws them. It
 * streams on the same 256 m grid as the terrain, builds nothing until a chunk is
 * within a couple of rings, and spends its work inside the shared frame budget
 * like every other streamer.
 *
 * The water is a shader on a quad, not a simulation. That is not a shortcut taken
 * for lack of time: a particle or SPH solution would cost more per fall than the
 * entire streamed vegetation layer costs for a whole chunk, and it would still
 * have to be faked at distance. What the eye actually reads in a waterfall is a
 * few specific things — vertical streaks moving downward, water that goes white
 * as it aerates at the lip and again where it lands, a haze of spray in front,
 * and a disturbed pool at the bottom — and all four are cheap to draw directly.
 *
 * Cost per chunk that has any falls is two draw calls: one instanced mesh for the
 * sheets (two instances per fall, the water and the spray veil in front of it)
 * and one for the plunge pools. Chunks with no falls cost nothing at all and are
 * still recorded, so an empty chunk is never rescanned while it stays loaded.
 */

/** How many chunks out falls are built, with one chunk of hysteresis on unload. */
const VIEW_CHUNKS = 2;
/** Chunks built per pump call, on top of the shared time budget. */
const BUILD_BUDGET = 2;

export interface WaterfallField {
  group: Group;
  /**
   * `tint` is the colour of the air, so a fall dims with the sky instead of
   * glowing white after sunset — the same reason the mist and the puddles take it.
   */
  update(position: Vector3, elapsed: number, tint: Color): void;
  /**
   * Build pending chunks until `deadline` (a `performance.now()` stamp).
   * `force` permits one build to start past the deadline; see `Terrain.pump`.
   */
  pump(deadline: number, force?: boolean): number;
  prime(position: Vector3, chunks: number): void;
  /** How many falls are currently drawn. For diagnostics. */
  count(): number;
  dispose(): void;
}

const SHEET_VERT = /* glsl */ `
  attribute float aSeed;
  attribute float aDrop;
  attribute float aVeil;

  varying vec2 vUv;
  varying float vSeed;
  varying float vDrop;
  varying float vVeil;

  #include <fog_pars_vertex>

  void main() {
    vUv = uv;
    vSeed = aSeed;
    vDrop = aDrop;
    vVeil = aVeil;

    vec4 local = vec4(position, 1.0);
    // Applied by hand: this is a bare ShaderMaterial, so none of three's vertex
    // chunks are here to do it. The attribute is declared by the renderer
    // whenever the object being drawn is an InstancedMesh.
    #ifdef USE_INSTANCING
      local = instanceMatrix * local;
    #endif

    vec4 mvPosition = viewMatrix * modelMatrix * local;
    #include <fog_vertex>
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const SHEET_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uWater;
  uniform vec3 uFoam;
  uniform vec3 uTint;

  varying vec2 vUv;
  varying float vSeed;
  varying float vDrop;
  varying float vVeil;

  #include <fog_pars_fragment>

  float hash1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }

  void main() {
    // vUv.y is 1 at the lip and 0 in the plunge pool.
    float fallen = 1.0 - vUv.y;

    // Ropes of water, each column with its own phase and speed. A single scroll
    // across the whole quad reads as a moving texture; separate columns read as
    // water, because that is what a real sheet breaks into.
    float cols = 4.0 + floor(vDrop * 0.32);
    float band = vUv.x * cols + vSeed * 37.0;
    float ci = floor(band);
    float cf = fract(band);
    float speed = 1.1 + hash1(ci + vSeed * 11.0) * 0.8;
    // Bands thin out as they descend, which is what sells the acceleration.
    float y = vUv.y * (1.0 - 0.45 * fallen);
    float wave = sin(
      (y * (6.0 + vDrop * 0.1) - uTime * speed * (1.0 + vDrop * 0.015)) * 6.2831 +
      hash1(ci + 3.0) * 6.2831
    );
    float streak = 0.55 + 0.45 * wave;
    float gap = smoothstep(0.0, 0.2, cf) * smoothstep(1.0, 0.8, cf);
    float body = mix(0.6, 1.0, gap) * streak;

    // Aeration: white where it goes over the lip, white again where it lands,
    // and deeper green-blue through the thick middle of the sheet.
    float foam =
      smoothstep(0.78, 1.0, vUv.y) * 0.75 +
      smoothstep(0.4, 0.0, vUv.y) * 0.95 +
      body * 0.3;
    vec3 col = mix(uWater, uFoam, clamp(foam, 0.0, 1.0));

    float edge = smoothstep(0.0, 0.15, vUv.x) * smoothstep(1.0, 0.85, vUv.x);
    float alpha = edge * (0.52 + 0.48 * body);
    // Grow out of the lip rather than starting with a hard horizontal line.
    alpha *= smoothstep(1.0, 0.9, vUv.y);
    // Break the foot up instead of cutting it off square.
    alpha *= 0.34 + 0.66 * smoothstep(0.0, 0.28, vUv.y + wave * 0.05);

    if (vVeil > 0.5) {
      // Spray hanging in front of the fall: broad, faint, and thickest low down
      // where the water is hitting rock.
      col = mix(col, uFoam, 0.65);
      alpha =
        edge *
        (0.09 + 0.32 * smoothstep(0.6, 0.0, vUv.y)) *
        (0.65 + 0.35 * sin(uTime * 0.9 + vSeed * 6.2831));
    }

    col *= uTint;
    if (alpha <= 0.005) discard;
    gl_FragColor = vec4(col, alpha);
    #include <fog_fragment>
  }
`;

const POOL_VERT = /* glsl */ `
  attribute float aSeed;

  varying vec2 vUv;
  varying float vSeed;

  #include <fog_pars_vertex>

  void main() {
    vUv = uv;
    vSeed = aSeed;
    vec4 local = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      local = instanceMatrix * local;
    #endif
    vec4 mvPosition = viewMatrix * modelMatrix * local;
    #include <fog_vertex>
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const POOL_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uWater;
  uniform vec3 uFoam;
  uniform vec3 uTint;

  varying vec2 vUv;
  varying float vSeed;

  #include <fog_pars_fragment>

  void main() {
    vec2 c = vUv * 2.0 - 1.0;
    float r = length(c);
    if (r > 1.0) discard;

    // Rings running outward from the point of impact.
    float ring = sin((r * 9.0 - uTime * 1.7 + vSeed * 6.2831) * 3.1416);
    float churn = smoothstep(0.55, 0.0, r);
    float foam = clamp(churn * 0.9 + ring * 0.18 * (1.0 - r), 0.0, 1.0);
    vec3 col = mix(uWater, uFoam, foam) * uTint;

    float alpha = (0.16 + 0.7 * churn) * smoothstep(1.0, 0.62, r);
    if (alpha <= 0.005) discard;
    gl_FragColor = vec4(col, alpha);
    #include <fog_fragment>
  }
`;

interface WaterfallChunk {
  key: string;
  cx: number;
  cz: number;
  falls: number;
  sheets: InstancedMesh | null;
  pools: InstancedMesh | null;
}

/** Deep, slightly green water; the white it turns as it aerates. */
const WATER = new Color(0.24, 0.42, 0.46);
const FOAM = new Color(0.94, 0.97, 1.0);
/** Sky tints below this are lifted, or a fall vanishes completely at night. */
const PALE = new Color(0.78, 0.84, 0.9);

export function createWaterfalls(): WaterfallField {
  const group = new Group();
  group.name = 'Waterfalls';

  const uniforms = UniformsUtils.merge([
    UniformsLib.fog,
    {
      uTime: { value: 0 },
      uWater: { value: WATER.clone() },
      uFoam: { value: FOAM.clone() },
      uTint: { value: new Color(1, 1, 1) },
    },
  ]);

  const sheetMaterial = new ShaderMaterial({
    uniforms,
    vertexShader: SHEET_VERT,
    fragmentShader: SHEET_FRAG,
    transparent: true,
    // The sheet hangs a metre off the rock and the veil hangs in front of the
    // sheet; writing depth would make them fight each other and the cliff.
    depthWrite: false,
    side: DoubleSide,
    // Unlike the puddles, a fall can be six hundred metres away, so it has to
    // sit in the haze with the mountain it is falling down. That means declaring
    // three's fog uniforms and chunks properly — which is what the puddles could
    // not be bothered to do, and why they switch fog off instead.
    fog: true,
  });

  const poolMaterial = new ShaderMaterial({
    uniforms,
    vertexShader: POOL_VERT,
    fragmentShader: POOL_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
  });

  const loaded = new Map<string, WaterfallChunk>();
  const pending = new Map<string, { cx: number; cz: number; dist: number }>();
  const key = (cx: number, cz: number): string => `fall:${cx}|${cz}`;

  const matrix = new Matrix4();
  const across = new Vector3();
  const along = new Vector3();
  const normal = new Vector3();
  const centre = new Vector3();
  let drawn = 0;

  /**
   * Builds the instance matrix for one sheet.
   *
   * The quad is not vertical. It runs from the lip to the plunge point, which on
   * an 8 m lattice is up to a few dozen metres downhill, so a vertical sheet
   * would be buried in the rock at the top or hanging in mid air at the bottom.
   * Building the basis from the two ends and then pushing the whole thing out
   * along its own normal keeps it just clear of the face at every height.
   */
  const sheetMatrix = (site: WaterfallSite, width: number, lift: number, out: Matrix4): void => {
    const dsx = Math.sin(site.heading);
    const dsz = Math.cos(site.heading);

    along.set(site.x - site.bottomX, site.topY - site.bottomY, site.z - site.bottomZ);
    const length = along.length() || 1;
    along.multiplyScalar(1 / length);
    across.set(dsz, 0, -dsx);
    normal.crossVectors(across, along);
    if (normal.lengthSq() < 1e-6) normal.set(dsx, 0, dsz);
    normal.normalize();
    // The cross product's sign depends on how the fall happens to be turned;
    // force the normal downstream so `lift` always pushes away from the cliff.
    if (normal.x * dsx + normal.z * dsz < 0) normal.negate();

    centre.set(
      (site.x + site.bottomX) * 0.5,
      (site.topY + site.bottomY) * 0.5,
      (site.z + site.bottomZ) * 0.5,
    );
    centre.addScaledVector(normal, lift);

    out.makeBasis(
      across.clone().multiplyScalar(width),
      along.clone().multiplyScalar(length * 1.04),
      normal,
    );
    out.setPosition(centre);
  };

  const buildChunk = (cx: number, cz: number): void => {
    const k = key(cx, cz);
    if (loaded.has(k)) return;

    const sites = waterfallSitesInChunk(cx, cz);
    if (sites.length === 0) {
      // Recorded anyway: an empty chunk must not be rescanned every frame.
      loaded.set(k, { key: k, cx, cz, falls: 0, sheets: null, pools: null });
      return;
    }

    // --- Sheets: water plus a spray veil in front of it, two instances each ---
    const sheetCount = sites.length * 2;
    const sheetGeo = new PlaneGeometry(1, 1);
    const seeds = new Float32Array(sheetCount);
    const drops = new Float32Array(sheetCount);
    const veils = new Float32Array(sheetCount);
    const sheets = new InstancedMesh(sheetGeo, sheetMaterial, sheetCount);
    sheets.name = 'WaterfallSheet';

    // --- Pools: one disc lying in the water at the foot of each fall ---
    const poolGeo = new PlaneGeometry(1, 1);
    poolGeo.rotateX(-Math.PI / 2);
    const poolSeeds = new Float32Array(sites.length);
    const pools = new InstancedMesh(poolGeo, poolMaterial, sites.length);
    pools.name = 'WaterfallPool';

    sites.forEach((site, i) => {
      // Water.
      sheetMatrix(site, site.width, 0.8, matrix);
      sheets.setMatrixAt(i * 2, matrix);
      seeds[i * 2] = site.seed;
      drops[i * 2] = site.drop;
      veils[i * 2] = 0;
      // Spray, wider and further out.
      sheetMatrix(site, site.width * 1.7, 2.6, matrix);
      sheets.setMatrixAt(i * 2 + 1, matrix);
      seeds[i * 2 + 1] = site.seed;
      drops[i * 2 + 1] = site.drop;
      veils[i * 2 + 1] = 1;

      // The pool lies flat, so it has to sit on the highest ground it covers or
      // it ends up half buried on the uphill side — the same trap the puddles
      // fell into. Sampling the drawn surface around the rim is what fixes it.
      const radius = Math.min(9, site.width * 0.55 + site.drop * 0.05);
      let hi = surfaceGroundHeightAt(site.bottomX, site.bottomZ);
      for (let a = 0; a < 4; a++) {
        const ang = (a / 4) * Math.PI * 2;
        const h = surfaceGroundHeightAt(
          site.bottomX + Math.cos(ang) * radius,
          site.bottomZ + Math.sin(ang) * radius,
        );
        if (h > hi) hi = h;
      }
      matrix.makeScale(radius * 2, 1, radius * 2);
      matrix.setPosition(site.bottomX, hi + 0.12, site.bottomZ);
      pools.setMatrixAt(i, matrix);
      poolSeeds[i] = site.seed;
    });

    sheetGeo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
    sheetGeo.setAttribute('aDrop', new InstancedBufferAttribute(drops, 1));
    sheetGeo.setAttribute('aVeil', new InstancedBufferAttribute(veils, 1));
    poolGeo.setAttribute('aSeed', new InstancedBufferAttribute(poolSeeds, 1));
    sheets.instanceMatrix.needsUpdate = true;
    pools.instanceMatrix.needsUpdate = true;
    sheets.computeBoundingSphere();
    pools.computeBoundingSphere();
    // Drawn after the opaque world and after the ground, like the other water.
    sheets.renderOrder = 2;
    pools.renderOrder = 1;

    group.add(sheets);
    group.add(pools);
    loaded.set(k, { key: k, cx, cz, falls: sites.length, sheets, pools });
    drawn += sites.length;
  };

  const dropChunk = (chunk: WaterfallChunk): void => {
    if (chunk.sheets) {
      group.remove(chunk.sheets);
      chunk.sheets.geometry.dispose();
      chunk.sheets.dispose();
    }
    if (chunk.pools) {
      group.remove(chunk.pools);
      chunk.pools.geometry.dispose();
      chunk.pools.dispose();
    }
    drawn -= chunk.falls;
    loaded.delete(chunk.key);
  };

  const update = (position: Vector3, elapsed: number, tint: Color): void => {
    uniforms.uTime!.value = elapsed;
    // Same lift the puddles use: a fall that took the night sky's colour neat
    // would be invisible, and white water is the last thing to go dark anyway.
    const luminance = tint.r * 0.3 + tint.g * 0.6 + tint.b * 0.1;
    (uniforms.uTint!.value as Color).copy(tint).lerp(PALE, 0.35 + (1 - Math.min(1, luminance)) * 0.4);

    const pcx = Math.floor(position.x / WATERFALL_CHUNK);
    const pcz = Math.floor(position.z / WATERFALL_CHUNK);

    for (let dz = -VIEW_CHUNKS; dz <= VIEW_CHUNKS; dz++) {
      for (let dx = -VIEW_CHUNKS; dx <= VIEW_CHUNKS; dx++) {
        const k = key(pcx + dx, pcz + dz);
        if (loaded.has(k) || pending.has(k)) continue;
        pending.set(k, { cx: pcx + dx, cz: pcz + dz, dist: dx * dx + dz * dz });
      }
    }
    for (const chunk of [...loaded.values()]) {
      const ring = Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz));
      if (ring > VIEW_CHUNKS + 1) dropChunk(chunk);
    }
    for (const [k, want] of [...pending]) {
      const ring = Math.max(Math.abs(want.cx - pcx), Math.abs(want.cz - pcz));
      if (ring > VIEW_CHUNKS + 1) pending.delete(k);
    }
  };

  const pump = (deadline: number, force = true): number => {
    if (pending.size === 0) return 0;
    const queue = [...pending.entries()].sort((a, b) => a[1].dist - b[1].dist);
    for (let i = 0; i < BUILD_BUDGET && i < queue.length; i++) {
      // Respect the shared budget: the scan is cheap but it is not free, and the
      // ground under the player matters more. One build may start past the
      // deadline only on the frame this streamer holds the shared `force`.
      if ((i > 0 || !force) && performance.now() >= deadline) break;
      const [k, want] = queue[i]!;
      pending.delete(k);
      buildChunk(want.cx, want.cz);
    }
    return pending.size;
  };

  const prime = (position: Vector3, chunks: number): void => {
    const pcx = Math.floor(position.x / WATERFALL_CHUNK);
    const pcz = Math.floor(position.z / WATERFALL_CHUNK);
    for (let dz = -chunks; dz <= chunks; dz++) {
      for (let dx = -chunks; dx <= chunks; dx++) {
        buildChunk(pcx + dx, pcz + dz);
        pending.delete(key(pcx + dx, pcz + dz));
      }
    }
  };

  const dispose = (): void => {
    for (const chunk of [...loaded.values()]) dropChunk(chunk);
    pending.clear();
    sheetMaterial.dispose();
    poolMaterial.dispose();
    resetWaterfallSites();
  };

  return { group, update, pump, prime, count: () => drawn, dispose };
}
