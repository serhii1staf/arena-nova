import {
  BufferAttribute,
  BufferGeometry,
  Color,
  NormalBlending,
  Points,
  ShaderMaterial,
  type Vector3,
} from 'three';
import { surfaceGroundHeightAt } from './WorldGen.ts';

/**
 * GroundMist
 * ----------
 * Low banks of haze lying on the ground: what actually reads as volumetric fog
 * when you walk through a wood at dusk. `FogExp2` can only thicken the whole
 * view uniformly, so on its own it flattens distance rather than adding depth —
 * it cannot pool in a hollow or part around a trunk.
 *
 * Patches are large, soft, near-transparent sprites. Not a raymarch and not a
 * shell of shells: at this size a handful of overlapping billboards is
 * indistinguishable from either, for one draw call and no render targets.
 *
 * Unlike the dust and firefly fields, wrapping is done on the CPU. Those wrap in
 * the vertex shader, which is free but cannot know where the ground is — fine for
 * motes at head height, useless for something that has to lie *on* the surface.
 * Here a patch samples the terrain when it re-enters the ring, so the bank follows
 * the hillside. The cost is one distance test per patch per frame and a terrain
 * sample only for the few that actually wrapped.
 */

export interface GroundMistField {
  points: Points;
  /**
   * `thickness` is 0..1. Below a threshold the whole field is switched off, so
   * clear weather in an open biome costs nothing at all.
   */
  update(centre: Vector3, elapsed: number, thickness: number, tint: Color): void;
  dispose(): void;
}

