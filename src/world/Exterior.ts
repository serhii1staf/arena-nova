import {
  BackSide,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssetManager } from '../core/AssetManager.ts';
import type { QualitySettings } from '../core/QualityManager.ts';
import { applyTriplanarUV, boxAt } from './builders/geometry.ts';
import { createLandmarks, type LandmarkStreamer } from './Landmarks.ts';
import { buildPortal, type PortalBuild } from './Portal.ts';
import { PropRegistry } from './PropRegistry.ts';
import { createScatter, type ScatterStreamer } from './Scatter.ts';
import { createTerrain, type TerrainStreamer } from './Terrain.ts';
import { Wind } from './Wind.ts';
import { createWindParticles, type WindParticleField } from './WindParticles.ts';
import { createFireflies, type FireflyField } from './Fireflies.ts';
import { createGroundMist, type GroundMistField } from './GroundMist.ts';
import { createPetals, type PetalField } from './Petals.ts';
import { createPuddles, type PuddleField } from './Puddles.ts';
import { createRain, type RainField } from './Rain.ts';
import { createSnow, type SnowField } from './Snow.ts';
import { createSnowTracks, type SnowTrackMap } from './SnowTracks.ts';
import { createWaterfalls, type WaterfallField } from './Waterfalls.ts';
import { createWildlife, type WildlifeField } from './Wildlife.ts';
import {
  resetSurfaceCache,
  surfaceBiomeAt,
  surfaceGroundHeightAt,
  surfaceHeightAt,
  WORLD,
} from './WorldGen.ts';

interface Disposable {
  dispose(): void;
}

/**
 * Milliseconds per frame the streamers may spend building. Sized to leave the
 * rest of a 60 Hz frame for rendering; the world simply arrives a little later
 * rather than costing a visible stutter.
 */
const STREAM_BUDGET_MS = 5;

/**
 * How much the near field may have queued before the distant layers stand down.
 *
 * Chosen to separate the two states that look alike in a queue length: walking
 * across a chunk boundary leaves a chunk or two pending and is the normal case,
 * while a scene switch leaves dozens and is the case where the frame has no room
 * for a village.
 */
const NEAR_BACKLOG_GRACE = 3;

/**
 * Frames the distant layers may be held back before they are let through anyway.
 *
 * Roughly a second and a half at 60 Hz. Long enough to cover the streaming burst
 * after a scene switch, short enough that a player walking continuously across a
 * large world still sees villages appear.
 */
const FAR_STARVE_FRAMES = 90;

export interface ExteriorBuild {
  group: Group;
  floorHeightAt(x: number, z: number): number;
  /**
   * The world's collider registry. Exposed so things built at runtime — the admin
   * construction pieces — can be made solid through the same path the streamed
   * props use, rather than growing a second collision system beside it.
   */
  registry: PropRegistry;
  collide(pos: Vector3): void;
  blocksCamera(x: number, y: number, z: number): boolean;
  /**
   * Material of the sky dome. The day/night cycle tints it, which is the cheapest
   * way to move the whole sky without regenerating the texture.
   */
  skyMaterial: MeshBasicMaterial;
  /**
   * Streams terrain/props around the player and advances wind, fires, the
   * night-time swarm and the weather.
   */
  update(elapsed: number, dt: number, playerPos: Vector3, air: AtmosphereState): void;
  /** Builds the immediate surroundings before gameplay starts. */
  prime(): void;
  /** Records a footfall in the lying snow at a world position. */
  markSnow(x: number, z: number): void;
  /** Mean trodden value of the snow-tracks map, 0..1. Diagnostics only. */
  snowTrodden(): number;
  dispose(): void;
  spawn: { x: number; z: number; yaw: number };
  isAtPortal(x: number, y: number, z: number): boolean;
  /** Diagnostics for the HUD. */
  stats(): {
    chunks: number;
    pending: number;
    biome: string;
    animals: number;
    /** Work still queued per streamer, so a backlog can be seen while it lasts. */
    backlog: { terrain: number; scatter: number; landmarks: number; waterfalls: number };
    /** Everything still queued, across every streamer. */
    queued: number;
    /**
     * CPU milliseconds the last frame spent building world chunks, against the
     * `STREAM_BUDGET_MS` it was allowed. The honest measure of streaming cost:
     * it excludes rendering entirely, so it is not distorted by the GPU.
     */
    streamMs: number;
    /** Where that time went, per streamer. Attributes a spike instead of guessing. */
    cost: { terrain: number; scatter: number; landmarks: number; waterfalls: number };
    /** CPU milliseconds `prime` took — the blocking part of a scene switch. */
    primeMs: number;
  };
}

