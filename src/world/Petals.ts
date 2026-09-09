import {
  BufferAttribute,
  BufferGeometry,
  Color,
  NormalBlending,
  Points,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import type { BiomeId } from './WorldGen.ts';
import type { Wind } from './Wind.ts';

/**
 * Petals
 * ------
 * Blossom falling through the sakura groves.
 *
 * Same shape as the dust field: one `Points`, all motion in the vertex shader,
 * wrapped into a box that follows the player. Nothing here touches the CPU per
 * frame beyond a single uniform copy and an eased fade.
 *
 * The fade matters. Petals belong to one biome, and biome lookups are snapped to
 * an 8 m lattice, so switching them on and off directly would pop a few hundred
 * sprites into existence as you cross a boundary. Easing turns that into drifting
 * in and out of the grove.
 *
 * It shares the wind uniforms by reference, so a gust that bends the trees carries
 * the petals with it rather than the two drifting out of agreement.
 */

export interface PetalField {
  points: Points;
  update(centre: Vector3, elapsed: number, biome: BiomeId): void;
  dispose(): void;
}

const VERT = /* glsl */ `
  attribute float aSeed;
  attribute float aScale;

  uniform float uTime;
  uniform vec2 uWind;
  uniform float uGust;
  uniform vec3 uCentre;
  uniform float uExtent;
  uniform float uHeight;
  uniform float uPixelRatio;

  varying float vFade;
  varying float vSpin;

  void main() {
    float s = aSeed * 6.283;

    vec3 p = position;

    // Fall, with a per-petal rate so they do not descend as a sheet.
    float fallRate = 0.55 + aSeed * 0.7;
    p.y -= uTime * fallRate;
    // Blossom does not drop straight; it slips from side to side on the way down.
    p.x += sin(uTime * (0.5 + aSeed * 0.5) + s) * 1.5;
    p.z += cos(uTime * (0.42 + aSeed * 0.6) + s * 1.3) * 1.5;
    // Carried by the same wind that bends the trees.
    p.xz += uWind * uTime * (1.4 + uGust * 3.2);

    // Wrap into a box centred on the player: horizontally around them, and
    // vertically so a petal that lands is replaced by one leaving the canopy.
    vec3 rel = p - vec3(uCentre.x, 0.0, uCentre.z);
    rel.x = mod(rel.x + uExtent, uExtent * 2.0) - uExtent;
    rel.z = mod(rel.z + uExtent, uExtent * 2.0) - uExtent;
    float y = mod(p.y, uHeight);

    float edge = max(abs(rel.x), abs(rel.z)) / uExtent;
    vFade = 1.0 - smoothstep(0.7, 1.0, edge);
    // Also fade the last stretch to the ground, so petals dissolve instead of
    // visibly clipping into the terrain, which has no height known here.
    vFade *= smoothstep(0.0, 2.5, y);

    vSpin = uTime * (1.1 + aSeed * 2.2) + s;

    vec4 mv = modelViewMatrix * vec4(uCentre.x + rel.x, uCentre.y + y, uCentre.z + rel.z, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aScale * uPixelRatio * (34.0 / max(0.5, -mv.z));
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAmount;

  varying float vFade;
  varying float vSpin;

  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);

    // Spin a squashed disc: enough to read as a tumbling petal rather than a dot,
    // without needing a texture or four vertices each.
    float c = cos(vSpin);
    float s = sin(vSpin);
    vec2 q = mat2(c, -s, s, c) * d;
    q.y *= 2.1;

    float r = length(q);
    if (r > 0.5) discard;

    float a = smoothstep(0.5, 0.18, r) * vFade * uAmount;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

export function createPetals(count: number, extent = 60, wind?: Wind): PetalField {
  /** Height of the band petals live in, roughly canopy height. */
  const HEIGHT = 16;

  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const scales = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() * 2 - 1) * extent;
    positions[i * 3 + 1] = Math.random() * HEIGHT;
    positions[i * 3 + 2] = (Math.random() * 2 - 1) * extent;
    seeds[i] = Math.random();
    scales[i] = 0.7 + Math.random() * 0.9;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  geometry.setAttribute('aScale', new BufferAttribute(scales, 1));

  const uniforms = {
    uTime: wind ? wind.uTime : { value: 0 },
    uWind: wind ? wind.uWind : { value: new Vector2(1, 0.35) },
    uGust: wind ? wind.uGust : { value: 0 },
    uCentre: { value: new Vector3() },
    uExtent: { value: extent },
    uHeight: { value: HEIGHT },
    uPixelRatio: { value: Math.min(2, globalThis.devicePixelRatio || 1) },
    uColor: { value: new Color(1.0, 0.76, 0.85) },
    uAmount: { value: 0 },
  };

  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    // Must stay false. A raw ShaderMaterial that claims to support fog has to
    // declare the fog uniforms and include three's fog chunks itself; asking for
    // it without them makes the renderer throw while refreshing those uniforms,
    // every frame, for every draw. Distance is handled by the edge fade instead.
    fog: false,
  });

  const points = new Points(geometry, material);
  points.name = 'Petals';
  points.frustumCulled = false;
  points.visible = false;

  let amount = 0;
  let last = 0;

  const update = (centre: Vector3, elapsed: number, biome: BiomeId): void => {
    const dt = Math.min(0.5, Math.max(0, elapsed - last));
    last = elapsed;

    const target = biome === 'sakura' ? 1 : 0;
    amount += (target - amount) * Math.min(1, dt * 0.6);
    points.visible = amount > 0.01;
    if (!points.visible) return;

    uniforms.uAmount.value = amount;
    uniforms.uCentre.value.set(centre.x, centre.y - 2, centre.z);
    if (!wind) uniforms.uTime.value = elapsed;
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
