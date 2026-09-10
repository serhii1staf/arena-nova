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
import type { Wind } from './Wind.ts';

/**
 * Rain
 * ----
 * Falling streaks, in the same shape as the dust, petal and firefly fields: one
 * `Points`, every bit of motion in the vertex shader, wrapped into a box that
 * follows the player. One draw call, one uniform copy per frame, and nothing at
 * all when it is not raining.
 *
 * It shares the wind uniforms *by reference*, so the gust that bends a tree and
 * carries the blossom also slants the rain. That matters more here than
 * anywhere else: rain is the one particle field whose direction the eye reads
 * directly, and a downpour falling straight down through a bent forest looks
 * broken.
 *
 * A drop is drawn as a streak rather than a dot, and the streak leans along the
 * drop's own screen-space velocity. That direction is derived in the shader by
 * projecting the drop twice, once where it is and once a fraction of a second
 * ahead, so the lean stays correct when the camera pitches, rolls or turns into
 * the weather — none of which a fixed "downward" bias in the sprite could
 * survive.
 */

export interface RainField {
  points: Points;
  /**
   * `amount` is 0..1. Below a threshold the field is switched off entirely: no
   * uniform writes, no draw call, exactly like the fireflies in daylight.
   *
   * `tint` is the colour of the air, so rain sits in the same light as the fog
   * instead of carrying a palette of its own.
   */
  update(centre: Vector3, elapsed: number, amount: number, tint: Color): void;
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
  uniform float uAmount;

  varying float vFade;
  varying vec2 vDir;
  varying float vSize;

