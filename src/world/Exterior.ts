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

export interface ExteriorBuild {
  group: Group;
  floorHeightAt(x: number, z: number): number;
  collide(pos: Vector3): void;
  blocksCamera(x: number, y: number, z: number): boolean;
  /**
   * Material of the sky dome. The day/night cycle tints it, which is the cheapest
   * way to move the whole sky without regenerating the texture.
   */
  skyMaterial: MeshBasicMaterial;
  /**
   * Streams terrain/props around the player and advances wind, fires and the
   * night-time swarm. `nightFactor` is 0 in daylight and 1 at full dark.
   */
  update(elapsed: number, dt: number, playerPos: Vector3, nightFactor: number): void;
  /** Builds the immediate surroundings before gameplay starts. */
  prime(): void;
  dispose(): void;
  spawn: { x: number; z: number; yaw: number };
  isAtPortal(x: number, y: number, z: number): boolean;
  /** Diagnostics for the HUD. */
  stats(): { chunks: number; pending: number; biome: string; animals: number };
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
    mesh.scale.set(4200, 1, 4200);
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

  // ---- Wildlife ----------------------------------------------------------
  // Scaled by the quality tier, but never below a handful — an empty forest is
  // worse than a slightly busier one.
  const wildlife: WildlifeField = createWildlife(Math.min(1.2, settings.vegetationDensity));
  group.add(wildlife.group);

  // ---- Portal monolith at spawn -----------------------------------------
  const plazaY = surfaceHeightAt(0, 0);
  const portalPos = new Vector3(0, plazaY + 3.4, 0);
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
      parts.map((p) => p.toNonIndexed()),
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

  const update = (
    elapsed: number,
    dt: number,
    playerPos: Vector3,
    nightFactor: number,
  ): void => {
    wind.update(dt, elapsed);

    // Keep the world-sized props centred on the player so they never run out.
    centre.set(playerPos.x, 0, playerPos.z);
    ocean.position.set(playerPos.x, WORLD.waterLevel, playerPos.z);
    sky.position.set(playerPos.x, 0, playerPos.z);
    particles.update(playerPos);
    fireflies.update(playerPos, elapsed, nightFactor);
    wildlife.update(dt, playerPos);

    terrain.update(playerPos);
    scatter.update(playerPos);
    landmarks.update(playerPos, elapsed);

    // Streaming shares one time budget per frame, spent in priority order:
    // ground first (nothing may be missing under the player), then vegetation,
    // then landmarks. A fixed chunk count per frame could not do this — chunk
    // cost swings by an order of magnitude depending on LOD and how much of the
    // height lattice is already cached, so it either wasted headroom or blew the
    // frame. This is what the visible hitching while running came down to.
    const deadline = performance.now() + STREAM_BUDGET_MS;
    terrain.pump(deadline);
    scatter.pump(deadline);
    landmarks.pump(deadline);

    portal.update(elapsed);
  };

  const prime = (): void => {
    const start = new Vector3(0, 0, 0);
    terrain.prime(start, 2);
    scatter.prime(start, 1);
    landmarks.prime(start, 1);
  };

  const dispose = (): void => {
    portal.dispose();
    particles.dispose();
    fireflies.dispose();
    wildlife.dispose();
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
    collide,
    blocksCamera,
    skyMaterial,
    update,
    prime,
    dispose,
    spawn: { x: 0, z: spawnZ, yaw: Math.PI },
    isAtPortal: (x, y, z) => portal.contains(x, y, z),
    stats: () => ({
      chunks: terrain.loadedChunks(),
      pending: terrain.pendingChunks(),
      biome: surfaceBiomeAt(centre.x, centre.z),
      animals: wildlife.count(),
    }),
  };
}
