import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssetManager } from '../core/AssetManager.ts';
import {
  applyTriplanarUV,
  boxAt,
  buildArchRibGeometry,
  buildColumnGeometry,
  buildRockGeometry,
  buildVaultGeometry,
  buildWindowArchGeometry,
  scaleLatheUV,
} from './builders/geometry.ts';

/**
 * Cathedral layout — the single source of truth for dimensions. Vegetation and
 * Atmosphere read from this so everything lines up. Nave runs along Z; the
 * glowing apse is at −Z (players spawn near +Z and walk toward the light).
 */
export const LAYOUT = {
  naveHalfWidth: 6, // column rows at x = ±6
  aisleHalfWidth: 10, // outer walls
  wallThickness: 0.8,
  columnHeight: 12,
  columnRadius: 0.68,
  columnZs: [24, 17, 10, 3, -4, -11, -18] as number[],
  entranceZ: 30,
  apseZ: -30,
  clerestoryTop: 21,
  vaultRidge: 29,
  window: { sillH: 2.4, topH: 11, width: 4.2 },
  stairs: { bottomZ: -13, topZ: -21, platformH: 1.8, steps: 9 },
  playerRadius: 0.35,
} as const;

export interface CathedralBuild {
  group: Group;
  /** Emissive apse window — the god-rays light source. */
  sunMesh: Mesh;
  /** Resolve horizontal collisions in-place (walls + columns). */
  collide(pos: Vector3): void;
  /** Walkable floor height at a world XZ (accounts for the apse stairs). */
  floorHeightAt(x: number, z: number): number;
  /** True when a point is inside a wall/column (third-person camera clamp). */
  blocksCamera(x: number, y: number, z: number): boolean;
  dispose(): void;
}

interface Disposable {
  dispose(): void;
}

/**
 * Builds jagged 3D glass-shard fragments clinging to the frame of one window
 * opening (local plane centred at origin, width×height, normal +Z). The centre
 * is left broken-out so the exterior shows through. Returns a merged geometry.
 */
function buildGlassShards(width: number, height: number, seedBase: number): BufferGeometry {
  const hw = width / 2;
  const hh = height / 2;
  let s = seedBase >>> 0;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967295);

  const verts: number[] = [];
  const tri = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): void => {
    const jz = (): number => (rnd() - 0.5) * 0.05; // slight shatter tilt
    verts.push(ax, ay, jz(), bx, by, jz(), cx, cy, jz());
  };

  // Fringe of shards along each edge, apex jutting toward the centre.
  const edge = (count: number, at: (t: number) => [number, number]): void => {
    for (let i = 0; i < count; i++) {
      if (rnd() < 0.35) continue; // missing shard (broken out)
      const [ax, ay] = at(i / count);
      const [bx, by] = at((i + 1) / count);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const depth = 0.25 + rnd() * 0.5;
      tri(ax, ay, bx, by, mx * depth + (rnd() - 0.5) * 0.15, my * depth + (rnd() - 0.5) * 0.15);
    }
  };
  edge(6, (t) => [-hw + t * width, hh]); // top
  edge(6, (t) => [-hw + t * width, -hh]); // bottom
  edge(5, (t) => [-hw, hh - t * height]); // left
  edge(5, (t) => [hw, hh - t * height]); // right

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
  geo.computeVertexNormals();
  return geo;
}