/**
 * What the sky is currently doing, handed to the world each frame.
 *
 * Grouped into one object rather than added as more positional parameters: the
 * atmosphere is going to keep growing, and every addition would otherwise touch
 * the interface, the implementation and every call site.
 */
export interface AtmosphereState {
  /** 0 in daylight, 1 at full dark. */
  nightFactor: number;
  /** 0..1 ground-mist density for where the player is standing. */
  mist: number;
  /** 0..1 how hard it is raining. 0 switches the whole weather field off. */
  rain: number;
  /** 0..1 how hard it is snowing where the player is. */
  snow: number;
  /**
   * 0..1 how much snow is lying. Where it settles is the terrain's decision, from
   * each fragment's own height and slope — this is only how far the line has crept.
   */
  snowCover: number;
  /**
   * 0..1 how wet the ground is. Lags `rain` in both directions, so it is a
   * separate number rather than something the world could derive: the ground is
   * still dark and puddled for a while after the last drop falls.
   */
  wetness: number;
  /** Colour of the air, so mist and motes match the fog instead of fighting it. */
  air: Color;
}

/** Re-exported so scenes can size fog and the camera to the world. */
export { WORLD };

export function buildExterior(assets: AssetManager, settings: QualitySettings): ExteriorBuild {
  const group = new Group();
  group.name = 'Exterior';
  const disposables: Disposable[] = [];
  const track = <T extends Disposable>(d: T): T => (disposables.push(d), d);

  const registry = new PropRegistry();
  const wind = new Wind();

  // ---- Streamed world ----------------------------------------------------
  const terrain: TerrainStreamer = createTerrain(assets, settings);
  group.add(terrain.group);

  const scatter: ScatterStreamer = createScatter(assets, registry, wind);
  group.add(scatter.group);

  const landmarks: LandmarkStreamer = createLandmarks(assets, registry);
  group.add(landmarks.group);

  // Falling water where the rivers run off the escarpments. Streamed like the
  // rest of the world and derived from the same height field, so a fall is always
  // attached to the cliff that produced it.
  const waterfalls: WaterfallField = createWaterfalls();
  group.add(waterfalls.group);

  // ---- Ocean: a single plane that follows the player ---------------------
  const ocean = (() => {
    const geo = track(new PlaneGeometry(1, 1));
    geo.rotateX(-Math.PI / 2);
    const mat = track(
      new MeshStandardMaterial({
        color: new Color(0.08, 0.24, 0.3),
        transparent: true,
        opacity: 0.88,
        roughness: 0.1,
        metalness: 0.4,
      }),
    );
    const mesh = new Mesh(geo, mat);
    // Two triangles, so the size is free — and it needs to be this big. At 4200
    // it reached 2.1 km from the player, which was past the horizon at the old
    // ground level and is nothing like far enough now that you can stand on a
    // 380 m summit: the sea's own edge showed up as a hard pale rectangle lying
    // across the middle distance. 9000 matches the camera's far plane and stays
    // just inside the sky dome, by which distance the haze has swallowed it.
    mesh.scale.set(9000, 1, 9000);
    mesh.position.y = WORLD.waterLevel;
    group.add(mesh);
    return mesh;
  })();

  // ---- Sky ---------------------------------------------------------------
  const skyMaterial = track(
    new MeshBasicMaterial({ map: assets.sky(), side: BackSide, fog: false, depthWrite: false }),
  );
  const sky = (() => {
    const geo = track(new SphereGeometry(WORLD.halfSize * 1.6, 48, 28));
    const mesh = new Mesh(geo, skyMaterial);
    mesh.renderOrder = -2;
    group.add(mesh);
    return mesh;
  })();

  // ---- Wind-borne particles ---------------------------------------------
  const particles: WindParticleField = createWindParticles(
    wind,
    Math.floor(settings.particleCount * 0.55),
    95,
  );
  group.add(particles.points);

  // ---- Fireflies (night only) -------------------------------------------
  const fireflies: FireflyField = createFireflies(
    Math.max(60, Math.floor(settings.particleCount * 0.4)),
    60,
  );
  group.add(fireflies.points);

  // ---- Ground mist ------------------------------------------------------
  // Fewer, larger patches than the other fields: these are metres across, so a
  // high count buys overdraw rather than detail. Held to a modest ceiling even on
  // ultra for that reason.
  const mist: GroundMistField = createGroundMist(
    Math.max(40, Math.min(190, Math.floor(settings.particleCount * 0.075))),
    72,
  );
  group.add(mist.points);

  // ---- Sakura petals (grove only) ---------------------------------------
  const petals: PetalField = createPetals(
    Math.max(80, Math.floor(settings.particleCount * 0.35)),
    60,
    wind,
  );
  group.add(petals.points);

  // ---- Rain --------------------------------------------------------------
  // `drawDistance` is otherwise unused outdoors (the streamer sizes the view by
  // ring count instead), and it is exactly the right number for this: how far out
  // the weather box needs to reach. A smaller box on a weak device holds the same
  // number of drops closer in, so the rain stays as dense as it looks on ultra.
  const rainExtent = Math.max(22, Math.min(58, settings.drawDistance * 0.16));
  const rain: RainField = createRain(
    Math.max(240, Math.floor(settings.particleCount * 0.9)),
    rainExtent,
    wind,
  );
  group.add(rain.points);

  // ---- Snow --------------------------------------------------------------
  // Fewer flakes than raindrops over a wider box. A flake is visible for ten
  // times as long as a drop — it falls at about a tenth the speed — so the same
  // count reads as a far denser fall, and the box has to be wider because the
  // wind carries snow much further sideways before it lands.
  const snowExtent = rainExtent * 1.25;
  const snow: SnowField = createSnow(
    Math.max(200, Math.floor(settings.particleCount * 0.55)),
    snowExtent,
    wind,
  );
  group.add(snow.points);

  // Tracks walked through lying snow. Null when there is no 2D canvas to draw on,
  // which is not an error: the snow simply stays smooth.
  const snowTracks: SnowTrackMap | null = createSnowTracks();

  // ---- Puddles -----------------------------------------------------------
  // A handful of patches, one instanced draw call. Kept low deliberately: each
  // one is metres across, so more of them buys overlapping water rather than
  // more convincing water, and they are the only part of the weather that costs
  // triangles at all.
  const puddles: PuddleField = createPuddles(
    Math.max(6, Math.min(26, Math.round(settings.particleCount / 180))),
    assets.sky(),
    rainExtent * 1.15,
  );
  group.add(puddles.mesh);

  // ---- Wildlife ----------------------------------------------------------
  // Scaled by the quality tier, but never below a handful — an empty forest is
  // worse than a slightly busier one.
  const wildlife: WildlifeField = createWildlife(Math.min(1.2, settings.vegetationDensity));
  group.add(wildlife.group);

  // ---- Portal monolith at spawn -----------------------------------------
  const plazaY = surfaceHeightAt(0, 0);
  // High enough that the vortex clears the plaza. At 3.4 the quad is 7.4 tall, so
  // its bottom edge sat 0.3 m *under* the ground and the terrain depth-clipped the
  // additive surface along a dead-straight horizontal line at the point of contact.
  const portalPos = new Vector3(0, plazaY + 4.1, 0);
  const portal: PortalBuild = (() => {
    const stoneTex = assets.stone(1);
    const mat = track(
      new MeshStandardMaterial({
        map: stoneTex.map,
        normalMap: stoneTex.normalMap,
        roughnessMap: stoneTex.roughnessMap,
        color: new Color(0.5, 0.53, 0.5),
        roughness: 1,
        metalness: 0,
      }),
    );
    const parts: BufferGeometry[] = [];
    const slabH = 12;
    parts.push(boxAt(5.5, slabH, 3.4, -5.4, slabH / 2, 0));
    parts.push(boxAt(5.5, slabH, 3.4, 5.4, slabH / 2, 0));
    parts.push(boxAt(15.4, 3.4, 3.4, 0, slabH - 1.7, 0));
    parts.push(boxAt(17, 1.4, 5.2, 0, 0.7, 0));
    const merged = mergeGeometries(
      parts.map((p) => (p.index ? p.toNonIndexed() : p)),
      false,
    );
    for (const p of parts) p.dispose();
    if (!merged) throw new Error('Exterior: monolith merge failed');
    const slab = track(applyTriplanarUV(merged, 0.35));
    const monolith = new Mesh(slab, mat);
    monolith.position.set(0, plazaY, 0);
    monolith.castShadow = true;
    monolith.receiveShadow = true;
    group.add(monolith);

    const slabTop = plazaY + slabH;
    registry.add('spawn', { x: -5.4, z: 0, r: 2.9, top: slabTop, blockTop: slabTop, solid: true });
    registry.add('spawn', { x: 5.4, z: 0, r: 2.9, top: slabTop, blockTop: slabTop, solid: true });

    const built = buildPortal({
      position: portalPos,
      width: 5.2,
      height: 7.4,
      facing: 0,
      withArch: false,
    });
    group.add(built.group);
    return built;
  })();

  // ---- Collision --------------------------------------------------------
  const shoreY = WORLD.waterLevel + 0.4;
  const limit = WORLD.halfSize - 40;

  /**
   * Ground height, raised to the top of anything standable underfoot.
   *
   * Reads the *drawn* surface. Using the analytic field here is what let the
   * player sink through hillsides: over one 8 m mesh cell the smooth curve can
   * sit a metre below its own secant, and the controller snaps to the curve.
   */
  const floorHeightAt = (x: number, z: number): number => {
    let h = surfaceGroundHeightAt(x, z);
    registry.forEachNear(x, z, (p) => {
      if (p.top <= h) return;
      const dx = x - p.x;
      const dz = z - p.z;
      const r = p.r * 0.85;
      if (dx * dx + dz * dz < r * r) h = p.top;
    });
    return h;
  };

  const collide = (p: Vector3): void => {
    p.x = Math.max(-limit, Math.min(limit, p.x));
    p.z = Math.max(-limit, Math.min(limit, p.z));

    const pr = 0.4;
    registry.forEachNear(p.x, p.z, (o) => {
      if (!o.solid) return;
      // Only stop pushing once the player is actually above the obstacle. For a
      // tree `blockTop` is far above `top`, so trunks stay solid at body height.
      if (p.y >= o.blockTop - 0.15) return;
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const minD = o.r + pr;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD * minD && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (minD - d) / d;
        p.x += dx * push;
        p.z += dz * push;
      }
    });

    // Shoreline barrier: walk up the height gradient back onto dry land.
    for (let i = 0; i < 6; i++) {
      if (surfaceHeightAt(p.x, p.z) >= shoreY) break;
      const gx = surfaceHeightAt(p.x + 2, p.z) - surfaceHeightAt(p.x - 2, p.z);
      const gz = surfaceHeightAt(p.x, p.z + 2) - surfaceHeightAt(p.x, p.z - 2);
      const len = Math.hypot(gx, gz);
      if (len < 1e-4) break;
      p.x += (gx / len) * 1.2;
      p.z += (gz / len) * 1.2;
    }
  };

  const blocksCamera = (x: number, y: number, z: number): boolean => {
    if (y < surfaceGroundHeightAt(x, z) + 0.3) return true;
    let hit = false;
    registry.forEachNear(x, z, (o) => {
      if (hit || y > o.blockTop) return;
      const dx = x - o.x;
      const dz = z - o.z;
      const r = o.r * 0.72;
      if (dx * dx + dz * dz < r * r) hit = true;
    });
    return hit;
  };

  // ---- Frame update -----------------------------------------------------
  const centre = new Vector3();
  /** Work each streamer still had queued after the last pump. Diagnostics only. */
  const backlog = { terrain: 0, scatter: 0, landmarks: 0, waterfalls: 0 };
  /** Whose turn it is to be allowed one build past the shared deadline. */
  let forceTurn = 0;
  /** Frames the distant layers have been held back by the near-field backlog. */
  let farStarved = 0;
  /** Where the last frame's streaming time went, per streamer. Diagnostics only. */
  const cost = { terrain: 0, scatter: 0, landmarks: 0, waterfalls: 0 };
  /** CPU cost of the last frame's streaming step, in ms. Diagnostics only. */
  let streamMs = 0;
  /** CPU cost of `prime`, in ms — the synchronous part of the scene switch. */
  let primeMs = 0;

  const update = (
    elapsed: number,
    dt: number,
    playerPos: Vector3,
    air: AtmosphereState,
  ): void => {
    wind.update(dt, elapsed);

    // Keep the world-sized props centred on the player so they never run out.
    centre.set(playerPos.x, 0, playerPos.z);
    ocean.position.set(playerPos.x, WORLD.waterLevel, playerPos.z);
    sky.position.set(playerPos.x, 0, playerPos.z);
    particles.update(playerPos);
    fireflies.update(playerPos, elapsed, air.nightFactor);
    mist.update(playerPos, elapsed, air.mist, air.air);
    petals.update(playerPos, elapsed, surfaceBiomeAt(playerPos.x, playerPos.z));
    // Weather. The puddles take the sky dome's own tint, read straight off the
    // material the day/night cycle just wrote it into, so a reflection can never
    // end up brighter than the sky it is supposed to be reflecting.
    rain.update(playerPos, elapsed, air.rain, air.air);
    snow.update(playerPos, elapsed, air.snow, air.air);
    puddles.update(playerPos, elapsed, air.wetness, air.rain, skyMaterial.color);
    terrain.setWetness(air.wetness);
    // The tracks map follows the player and heals as snow falls; the terrain reads
    // both the depth and the map from the one shared material.
    snowTracks?.update(playerPos.x, playerPos.z, air.snow, dt);
    terrain.setSnow(air.snowCover, snowTracks);
    wildlife.update(dt, playerPos);

    terrain.update(playerPos);
    scatter.update(playerPos);
    landmarks.update(playerPos, elapsed);
    waterfalls.update(playerPos, elapsed, air.air);

    // Streaming shares one time budget per frame, spent in priority order:
    // ground first (nothing may be missing under the player), then vegetation,
    // then landmarks. A fixed chunk count per frame could not do this — chunk
    // cost swings by an order of magnitude depending on LOD and how much of the
    // height lattice is already cached, so it either wasted headroom or blew the
    // frame. This is what the visible hitching while running came down to.
    const streamStart = performance.now();
    const deadline = streamStart + STREAM_BUDGET_MS;
    // One streamer per frame may overrun the budget by a single build; the other
    // three stop at the deadline. The turn rotates, so every layer still makes
    // guaranteed progress even while the ground is eating the whole budget.
    //
    // Each streamer used to take that liberty unconditionally, and the four of them
    // are pumped from one shared deadline — so a frame whose budget terrain had
    // already spent still went on to start a vegetation chunk, a landmark cell and
    // a waterfall scan, each of which runs to completion once begun. Four
    // unbounded builds on top of an exhausted budget, on every frame, for as long
    // as the backlog lasted: measured at 150 ms on a single frame against a 5 ms
    // budget, which is what the drop leaving the lobby actually was.
    //
    // Terrain is first in the rotation as well as first in priority, because it is
    // the one layer whose absence is not cosmetic.
    forceTurn = (forceTurn + 1) % 4;
    let mark = streamStart;
    backlog.terrain = terrain.pump(deadline, forceTurn === 0);
    cost.terrain = (mark = performance.now()) - streamStart;
    backlog.scatter = scatter.pump(deadline, forceTurn === 1);
    const afterScatter = performance.now();
    cost.scatter = afterScatter - mark;

    // The priority order above was only ever a comment. In practice all four
    // streamers were pumped from the same budget on the same frame, so a village
    // several hundred metres away competed with the ground under the player — and a
    // village is by far the most expensive single thing the world builds, measured
    // at over 200 ms of CPU against a 5 ms budget, where the worst terrain chunk in
    // the same run cost 11 ms.
    //
    // A time budget cannot help with that on its own: it decides whether a build
    // may *start*, never how long it takes, and a village that starts with 0.1 ms
    // of budget left still runs to completion. So the far layers stand down
    // entirely while the near field has a real backlog behind it, which is the
    // state that only happens for a second or two after the world is rebuilt.
    //
    // The threshold is a backlog, not simply "anything queued": walking briskly
    // keeps a chunk or two on the queue almost permanently, and gating on that
    // would starve the distant scenery for the whole session rather than for the
    // moment it is in the way.
    // Standing down has to have a floor under it. On hardware slow enough that the
    // near field takes hundreds of frames to drain, an unconditional gate would
    // hold the distant scenery back for as long as the player kept walking, so
    // after a while the far layers get a frame regardless of the backlog. Measured
    // under a software rasteriser at about one frame a second, where the gate
    // otherwise never opened at all.
    farStarved++;
    const nearBacklogged =
      farStarved < FAR_STARVE_FRAMES &&
      (backlog.terrain > NEAR_BACKLOG_GRACE || backlog.scatter > NEAR_BACKLOG_GRACE);
    if (!nearBacklogged) farStarved = 0;
    // A deadline already in the past, with no force, makes a pump a no-op that
    // still reports what it has waiting.
    const farDeadline = nearBacklogged ? 0 : deadline;
    backlog.landmarks = landmarks.pump(farDeadline, !nearBacklogged && forceTurn === 2);
    const afterLandmarks = performance.now();
    cost.landmarks = afterLandmarks - afterScatter;
    backlog.waterfalls = waterfalls.pump(farDeadline, !nearBacklogged && forceTurn === 3);
    cost.waterfalls = performance.now() - afterLandmarks;
    // What the streaming step actually cost, against the budget it was given.
    // Measured rather than assumed: the budget is advisory, every streamer is
    // allowed to finish the build it has started, and how far past the deadline
    // that carries it is the whole question. GPU-independent, so this number means
    // the same thing on real hardware and under a software rasteriser.
    streamMs = performance.now() - streamStart;

    portal.update(elapsed);
  };

  const prime = (): void => {
    const t0 = performance.now();
    const start = new Vector3(0, 0, 0);
    terrain.prime(start, 2);
    scatter.prime(start, 1);
    landmarks.prime(start, 1);
    waterfalls.prime(start, 1);
    primeMs = performance.now() - t0;
  };

  const dispose = (): void => {
    portal.dispose();
    particles.dispose();
    fireflies.dispose();
    mist.dispose();
    petals.dispose();
    rain.dispose();
    snow.dispose();
    snowTracks?.dispose();
    puddles.dispose();
    wildlife.dispose();
    waterfalls.dispose();
    landmarks.dispose();
    scatter.dispose();
    terrain.dispose();
    registry.clear();
    // The lattice cache can hold a few hundred thousand samples; leaving it
    // alive across a scene switch would be a slow memory leak.
    resetSurfaceCache();
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    disposables.length = 0;
  };

  // Spawn just outside the portal, facing away from it into the world.
  const spawnZ = 15;
  return {
    group,
    floorHeightAt,
    registry,
    collide,
    blocksCamera,
    skyMaterial,
    update,
    prime,
    markSnow: (x, z) => snowTracks?.stamp(x, z),
    snowTrodden: () => snowTracks?.coverage() ?? 0,
    dispose,
    spawn: { x: 0, z: spawnZ, yaw: Math.PI },
    isAtPortal: (x, y, z) => portal.contains(x, y, z),
    stats: () => ({
      chunks: terrain.loadedChunks(),
      pending: terrain.pendingChunks(),
      biome: surfaceBiomeAt(centre.x, centre.z),
      animals: wildlife.count(),
      // Everything still waiting to be built, per streamer. `pending` above stays
      // as it was — terrain only — because the existing probes assert on it.
      backlog: { ...backlog },
      queued: backlog.terrain + backlog.scatter + backlog.landmarks + backlog.waterfalls,
      streamMs,
      cost: { ...cost },
      primeMs,
    }),
  };
}
