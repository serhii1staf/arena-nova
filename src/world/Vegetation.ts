import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type IUniform,
} from 'three';
import type { AssetManager } from '../core/AssetManager.ts';
import type { QualitySettings } from '../core/QualityManager.ts';
import { LAYOUT } from './Cathedral.ts';

interface Disposable {
  dispose(): void;
}

export interface VegetationBuild {
  group: Group;
  update(elapsed: number): void;
  dispose(): void;
}

/** Deterministic PRNG so the layout is stable across reloads. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967295;
  };
}

/** A single curved, tapering grass blade with base→tip vertex colors. */
function buildBladeGeometry(): BufferGeometry {
  const w = 0.045;
  const h = 0.55;
  const bend = 0.12;
  const positions = new Float32Array([
    -w, 0, 0, w, 0, 0, -w * 0.7, h * 0.5, bend * 0.4,
    w * 0.7, h * 0.5, bend * 0.4, 0, h, bend,
  ]);
  const colorBase = new Color(0.05, 0.11, 0.03);
  const colorMid = new Color(0.16, 0.34, 0.08);
  const colorTip = new Color(0.32, 0.56, 0.14);
  const colors = new Float32Array([
    colorBase.r, colorBase.g, colorBase.b, colorBase.r, colorBase.g, colorBase.b,
    colorMid.r, colorMid.g, colorMid.b, colorMid.r, colorMid.g, colorMid.b,
    colorTip.r, colorTip.g, colorTip.b,
  ]);
  const index = [0, 1, 2, 2, 1, 3, 2, 3, 4];
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

export function buildVegetation(assets: AssetManager, settings: QualitySettings): VegetationBuild {
  const group = new Group();
  group.name = 'Vegetation';
  const disposables: Disposable[] = [];
  const track = <T extends Disposable>(d: T): T => {
    disposables.push(d);
    return d;
  };

  const timeUniform: IUniform<number> = { value: 0 };

  // Mirrors Cathedral.floorHeightAt: stairs/platform only span the central
  // nave width, aisles stay flat — so grass never floats beside the steps.
  const stairsHalfWidth = LAYOUT.naveHalfWidth + 0.5;

  // ---- Grass (instanced, wind-swayed via onBeforeCompile) ----------------
  const bladeGeo = track(buildBladeGeometry());
  const grassMat = track(
    new MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      side: DoubleSide,
    }),
  );
  grassMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.vertexShader =
      'uniform float uTime;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float wSway = sin(uTime * 1.6 + instanceMatrix[3].x * 0.6 + instanceMatrix[3].z * 0.7);
         float wPow = position.y * position.y * 0.9;
         transformed.x += wSway * wPow;
         transformed.z += cos(uTime * 1.3 + instanceMatrix[3].z * 0.5) * wPow * 0.5;`,
      );
  };

  const grassCount = Math.floor(6500 * settings.vegetationDensity);
  const grass = new InstancedMesh(bladeGeo, grassMat, grassCount);
  grass.castShadow = false;
  grass.receiveShadow = false;
  grass.frustumCulled = false; // spread across the whole floor
  {
    const rng = makeRng(90210);
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const pos = new Vector3();
    const scl = new Vector3();
    const tint = new Color();
    const xLimit = LAYOUT.aisleHalfWidth - 0.6;
    let placed = 0;
    for (let i = 0; i < grassCount; i++) {
      const x = (rng() - 0.5) * 2 * xLimit;
      const z = LAYOUT.apseZ + 2 + rng() * (LAYOUT.entranceZ - LAYOUT.apseZ - 4);
      if (nearStairEdge(x, z)) continue; // would dangle over the step edge
      // Follow the stair/platform height so grass sits on the ground.
      const y = floorAt(x, z);
      const s = 0.55 + rng() * 1.1;
      q.setFromAxisAngle(up, rng() * Math.PI * 2);
      pos.set(x, y, z);
      scl.set(s, s * (0.8 + rng() * 0.6), s);
      m.compose(pos, q, scl);
      grass.setMatrixAt(placed, m);
      const g = 0.75 + rng() * 0.5;
      tint.setRGB(g * 0.85, g, g * 0.6);
      grass.setColorAt(placed, tint);
      placed++;
    }
    grass.count = placed;
    grass.instanceMatrix.needsUpdate = true;
    if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
  }
  group.add(grass);

  // ---- Moss ground decals (instanced discs) ------------------------------
  const mossGeo = track(new CircleGeometry(0.9, 8));
  mossGeo.rotateX(-Math.PI / 2);
  const mossMat = track(
    new MeshStandardMaterial({
      map: assets.moss(2),
      color: new Color(0.7, 0.85, 0.6),
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      transparent: true,
      opacity: 0.92,
    }),
  );
  const mossCount = Math.floor(180 * settings.vegetationDensity);
  const moss = new InstancedMesh(mossGeo, mossMat, mossCount);
  moss.receiveShadow = true;
  {
    const rng = makeRng(5150);
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    let mossPlaced = 0;
    for (let i = 0; i < mossCount; i++) {
      const x = (rng() - 0.5) * 2 * (LAYOUT.aisleHalfWidth - 0.5);
      const z = LAYOUT.apseZ + 2 + rng() * (LAYOUT.entranceZ - LAYOUT.apseZ - 4);
      if (nearStairEdge(x, z)) continue; // patches would float off the step
      const y = floorAt(x, z) + 0.03;
      const s = 0.6 + rng() * 1.8;
      q.setFromAxisAngle(up, rng() * Math.PI * 2);
      m.compose(new Vector3(x, y, z), q, new Vector3(s, 1, s));
      moss.setMatrixAt(mossPlaced++, m);
    }
    moss.count = mossPlaced;
    moss.instanceMatrix.needsUpdate = true;
  }
  group.add(moss);

  // ---- Hanging vines on the columns (instanced drooping strands) ---------
  const vineGeo = track(buildBladeGeometry());
  vineGeo.scale(1.4, 3.2, 1.4);
  const vineMat = track(
    new MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      side: DoubleSide,
      color: new Color(0.5, 0.7, 0.4),
    }),
  );
  const vinesPerColumn = Math.max(2, Math.floor(6 * settings.vegetationDensity));
  const vineCount = LAYOUT.columnZs.length * 2 * vinesPerColumn;
  const vines = new InstancedMesh(vineGeo, vineMat, vineCount);
  vines.frustumCulled = false;
  {
    const rng = makeRng(70707);
    const m = new Matrix4();
    const q = new Quaternion();
    let i = 0;
    for (const z of LAYOUT.columnZs) {
      for (const sx of [LAYOUT.naveHalfWidth, -LAYOUT.naveHalfWidth]) {
        for (let v = 0; v < vinesPerColumn; v++) {
          const ang = rng() * Math.PI * 2;
          const r = LAYOUT.columnRadius + 0.1;
          const px = sx + Math.cos(ang) * r;
          const pz = z + Math.sin(ang) * r;
          const py = 3 + rng() * (LAYOUT.columnHeight - 5);
          // Point the blade downward to hang.
          q.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI * (0.85 + rng() * 0.2));
          m.compose(new Vector3(px, py, pz), q, new Vector3(1, 1, 1));
          vines.setMatrixAt(i++, m);
        }
      }
    }
    vines.instanceMatrix.needsUpdate = true;
  }
  vines.material.onBeforeCompile = grassMat.onBeforeCompile; // share wind sway
  group.add(vines);

  function floorAt(x: number, z: number): number {
    const { bottomZ, topZ, platformH } = LAYOUT.stairs;
    if (z >= bottomZ) return 0;
    if (Math.abs(x) > stairsHalfWidth) return 0;
    if (z <= topZ) return platformH;
    return ((bottomZ - z) / (bottomZ - topZ)) * platformH;
  }

  /**
   * True when a spot is too close to a stair/platform edge to plant on: blades
   * placed there hang out over the drop. Keeps plants off the brink.
   */
  function nearStairEdge(x: number, z: number): boolean {
    const { bottomZ, topZ } = LAYOUT.stairs;
    if (z > bottomZ + 0.6 || z < topZ - 0.6) return false; // not in the stair zone
    const dEdge = Math.abs(Math.abs(x) - stairsHalfWidth);
    return dEdge < 0.9;
  }

  const update = (elapsed: number): void => {
    timeUniform.value = elapsed;
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

  return { group, update, dispose };
}