export function buildCathedral(assets: AssetManager): CathedralBuild {
  const group = new Group();
  group.name = 'Cathedral';
  const disposables: Disposable[] = [];
  const track = <T extends Disposable>(d: T): T => {
    disposables.push(d);
    return d;
  };

  // Walkable floor height. The stairs/platform only occupy the central nave
  // width; the side aisles stay flat (fixes vegetation/rocks "floating").
  const stairsHalfWidth = LAYOUT.naveHalfWidth + 0.5;
  const floorHeightAt = (x: number, z: number): number => {
    const { bottomZ, topZ, platformH } = LAYOUT.stairs;
    if (z >= bottomZ) return 0;
    if (Math.abs(x) > stairsHalfWidth) return 0;
    if (z <= topZ) return platformH;
    return ((bottomZ - z) / (bottomZ - topZ)) * platformH;
  };

  // ---- Materials ---------------------------------------------------------
  // One tiling stone set; density is controlled per-mesh via UVs, so textures
  // never look stretched no matter the face size.
  const stoneTex = assets.stone(1);
  const stoneMat = track(
    new MeshStandardMaterial({
      map: stoneTex.map,
      normalMap: stoneTex.normalMap,
      roughnessMap: stoneTex.roughnessMap,
      color: new Color(0.72, 0.76, 0.66),
      roughness: 1,
      metalness: 0,
    }),
  );

  const floorMat = track(
    new MeshStandardMaterial({
      map: stoneTex.map,
      normalMap: stoneTex.normalMap,
      roughnessMap: stoneTex.roughnessMap,
      color: new Color(0.62, 0.68, 0.56),
      roughness: 0.95,
      metalness: 0,
    }),
  );

  // The apse glow: pure bright emissive that blooms and drives god rays.
  const glowMat = track(
    new MeshBasicMaterial({
      color: new Color(0.85, 1.0, 0.8),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }),
  );

  // Translucent glass — a few tints; shards catch light, centre broken out.
  const glassMats = [
    new Color(0.55, 0.82, 0.72),
    new Color(0.5, 0.72, 0.86),
    new Color(0.86, 0.86, 0.62),
  ].map((c) =>
    track(
      new MeshStandardMaterial({
        color: c,
        transparent: true,
        opacity: 0.42,
        roughness: 0.12,
        metalness: 0,
        side: DoubleSide,
        depthWrite: false,
      }),
    ),
  );

  let glassPick = 0;
  const addWindowGlass = (
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    rotY: number,
  ): void => {
    const seed = Math.floor(Math.abs(x * 31 + z * 17 + width * 7)) + 1;
    const geo = track(buildGlassShards(width, height, seed));
    const mesh = new Mesh(geo, glassMats[glassPick++ % glassMats.length]!);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotY;
    group.add(mesh);
  };

  // ---- Floor -------------------------------------------------------------
  {
    const w = LAYOUT.aisleHalfWidth * 2;
    const d = LAYOUT.entranceZ - LAYOUT.apseZ;
    const cz = (LAYOUT.entranceZ + LAYOUT.apseZ) / 2;
    const floorGeo = applyTriplanarUV(boxAt(w, 0.4, d, 0, -0.2, cz), 0.5);
    const floor = new Mesh(floorGeo, floorMat);
    floor.receiveShadow = true;
    group.add(floor);
    track(floorGeo);
  }

  // ---- Outer aisle walls -------------------------------------------------
  // Non-overlapping pieces (sill band + mullion piers + lintel band) so faces
  // never coincide → no z-fighting/flicker. Window openings hold broken glass.
  const buildSideWall = (sign: number): void => {
    const x = sign * LAYOUT.aisleHalfWidth;
    const t = LAYOUT.wallThickness;
    const parts: BufferGeometry[] = [];
    const zs = LAYOUT.columnZs;
    const wallTop = LAYOUT.clerestoryTop;
    const { sillH, topH } = LAYOUT.window;
    const pierW = 2;

    // Span the FULL nave so the side walls meet both end walls (no corner gaps).
    const zA = LAYOUT.entranceZ;
    const zB = LAYOUT.apseZ;
    const len = zA - zB;
    const cz = (zA + zB) / 2;
    // Mullions at the columns plus one over the apse platform.
    const pierCenters = [...zs, -25];

    // Full-length sill (below windows) and lintel (above windows) bands.
    parts.push(boxAt(t, sillH, len, x, sillH / 2, cz));
    parts.push(boxAt(t, wallTop - topH, len, x, (topH + wallTop) / 2, cz));
    // End jambs closing the wall at both ends.
    parts.push(boxAt(t, topH - sillH, pierW, x, (sillH + topH) / 2, zA - pierW / 2));
    parts.push(boxAt(t, topH - sillH, pierW, x, (sillH + topH) / 2, zB + pierW / 2));
    // Mullion piers between windows (only in the window's vertical band).
    for (const z of pierCenters) {
      parts.push(boxAt(t, topH - sillH, pierW, x, (sillH + topH) / 2, z));
    }

    const merged = applyTriplanarUV(mergeGeometries(parts.map((g) => g.toNonIndexed()), false), 0.4);
    for (const g of parts) g.dispose();
    track(merged);
    const wall = new Mesh(merged, stoneMat);
    wall.castShadow = true;
    wall.receiveShadow = true;
    group.add(wall);

    // Broken glass filling each opening between adjacent piers.
    // Broken glass shards in each opening between adjacent piers.
    const pierZs = [zA - pierW / 2, ...pierCenters, zB + pierW / 2].sort((a, b) => b - a);
    for (let i = 0; i < pierZs.length - 1; i++) {
      const gapCenter = (pierZs[i]! + pierZs[i + 1]!) / 2;
      const gapWidth = pierZs[i]! - pierZs[i + 1]! - pierW;
      if (gapWidth < 0.6) continue;
      addWindowGlass(
        x - sign * 0.02,
        (sillH + topH) / 2,
        gapCenter,
        gapWidth,
        topH - sillH,
        sign > 0 ? -Math.PI / 2 : Math.PI / 2,
      );
    }
  };
  buildSideWall(1);
  buildSideWall(-1);

  // ---- Entrance & apse end walls ----------------------------------------
  {
    // Overlap the side walls' thickness so the four corners are sealed.
    const w = LAYOUT.aisleHalfWidth * 2 + LAYOUT.wallThickness * 2;
    // Entrance wall (behind spawn) with a tall doorway gap.
    const entranceParts: BufferGeometry[] = [];
    const doorW = 4;
    const sideW = (w - doorW) / 2;
    entranceParts.push(boxAt(sideW, LAYOUT.clerestoryTop, 0.8, -(doorW + sideW) / 2, LAYOUT.clerestoryTop / 2, LAYOUT.entranceZ));
    entranceParts.push(boxAt(sideW, LAYOUT.clerestoryTop, 0.8, (doorW + sideW) / 2, LAYOUT.clerestoryTop / 2, LAYOUT.entranceZ));
    entranceParts.push(boxAt(doorW, LAYOUT.clerestoryTop - 6, 0.8, 0, (6 + LAYOUT.clerestoryTop) / 2, LAYOUT.entranceZ));
    const em = applyTriplanarUV(mergeGeometries(entranceParts.map((g) => g.toNonIndexed()), false), 0.4);
    for (const g of entranceParts) g.dispose();
    track(em);
    const entranceWall = new Mesh(em, stoneMat);
    entranceWall.castShadow = true;
    entranceWall.receiveShadow = true;
    group.add(entranceWall);

    // Apse back wall (solid) — the glow plane sits just in front of it.
    const apseGeo = applyTriplanarUV(boxAt(w, LAYOUT.vaultRidge, 0.8, 0, LAYOUT.vaultRidge / 2, LAYOUT.apseZ), 0.4);
    track(apseGeo);
    const apseWall = new Mesh(apseGeo, stoneMat);
    apseWall.receiveShadow = true;
    group.add(apseWall);

    // Big pointed window frame on the apse wall.
    const frameGeo = applyTriplanarUV(buildWindowArchGeometry(9, 20, 0.7, 1.2), 0.4);
    frameGeo.translate(0, 3, LAYOUT.apseZ + 0.7);
    track(frameGeo);
    const frame = new Mesh(frameGeo, stoneMat);
    frame.castShadow = true;
    group.add(frame);
  }

  // ---- The apse glow (sun / god-rays source) -----------------------------
  const sunGeo = track(new CircleGeometry(4.2, 40));
  const sunMesh = new Mesh(sunGeo, glowMat);
  sunMesh.position.set(0, 9, LAYOUT.apseZ + 0.9);
  sunMesh.renderOrder = -1;
  group.add(sunMesh);

  // ---- Columns (instanced) ----------------------------------------------
  const colGeo = track(
    scaleLatheUV(
      buildColumnGeometry(LAYOUT.columnHeight, LAYOUT.columnRadius),
      LAYOUT.columnRadius,
      LAYOUT.columnHeight,
      0.4,
    ),
  );
  const colPositions: Vector3[] = [];
  for (const z of LAYOUT.columnZs) {
    colPositions.push(new Vector3(LAYOUT.naveHalfWidth, 0, z));
    colPositions.push(new Vector3(-LAYOUT.naveHalfWidth, 0, z));
  }
  const columns = new InstancedMesh(colGeo, stoneMat, colPositions.length);
  columns.castShadow = true;
  columns.receiveShadow = true;
  {
    const m = new Matrix4();
    const q = new Quaternion();
    const s = new Vector3(1, 1, 1);
    colPositions.forEach((p, i) => {
      m.compose(p, q, s);
      columns.setMatrixAt(i, m);
    });
    columns.instanceMatrix.needsUpdate = true;
  }
  group.add(columns);

  // ---- Arch ribs -------------------------------------------------------------
  // Longitudinal ribs connect columns along each side; transverse ribs cross
  // the nave. Both are instanced from a single tube geometry.
  const zs = LAYOUT.columnZs;
  const capitalY = LAYOUT.columnHeight - 0.4;

  const longSpan = Math.abs(zs[0]! - zs[1]!);
  const longRib = track(applyTriplanarUV(buildArchRibGeometry(longSpan, longSpan * 0.42, 0.22), 0.6));
  const longMeshes = new InstancedMesh(longRib, stoneMat, (zs.length - 1) * 2);
  longMeshes.castShadow = true;
  {
    const m = new Matrix4();
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const s = new Vector3(1, 1, 1);
    let i = 0;
    for (let k = 0; k < zs.length - 1; k++) {
      const zMid = (zs[k]! + zs[k + 1]!) / 2;
      for (const sx of [LAYOUT.naveHalfWidth, -LAYOUT.naveHalfWidth]) {
        m.compose(new Vector3(sx, capitalY, zMid), q, s);
        longMeshes.setMatrixAt(i++, m);
      }
    }
    longMeshes.instanceMatrix.needsUpdate = true;
  }
  group.add(longMeshes);

  const transSpan = LAYOUT.naveHalfWidth * 2;
  const transRib = track(applyTriplanarUV(buildArchRibGeometry(transSpan, transSpan * 0.5, 0.24), 0.6));
  const transMeshes = new InstancedMesh(transRib, stoneMat, zs.length);
  transMeshes.castShadow = true;
  {
    const m = new Matrix4();
    const q = new Quaternion();
    const s = new Vector3(1, 1, 1);
    zs.forEach((z, i) => {
      m.compose(new Vector3(0, capitalY, z), q, s);
      transMeshes.setMatrixAt(i, m);
    });
    transMeshes.instanceMatrix.needsUpdate = true;
  }
  group.add(transMeshes);

  // ---- Vaulted ceiling ---------------------------------------------------
  {
    const length = LAYOUT.entranceZ - LAYOUT.apseZ;
    const vaultGeo = buildVaultGeometry(
      transSpan + 2.2,
      LAYOUT.clerestoryTop - 2,
      LAYOUT.vaultRidge,
      length,
      0.6,
    );
    vaultGeo.translate(0, 0, (LAYOUT.entranceZ + LAYOUT.apseZ) / 2);
    applyTriplanarUV(vaultGeo, 0.3);
    track(vaultGeo);
    const vault = new Mesh(vaultGeo, stoneMat);
    vault.receiveShadow = true;
    vault.castShadow = true;
    group.add(vault);

    // Aisle ceilings: close the open strips between the vault edge and the
    // outer walls, so the side aisles are roofed and the ribs read as
    // supporting something instead of floating.
    const aisleParts: BufferGeometry[] = [];
    const innerX = LAYOUT.naveHalfWidth + 0.4;
    const outerX = LAYOUT.aisleHalfWidth + LAYOUT.wallThickness / 2;
    const aisleW = outerX - innerX;
    const aisleY = LAYOUT.clerestoryTop - 1.2;
    for (const sx of [1, -1]) {
      aisleParts.push(boxAt(aisleW, 0.5, length, sx * (innerX + aisleW / 2), aisleY, 0));
    }
    const aisleGeo = mergeGeometries(aisleParts.map((g) => g.toNonIndexed()), false);
    for (const g of aisleParts) g.dispose();
    aisleGeo.translate(0, 0, (LAYOUT.entranceZ + LAYOUT.apseZ) / 2);
    applyTriplanarUV(aisleGeo, 0.4);
    track(aisleGeo);
    const aisleRoof = new Mesh(aisleGeo, stoneMat);
    aisleRoof.receiveShadow = true;
    aisleRoof.castShadow = true;
    group.add(aisleRoof);
  }

  // ---- Grand staircase to the apse (solid, merged) -----------------------
  // Each step is a full block from the floor up, so there's no hollow space
  // beneath the stairs. Merged into one mesh + uniform UVs.
  {
    const { bottomZ, topZ, platformH, steps } = LAYOUT.stairs;
    const stepDepth = (bottomZ - topZ) / steps;
    const stepH = platformH / steps;
    const width = LAYOUT.naveHalfWidth * 2 + 1;
    const parts: BufferGeometry[] = [];
    for (let i = 0; i < steps; i++) {
      const h = stepH * (i + 1);
      const z = bottomZ - stepDepth * (i + 0.5);
      parts.push(boxAt(width, h, stepDepth, 0, h / 2, z));
    }
    // Raised platform behind the stairs.
    parts.push(boxAt(width, platformH, topZ - LAYOUT.apseZ, 0, platformH / 2, (topZ + LAYOUT.apseZ) / 2));

    const stairsGeo = track(applyTriplanarUV(mergeGeometries(parts.map((g) => g.toNonIndexed()), false), 0.5));
    for (const g of parts) g.dispose();
    const stairs = new Mesh(stairsGeo, stoneMat);
    stairs.castShadow = true;
    stairs.receiveShadow = true;
    group.add(stairs);
  }

  // ---- Scattered rocks (real boulders, 3 shapes, instanced) --------------
  {
    let seed = 1337;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967295;
    };
    const rockGeos = [
      track(buildRockGeometry(3, 2)),
      track(buildRockGeometry(11, 2)),
      track(buildRockGeometry(29, 2)),
    ];
    const perShape = 9;
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    for (const rockGeo of rockGeos) {
      const rocks = new InstancedMesh(rockGeo, stoneMat, perShape);
      rocks.castShadow = true;
      rocks.receiveShadow = true;
      for (let i = 0; i < perShape; i++) {
        const x = (rnd() - 0.5) * (LAYOUT.aisleHalfWidth * 2 - 3);
        const z = LAYOUT.apseZ + 4 + rnd() * (LAYOUT.entranceZ - LAYOUT.apseZ - 8);
        const base = 0.35 + rnd() * 0.75;
        q.setFromAxisAngle(up, rnd() * Math.PI * 2);
        const y = floorHeightAt(x, z);
        m.compose(
          new Vector3(x, y + base * 0.35, z),
          q,
          new Vector3(base * (0.8 + rnd() * 0.6), base * (0.6 + rnd() * 0.5), base * (0.8 + rnd() * 0.6)),
        );
        rocks.setMatrixAt(i, m);
      }
      rocks.instanceMatrix.needsUpdate = true;
      group.add(rocks);
    }
  }

  // ---- Collision & floor -------------------------------------------------
  const collide = (pos: Vector3): void => {
    const limX = LAYOUT.aisleHalfWidth - LAYOUT.wallThickness / 2 - LAYOUT.playerRadius;
    const limZHi = LAYOUT.entranceZ - LAYOUT.wallThickness - LAYOUT.playerRadius;
    const limZLo = LAYOUT.apseZ + LAYOUT.wallThickness + LAYOUT.playerRadius;
    pos.x = Math.max(-limX, Math.min(limX, pos.x));
    pos.z = Math.max(limZLo, Math.min(limZHi, pos.z));

    const minDist = LAYOUT.columnRadius + LAYOUT.playerRadius;
    for (const c of colPositions) {
      const dx = pos.x - c.x;
      const dz = pos.z - c.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < minDist * minDist && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (minDist - d) / d;
        pos.x += dx * push;
        pos.z += dz * push;
      }
    }
  };

  /** Inside the outer walls, a column, or below the floor. */
  const blocksCamera = (x: number, y: number, z: number): boolean => {
    if (y < floorHeightAt(x, z) + 0.3) return true;
    if (Math.abs(x) > LAYOUT.aisleHalfWidth - 0.4) return true;
    if (z > LAYOUT.entranceZ - 0.6 || z < LAYOUT.apseZ + 0.6) return true;
    for (const c of colPositions) {
      const dx = x - c.x;
      const dz = z - c.z;
      const r = LAYOUT.columnRadius + 0.25;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  };

  const dispose = (): void => {
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    disposables.length = 0;
  };

  return { group, sunMesh, collide, floorHeightAt, blocksCamera, dispose };
}
