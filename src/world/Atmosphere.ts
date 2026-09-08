import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  SphereGeometry,
} from 'three';
import { Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssetManager } from '../core/AssetManager.ts';
import type { QualitySettings } from '../core/QualityManager.ts';
import { LAYOUT } from './Cathedral.ts';

interface Disposable {
  dispose(): void;
}

export interface AtmosphereBuild {
  group: Group;
  update(elapsed: number, camera: Camera): void;
  dispose(): void;
}

const DUST_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  uniform float uPixelRatio;
  attribute float aScale;
  attribute vec3 aSeed;
  void main() {
    vec3 p = position;
    p.x += sin(uTime * 0.25 + aSeed.x * 6.2831) * 0.7;
    p.y += sin(uTime * 0.18 + aSeed.y * 6.2831) * 0.5;
    p.z += cos(uTime * 0.22 + aSeed.z * 6.2831) * 0.7;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * aScale * uPixelRatio / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const DUST_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(uColor, a * uOpacity);
  }
`;

/** Soft beam gradient: bright at top, fading down and at the edges. */
function makeBeamTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const vgrad = ctx.createLinearGradient(0, 0, 0, size);
  vgrad.addColorStop(0, 'rgba(255,255,255,0.9)');
  vgrad.addColorStop(0.5, 'rgba(230,255,220,0.35)');
  vgrad.addColorStop(1, 'rgba(200,255,200,0)');
  ctx.fillStyle = vgrad;
  ctx.fillRect(0, 0, size, size);
  // Fade the horizontal edges.
  const hgrad = ctx.createLinearGradient(0, 0, size, 0);
  hgrad.addColorStop(0, 'rgba(0,0,0,1)');
  hgrad.addColorStop(0.5, 'rgba(0,0,0,0)');
  hgrad.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = hgrad;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export function buildAtmosphere(settings: QualitySettings, assets: AssetManager): AtmosphereBuild {
  const group = new Group();
  group.name = 'Atmosphere';
  const disposables: Disposable[] = [];
  const track = <T extends Disposable>(d: T): T => {
    disposables.push(d);
    return d;
  };

  const pixelRatio = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2);

  // ---- Floating dust / pollen motes --------------------------------------
  const count = settings.particleCount;
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const seeds = new Float32Array(count * 3);
  const xR = LAYOUT.aisleHalfWidth - 0.5;
  const zMin = LAYOUT.apseZ + 2;
  const zR = LAYOUT.entranceZ - LAYOUT.apseZ - 4;
  const yMax = LAYOUT.vaultRidge * 0.85;
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 2 * xR;
    positions[i * 3 + 1] = 0.5 + Math.random() * yMax;
    positions[i * 3 + 2] = zMin + Math.random() * zR;
    scales[i] = 0.4 + Math.random() * 1.6;
    seeds[i * 3] = Math.random();
    seeds[i * 3 + 1] = Math.random();
    seeds[i * 3 + 2] = Math.random();
  }
  const dustGeo = track(new BufferGeometry());
  dustGeo.setAttribute('position', new BufferAttribute(positions, 3));
  dustGeo.setAttribute('aScale', new BufferAttribute(scales, 1));
  dustGeo.setAttribute('aSeed', new BufferAttribute(seeds, 3));

  const dustUniforms = {
    uTime: { value: 0 },
    uSize: { value: 26 },
    uPixelRatio: { value: pixelRatio },
    uColor: { value: new Color(0.85, 1.0, 0.7) },
    uOpacity: { value: 0.5 },
  };
  const dustMat = track(
    new ShaderMaterial({
      uniforms: dustUniforms,
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  const dust = new Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  group.add(dust);

  // ---- Exterior backdrop (real sky + distant jungle) ---------------------
  // The same sky texture the open world uses, so looking through a broken window
  // shows genuine sky and clouds rather than a flat painted panel.
  const skyGeo = track(new SphereGeometry(340, 48, 32));
  const skyMat = track(
    new MeshBasicMaterial({ map: assets.sky(), side: BackSide, fog: false, depthWrite: false }),
  );
  const sky = new Mesh(skyGeo, skyMat);
  sky.renderOrder = -2;
  group.add(sky);

  // A ring of distant hills and tree silhouettes just outside the ruin, so the
  // windows frame actual scenery with depth instead of empty sky.
  {
    const hillMat = track(
      new MeshBasicMaterial({ color: new Color(0.3, 0.42, 0.3), fog: false, side: DoubleSide }),
    );
    const treeMat = track(
      new MeshBasicMaterial({ color: new Color(0.17, 0.3, 0.18), fog: false, side: DoubleSide }),
    );
    let s = 4242;
    const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967295);

    // The backdrop is completely static, so bake every piece into two merged
    // meshes: two draw calls instead of ~110.
    const hillParts: BufferGeometry[] = [];
    const treeParts: BufferGeometry[] = [];
    const dummy = new Object3D();

    // Rolling hill band.
    for (let i = 0; i < 26; i++) {
      const ang = (i / 26) * Math.PI * 2;
      const dist = 150 + rnd() * 40;
      const w = 70 + rnd() * 50;
      const hgt = 16 + rnd() * 22;
      const g = new PlaneGeometry(1, 1);
      dummy.position.set(Math.sin(ang) * dist, hgt * 0.3, Math.cos(ang) * dist);
      dummy.scale.set(w, hgt, 1);
      dummy.lookAt(0, hgt * 0.3, 0);
      dummy.updateMatrix();
      g.applyMatrix4(dummy.matrix);
      hillParts.push(g);
    }

    // Tree silhouettes closer in, at window height.
    for (let i = 0; i < 44; i++) {
      const ang = rnd() * Math.PI * 2;
      const dist = 42 + rnd() * 70;
      const x = Math.sin(ang) * dist;
      const z = Math.cos(ang) * dist;
      const scale = 3 + rnd() * 4;

      const canopy = new SphereGeometry(1, 7, 5);
      dummy.position.set(x, 3 + scale * 1.1, z);
      dummy.scale.set(scale, scale * 0.8, scale);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      canopy.applyMatrix4(dummy.matrix);
      treeParts.push(canopy.toNonIndexed());
      canopy.dispose();

      const trunk = new PlaneGeometry(0.5, 6);
      dummy.position.set(x, 3, z);
      dummy.scale.set(1, 1, 1);
      dummy.lookAt(0, 3, 0);
      dummy.updateMatrix();
      trunk.applyMatrix4(dummy.matrix);
      treeParts.push(trunk.toNonIndexed());
      trunk.dispose();
    }

    const hillsGeo = track(mergeGeometries(hillParts.map((g) => g.toNonIndexed()), false));
    for (const g of hillParts) g.dispose();
    group.add(new Mesh(hillsGeo, hillMat));

    const treesGeo = track(mergeGeometries(treeParts, false));
    for (const g of treeParts) g.dispose();
    group.add(new Mesh(treesGeo, treeMat));
  }

  // ---- Volumetric light shafts (billboarded → never a flat "strip") -------
  const beamTex = track(makeBeamTexture());
  const beamMat = track(
    new MeshBasicMaterial({
      map: beamTex,
      color: new Color(0.82, 1.0, 0.72),
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      fog: false,
    }),
  );

  const beams: Mesh[] = [];
  const addBeam = (x: number, y: number, z: number, w: number, h: number): void => {
    const geo = track(new PlaneGeometry(w, h));
    const beam = new Mesh(geo, beamMat);
    beam.position.set(x, y, z);
    beams.push(beam);
    group.add(beam);
  };

  // Broad shaft at the apse, plus a shaft in each side-window opening.
  // Skip openings over the raised platform (they read as "floating" bars).
  addBeam(0, 7.5, LAYOUT.apseZ + 5, 8, 13);
  const zs = LAYOUT.columnZs;
  const inset = LAYOUT.aisleHalfWidth - 1.2;
  for (let i = 0; i < zs.length - 1; i++) {
    const zMid = (zs[i]! + zs[i + 1]!) / 2;
    if (zMid <= LAYOUT.stairs.topZ) continue;
    addBeam(inset, 6, zMid, 3.2, 12);
    addBeam(-inset, 6, zMid, 3.2, 12);
  }

  const update = (elapsed: number, camera: Camera): void => {
    dustUniforms.uTime.value = elapsed;
    beamMat.opacity = 0.17 + Math.sin(elapsed * 0.5) * 0.05;
    // Billboard each shaft around Y so it always faces the camera.
    const cx = camera.position.x;
    const cz = camera.position.z;
    for (const beam of beams) {
      beam.rotation.y = Math.atan2(cx - beam.position.x, cz - beam.position.z);
    }
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