const VERT = /* glsl */ `
  attribute float aSeed;
  attribute float aScale;

  uniform float uTime;
  uniform float uPixelRatio;

  varying float vAlpha;
  varying float vSeed;

  void main() {
    vSeed = aSeed;

    vec3 p = position;
    // A slow, wide sway. Mist should look like it is being pushed around, not
    // like a field of stationary blobs.
    float s = aSeed * 6.283;
    p.x += sin(uTime * 0.09 + s) * 2.6;
    p.z += cos(uTime * 0.07 + s * 1.7) * 2.6;
    p.y += sin(uTime * 0.16 + s * 2.3) * 0.35;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = -mv.z;

    // Fade in with distance instead of popping: up close a single patch would
    // fill the screen and read as a grey wash over the camera.
    vAlpha = smoothstep(1.5, 9.0, dist) * (1.0 - smoothstep(95.0, 155.0, dist));

    gl_Position = projectionMatrix * mv;
    gl_PointSize = aScale * uPixelRatio * (2300.0 / max(1.0, dist));
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  varying float vAlpha;
  varying float vSeed;

  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    // Squashed, because mist spreads sideways and not upward. A circular sprite
    // reads as a ball of smoke however soft its edge is.
    d.y *= 1.9;
    float r = length(d);
    if (r > 0.5) discard;

    // Extremely soft, with no rim at all. Each patch on its own is barely there;
    // a bank is what several dozen of them overlapping add up to. Making any one
    // of them solid enough to see clearly is what turns them into visible blobs.
    float a = pow(smoothstep(0.5, 0.0, r), 2.6);
    // Break up the uniformity so overlapping patches do not band.
    a *= 0.72 + 0.28 * sin(vSeed * 24.0);

    float alpha = a * vAlpha * uOpacity;
    if (alpha <= 0.003) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

/** Moonlit white. What mist is lifted toward as the air around it darkens. */
const PALE = new Color(0.8, 0.85, 0.9);

export function createGroundMist(count: number, extent = 70): GroundMistField {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const scales = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Spread over a disc rather than a square, so the ring the patches wrap
    // through is the same distance in every direction.
    const ang = Math.random() * Math.PI * 2;
    const r = extent * Math.sqrt(Math.random());
    positions[i * 3] = Math.cos(ang) * r;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = Math.sin(ang) * r;
    seeds[i] = Math.random();
    scales[i] = 0.55 + Math.random() * 0.95;
  }

  const geometry = new BufferGeometry();
  const posAttr = new BufferAttribute(positions, 3);
  posAttr.setUsage(35048 /* DynamicDrawUsage */);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  geometry.setAttribute('aScale', new BufferAttribute(scales, 1));

  const uniforms = {
    uTime: { value: 0 },
    uPixelRatio: { value: Math.min(2, globalThis.devicePixelRatio || 1) },
    uColor: { value: new Color(0.62, 0.68, 0.7) },
    uOpacity: { value: 0 },
  };

  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    // Normal blending, not additive: mist *obscures* what is behind it. Additive
    // would make a dark wood glow, which is the opposite of the intent.
    blending: NormalBlending,
    fog: false,
  });

  const points = new Points(geometry, material);
  points.name = 'GroundMist';
  points.frustumCulled = false;
  points.renderOrder = 2;
  points.visible = false;

  /**
   * Height band the patches sit in, above the sampled ground.
   *
   * Varied per patch on purpose. A single ride height puts every sprite on the
   * same plane, and the result reads as a horizontal seam across the view rather
   * than as air with any depth to it. Biased low, so most of the mist lies on the
   * ground and only some of it drifts up to knee or waist height.
   */
  const rides = new Float32Array(count);
  for (let i = 0; i < count; i++) rides[i] = 0.15 + Math.pow(Math.random(), 1.6) * 2.1;
  const limitSq = extent * extent;
  let seeded = false;

  /** Puts one patch on the ground at its current x/z. */
  const settle = (i: number): void => {
    const x = positions[i * 3]!;
    const z = positions[i * 3 + 2]!;
    positions[i * 3 + 1] = surfaceGroundHeightAt(x, z) + rides[i]!;
  };

  const update = (centre: Vector3, elapsed: number, thickness: number, tint: Color): void => {
    const amount = Math.min(1, Math.max(0, thickness));
    points.visible = amount > 0.02;
    if (!points.visible) return;

    uniforms.uTime.value = elapsed;
    uniforms.uOpacity.value = amount * 0.3;

    // Mist follows the colour of the air, but never all the way.
    //
    // Copying the fog colour outright looks correct at midday and makes the layer
    // vanish at night, when that colour is nearly black — mist was being drawn in
    // the same dark blue as the darkness it was supposed to stand out against.
    // Real mist scatters light and so is always brighter than what is behind it,
    // and the darker the air the bigger that difference: lift toward a pale,
    // slightly cool white, by more when the air is dark.
    const luminance = tint.r * 0.3 + tint.g * 0.6 + tint.b * 0.1;
    const lift = 0.22 + (1 - Math.min(1, luminance)) * 0.34;
    uniforms.uColor.value.copy(tint).lerp(PALE, lift);

    let moved = false;
    if (!seeded) {
      // First frame: the patches were laid out around the origin, so put them
      // around the player and on the ground.
      for (let i = 0; i < count; i++) {
        positions[i * 3] += centre.x;
        positions[i * 3 + 2] += centre.z;
        settle(i);
      }
      seeded = true;
      moved = true;
    }

    for (let i = 0; i < count; i++) {
      const dx = positions[i * 3]! - centre.x;
      const dz = positions[i * 3 + 2]! - centre.z;
      const dSq = dx * dx + dz * dz;
      if (dSq <= limitSq) continue;
      // Reflect through the centre: the patch that just fell behind reappears
      // ahead, which keeps the ring full without ever spawning one in view.
      const d = Math.sqrt(dSq) || 1;
      const spread = 0.55 + Math.random() * 0.45;
      positions[i * 3] = centre.x - (dx / d) * extent * spread;
      positions[i * 3 + 2] = centre.z - (dz / d) * extent * spread;
      settle(i);
      moved = true;
    }
    if (moved) posAttr.needsUpdate = true;
  };

  return {
    points,
    update,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      points.removeFromParent();
    },
  };
}
