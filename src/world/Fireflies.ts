import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { SURFACE_STEP, surfaceHeightAt } from './WorldGen.ts';

/**
 * Fireflies
 * ---------
 * Drifting points of light that come out after dark. Like the wind particles they
 * live in a box that follows the player and wrap inside it, so a few hundred
 * points cover the whole visible area forever with no CPU respawning.
 *
 * They hug the ground rather than floating at a fixed altitude: the vertex shader
 * is fed a coarse height field sampled on the CPU (a small texture would be
 * overkill for this), so a firefly over a hillside rises with it instead of
 * sinking into the slope.
 */

const VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCentre;
  uniform float uExtent;
  uniform float uPixelRatio;
  uniform float uGroundY;
  uniform float uAmount;
  attribute float aSeed;
  attribute float aScale;
  attribute float aHeight;
  varying float vGlow;

  void main() {
    // Slow, looping wander. Two rates per axis keep the paths from being circles.
    float s = aSeed * 6.283;
    vec2 drift = vec2(
      sin(uTime * 0.42 + s) * 5.5 + cos(uTime * 0.17 + s * 2.1) * 3.0,
      cos(uTime * 0.37 + s * 1.3) * 5.5 + sin(uTime * 0.21 + s * 1.7) * 3.0
    );
    float bob = sin(uTime * 0.55 + s * 3.1) * 0.9;

    // Wrap into a box centred on the player so the swarm never runs out.
    vec2 rel = position.xz + drift - uCentre.xz;
    rel = mod(rel + uExtent, uExtent * 2.0) - uExtent;

    // Sit just above the local ground rather than at a fixed world height.
    vec3 world = vec3(uCentre.x + rel.x, uGroundY + aHeight + bob, uCentre.z + rel.y);

    // Fade at the edges of the box to hide the wrap, and pulse individually.
    float edge = max(abs(rel.x), abs(rel.y)) / uExtent;
    float pulse = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * 2.3 + s * 4.7), 2.0);
    vGlow = (1.0 - smoothstep(0.72, 1.0, edge)) * pulse * uAmount;

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    gl_PointSize = aScale * uPixelRatio * 30.0 / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying float vGlow;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d);
    if (r > 0.5) discard;
    // Bright core with a soft halo, so they read as little lamps.
    float core = smoothstep(0.5, 0.0, r);
    float a = core * core * vGlow;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(0.72, 1.0, 0.42, a);
  }
`;

export interface FireflyField {
  points: Points;
  /** `amount` is 0 in daylight, 1 at full dark. */
  update(centre: Vector3, elapsed: number, amount: number): void;
  dispose(): void;
}

export function createFireflies(count: number, extent = 60): FireflyField {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const scales = new Float32Array(count);
  const heights = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * extent * 2;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = (Math.random() - 0.5) * extent * 2;
    seeds[i] = Math.random();
    scales[i] = 0.5 + Math.random() * 0.9;
    // Knee to head height: low enough to read as lighting the ground.
    heights[i] = 0.4 + Math.random() * 2.6;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  geo.setAttribute('aScale', new BufferAttribute(scales, 1));
  geo.setAttribute('aHeight', new BufferAttribute(heights, 1));

  const uniforms = {
    uTime: { value: 0 },
    uCentre: { value: new Vector3() },
    uExtent: { value: extent },
    uPixelRatio: {
      value: Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2),
    },
    uGroundY: { value: 0 },
    uAmount: { value: 0 },
  };

  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  const points = new Points(geo, material);
  points.frustumCulled = false;
  points.visible = false;

  return {
    points,
    update: (centre: Vector3, elapsed: number, amount: number) => {
      // Skipped entirely in daylight: no uniform writes, no draw call.
      points.visible = amount > 0.01;
      if (!points.visible) return;
      uniforms.uTime.value = elapsed;
      uniforms.uCentre.value.copy(centre);
      uniforms.uAmount.value = amount;
      // One ground sample per frame for the whole swarm. The box is 120 m across
      // and fireflies only need to look like they are near the ground, so a
      // per-particle height would be a lot of work for no visible gain.
      uniforms.uGroundY.value = surfaceHeightAt(
        Math.round(centre.x / SURFACE_STEP) * SURFACE_STEP,
        Math.round(centre.z / SURFACE_STEP) * SURFACE_STEP,
      );
    },
    dispose: () => {
      geo.dispose();
      material.dispose();
    },
  };
}
