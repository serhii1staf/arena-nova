import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { Wind } from './Wind.ts';

/**
 * WindParticles
 * -------------
 * Streaks of dust, pollen and leaves carried on the wind. They live in a box that
 * follows the player and wrap around inside it, so a modest particle count covers
 * the whole visible area forever without ever being respawned on the CPU.
 *
 * Motion is entirely in the vertex shader, driven by the same wind uniforms as the
 * foliage, so gusts visibly move the air and the plants together.
 */

const VERT = /* glsl */ `
  uniform float uTime;
  uniform vec2 uWind;
  uniform float uGust;
  uniform vec3 uCentre;
  uniform float uExtent;
  uniform float uPixelRatio;
  attribute float aSeed;
  attribute float aScale;
  varying float vFade;

  void main() {
    // Drift: base position advected by the wind, wrapped into a moving box.
    float speed = 6.0 + uGust * 14.0;
    vec3 p = position;
    p.xz += uWind * uTime * speed;
    // Gentle bobbing so streaks don't travel in perfectly straight lines.
    p.y += sin(uTime * 1.4 + aSeed * 30.0) * 1.6;
    p.x += cos(uTime * 0.9 + aSeed * 21.0) * 1.2;

    // Wrap relative to the player so the field is effectively infinite.
    vec3 rel = p - uCentre;
    rel = mod(rel + uExtent, uExtent * 2.0) - uExtent;

    // Fade near the box edges to hide the wrap.
    float edge = max(abs(rel.x), abs(rel.z)) / uExtent;
    vFade = 1.0 - smoothstep(0.75, 1.0, edge);

    vec4 mv = modelViewMatrix * vec4(uCentre + rel, 1.0);
    gl_PointSize = aScale * uPixelRatio * 26.0 / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d);
    if (r > 0.5) discard;
    gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, r) * uOpacity * vFade);
  }
`;

export interface WindParticleField {
  points: Points;
  update(centre: Vector3): void;
  dispose(): void;
}

export function createWindParticles(wind: Wind, count: number, extent = 90): WindParticleField {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const scales = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * extent * 2;
    positions[i * 3 + 1] = Math.random() * 26 + 1;
    positions[i * 3 + 2] = (Math.random() - 0.5) * extent * 2;
    seeds[i] = Math.random();
    scales[i] = 0.35 + Math.random() * 1.1;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  geo.setAttribute('aScale', new BufferAttribute(scales, 1));

  const uniforms = {
    uTime: wind.uTime,
    uWind: wind.uWind,
    uGust: wind.uGust,
    uCentre: { value: new Vector3() },
    uExtent: { value: extent },
    uPixelRatio: {
      value: Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2),
    },
    uColor: { value: new Color(0.95, 0.94, 0.78) },
    uOpacity: { value: 0.34 },
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

  return {
    points,
    update: (centre: Vector3) => {
      uniforms.uCentre.value.copy(centre);
    },
    dispose: () => {
      geo.dispose();
      material.dispose();
    },
  };
}