  void main() {
    // Terminal velocity, varied per drop. A single fall rate makes the field
    // descend as one rigid sheet, which reads as a scrolling texture.
    float fall = 15.0 + aSeed * 9.0;

    vec3 p = position;
    p.y -= uTime * fall;
    // Carried sideways by the prevailing wind. The gust is deliberately *not*
    // in this term: gust strength rises within half a second, and anything
    // multiplied by uTime would jump the whole field metres sideways when it
    // did. The gust leans the streaks instead, which is what a squall looks
    // like anyway.
    p.xz += uWind * uTime * 0.9;

    // Wrap into a box centred on the player, horizontally and vertically, so a
    // few thousand drops cover the visible weather forever.
    vec2 rel = p.xz - uCentre.xz;
    rel = mod(rel + uExtent, uExtent * 2.0) - uExtent;
    float y = mod(p.y, uHeight);
    vec3 world = vec3(uCentre.x + rel.x, uCentre.y + y, uCentre.z + rel.y);

    float edge = max(abs(rel.x), abs(rel.y)) / uExtent;
    vFade = (1.0 - smoothstep(0.72, 1.0, edge)) * uAmount;
    // Soften the last stretch of the band, so a drop leaving the bottom fades
    // rather than blinking out in mid-air.
    vFade *= smoothstep(0.0, 1.6, y);

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    float dist = max(0.5, -mv.z);
    vec4 clip = projectionMatrix * mv;
    gl_Position = clip;
    // Streak length falls off with distance, which is what makes a wall of rain
    // read as depth rather than as a flat curtain of identical marks.
    vSize = clamp(aScale * uPixelRatio * 190.0 / dist, 2.0, 44.0);
    gl_PointSize = vSize;

    // Screen-space direction of travel. Project a point a tenth of a second
    // ahead of the drop and take the difference in NDC.
    vec2 lean = uWind * (2.2 + uGust * 5.5);
    vec4 ahead = projectionMatrix * (modelViewMatrix * vec4(world + vec3(lean.x, -fall, lean.y) * 0.1, 1.0));
    vec2 d = ahead.xy / max(1e-4, ahead.w) - clip.xy / max(1e-4, clip.w);
    // NDC is square per axis but pixels are not, and gl_PointCoord runs y-down
    // while NDC runs y-up. The aspect ratio is already in the projection matrix,
    // so no resize plumbing is needed to recover it.
    float aspect = projectionMatrix[1][1] / max(1e-5, projectionMatrix[0][0]);
    vDir = normalize(vec2(d.x * aspect, -d.y) + vec2(1e-5, -1e-5));
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;

  varying float vFade;
  varying vec2 vDir;
  varying float vSize;

  void main() {
    vec2 q = gl_PointCoord - vec2(0.5);
    float along = dot(q, vDir);
    float across = dot(q, vec2(-vDir.y, vDir.x));

    // Constant width in pixels whatever the sprite size, so a near drop is a
    // long thin streak instead of a fat lozenge.
    float w = 1.3 / vSize;
    float body = 1.0 - smoothstep(w * 0.3, w, abs(across));
    if (body <= 0.0) discard;
    float len = 1.0 - smoothstep(0.26, 0.5, abs(along));
    // Brightest at the leading end and trailing off behind it: a streak is one
    // drop smeared over a frame, not a uniform line.
    float head = 0.5 + 0.5 * smoothstep(-0.5, 0.35, along);

    float a = body * len * head * vFade * 0.6;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

/**
 * Rain-lit grey. What the streaks are lifted toward as the air darkens.
 *
 * Necessary for the same reason the ground mist needed it: the fog colour is
 * nearly black after dark, so drops tinted with it outright would vanish into
 * exactly the darkness they are meant to be visible against. Rain scatters
 * whatever light there is, so it is always brighter than the air behind it.
 */
const PALE = new Color(0.76, 0.82, 0.88);

export function createRain(count: number, extent = 34, wind?: Wind): RainField {
  /** Height of the band drops live in, above the bottom of the box. */
  const HEIGHT = 34;

  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const scales = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() * 2 - 1) * extent;
    positions[i * 3 + 1] = Math.random() * HEIGHT;
    positions[i * 3 + 2] = (Math.random() * 2 - 1) * extent;
    seeds[i] = Math.random();
    scales[i] = 0.7 + Math.random() * 0.8;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  geometry.setAttribute('aScale', new BufferAttribute(scales, 1));

  const uniforms = {
    // Shared by reference with the wind, so a gust moves the rain, the trees and
    // the petals together instead of the three drifting out of agreement.
    uTime: wind ? wind.uTime : { value: 0 },
    uWind: wind ? wind.uWind : { value: new Vector2(1, 0.35) },
    uGust: wind ? wind.uGust : { value: 0 },
    uCentre: { value: new Vector3() },
    uExtent: { value: extent },
    uHeight: { value: HEIGHT },
    uPixelRatio: { value: Math.min(2, globalThis.devicePixelRatio || 1) },
    uAmount: { value: 0 },
    uColor: { value: PALE.clone() },
  };

  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    // Normal, not additive. Rain in front of a bright sky is slightly darker
    // than it and in front of a dark wood is brighter; additive can only ever
    // brighten, which turns a night-time downpour into a glowing haze.
    blending: NormalBlending,
    // Must stay false. A raw ShaderMaterial that claims to support fog has to
    // declare three's fog uniforms and include its fog chunks itself; asking for
    // fog without them makes the renderer throw while refreshing those uniforms,
    // every frame, for every draw. Distance is handled by the edge fade and by
    // the streaks shrinking with range.
    fog: false,
  });

  const points = new Points(geometry, material);
  points.name = 'Rain';
  points.frustumCulled = false;
  points.renderOrder = 3;
  points.visible = false;

  const update = (centre: Vector3, elapsed: number, amount: number, tint: Color): void => {
    // Dry weather costs nothing: no uniform writes and no draw call.
    points.visible = amount > 0.02;
    if (!points.visible) return;

    uniforms.uAmount.value = Math.min(1, amount);
    // The band hangs from just below the player's feet to well overhead, so
    // drops exist between the camera and the ground however the view is aimed.
    uniforms.uCentre.value.set(centre.x, centre.y - 4, centre.z);
    if (!wind) uniforms.uTime.value = elapsed;

    // Follow the colour of the air, but never all the way down: see PALE.
    const luminance = tint.r * 0.3 + tint.g * 0.6 + tint.b * 0.1;
    const lift = 0.32 + (1 - Math.min(1, luminance)) * 0.46;
    uniforms.uColor.value.copy(tint).lerp(PALE, lift);
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
