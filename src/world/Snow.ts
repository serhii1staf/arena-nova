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
 * Snow
 * ----
 * Falling flakes, in the same shape as the rain: one `Points`, all the motion in
 * the vertex shader, wrapped into a box that follows the player. One draw call,
 * and nothing at all when it is not snowing.
 *
 * Deliberately a separate field rather than a mode of `Rain`. The two share only
 * the box-wrapping trick; everything that matters is different. A raindrop falls
 * at terminal velocity in a straight line and is drawn as a streak leaning along
 * its own screen-space velocity. A flake is light enough that air resistance
 * dominates gravity: it falls an order of magnitude slower, it flutters sideways
 * on its own, and it reads as a soft round grain with no direction at all. Trying
 * to express both through one shader would mean branching on almost every line
 * and paying for a streak's second projection while drawing dots.
 *
 * The wind uniforms are shared *by reference* with everything else that moves in
 * the weather, so the gust that bends a tree also drives the snow across the
 * slope. Snow shows wind more plainly than rain does — it is slow enough to
 * follow the air rather than cut through it — so the shared gust carries more of
 * the effect here and the constant fall speed carries less.
 */

export interface SnowField {
  points: Points;
  /**
   * `amount` is 0..1. Below a threshold the field is switched off entirely: no
   * uniform writes and no draw call, exactly like the rain in dry weather.
   *
   * `tint` is the colour of the air, so flakes sit in the same light as the fog.
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
  varying float vSeed;

  void main() {
    // Flakes fall between about 0.8 and 2 m/s. Two orders of magnitude of spread
    // would be wrong — real flakes vary by mass, not by kind — but a single rate
    // makes the field descend as one rigid sheet, which reads as a scrolling
    // texture rather than as weather.
    float fall = 0.85 + aSeed * 1.25;

    vec3 p = position;
    p.y -= uTime * fall;
    // Carried by the prevailing wind, and much further than rain is: a flake has
    // seconds of airtime per metre fallen, so the horizontal term dominates. As
    // in the rain, the *gust* is kept out of anything multiplied by uTime, or a
    // squall would teleport the whole field sideways as it rose.
    p.xz += uWind * uTime * 3.4;

    // Flutter. A flake does not fall along a line: it rocks about its own axis
    // and slips sideways as it does. Two incommensurate frequencies per flake,
    // seeded so no two share a phase, which is what stops the field pulsing.
    float t = uTime + aSeed * 60.0;
    vec3 drift = vec3(
      sin(t * 0.7 + aSeed * 12.0) * 0.9 + sin(t * 1.9) * 0.35,
      0.0,
      cos(t * 0.62 + aSeed * 7.0) * 0.9 + cos(t * 2.3) * 0.3
    );
    // The gust widens the flutter instead of translating it, so a squall makes
    // the snow churn rather than slide.
    p.xz += drift.xz * (1.0 + uGust * 2.5);

    // Wrap into a box centred on the player so a few thousand flakes cover the
    // visible weather forever.
    vec2 rel = p.xz - uCentre.xz;
    rel = mod(rel + uExtent, uExtent * 2.0) - uExtent;
    float y = mod(p.y, uHeight);
    vec3 world = vec3(uCentre.x + rel.x, uCentre.y + y, uCentre.z + rel.y);

    float edge = max(abs(rel.x), abs(rel.y)) / uExtent;
    vFade = (1.0 - smoothstep(0.7, 1.0, edge)) * uAmount;
    // Fade in at the top of the band as well as out at the bottom. Rain can
    // blink into existence overhead because it is moving too fast to notice;
    // snow cannot.
    vFade *= smoothstep(0.0, 2.5, y) * (1.0 - smoothstep(uHeight - 5.0, uHeight, y));
    vSeed = aSeed;

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    float dist = max(0.5, -mv.z);
    gl_Position = projectionMatrix * mv;
    // Clamped at the low end well above one pixel: a flake thinner than a pixel
    // shimmers as it crosses the sampling grid, and a whole field of them
    // sparkles like static.
    gl_PointSize = clamp(aScale * uPixelRatio * 90.0 / dist, 1.6, 26.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;

  varying float vFade;
  varying float vSeed;

  void main() {
    vec2 q = gl_PointCoord - vec2(0.5);
    float r = length(q) * 2.0;
    if (r > 1.0) discard;

    // A soft grain, brighter in the middle. Not a hard disc: at these sizes a
    // disc's edge aliases against the sky and the field crawls.
    float body = 1.0 - smoothstep(0.15, 1.0, r);
    // Flakes are not all equally opaque — some are single crystals, some are
    // clumps — and the variation is most of what keeps a curtain of them from
    // reading as one flat texture.
    float weight = 0.55 + vSeed * 0.45;

    float a = body * weight * vFade;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

/**
 * Snow-lit white. What flakes are lifted toward as the air darkens.
 *
 * Needed for the same reason the rain has it: the fog colour goes nearly black
 * at night, so flakes tinted with it outright would vanish into exactly the
 * darkness they should be visible against. Snow is the most reflective thing in
 * the scene, so it is always brighter than the air behind it — and it is lifted
 * further than rain, because ice scatters more than water.
 */
const PALE = new Color(0.93, 0.95, 0.99);

export function createSnow(count: number, extent = 40, wind?: Wind): SnowField {
  /**
   * Height of the band flakes live in.
   *
   * Taller than the rain's. Fall speed here is about a tenth of a raindrop's, so
   * a flake spends ten times as long crossing the same band — and the eye follows
   * an individual flake, so it must not run out of sky while being watched.
   */
  const HEIGHT = 48;

  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const scales = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() * 2 - 1) * extent;
    positions[i * 3 + 1] = Math.random() * HEIGHT;
    positions[i * 3 + 2] = (Math.random() * 2 - 1) * extent;
    seeds[i] = Math.random();
    scales[i] = 0.6 + Math.random() * 1.1;
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
    uAmount: { value: 0 },
    uColor: { value: PALE.clone() },
  };

  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    // Normal, not additive, for the same reason as the rain: additive can only
    // brighten, and snow against a bright overcast sky is slightly darker than it.
    blending: NormalBlending,
    // Must stay false — a raw ShaderMaterial claiming fog support has to declare
    // three's fog uniforms and include its chunks, or the renderer throws every
    // frame while refreshing them. Distance is handled by the edge fade.
    fog: false,
  });

  const points = new Points(geometry, material);
  points.name = 'Snow';
  points.frustumCulled = false;
  points.renderOrder = 3;
  points.visible = false;

  const update = (centre: Vector3, elapsed: number, amount: number, tint: Color): void => {
    // Clear weather costs nothing: no uniform writes and no draw call.
    points.visible = amount > 0.02;
    if (!points.visible) return;

    uniforms.uAmount.value = Math.min(1, amount);
    // Hangs from a little below the feet to well overhead, so there are flakes
    // between the camera and the ground however the view is aimed.
    uniforms.uCentre.value.set(centre.x, centre.y - 5, centre.z);
    if (!wind) uniforms.uTime.value = elapsed;

    const luminance = tint.r * 0.3 + tint.g * 0.6 + tint.b * 0.1;
    const lift = 0.45 + (1 - Math.min(1, luminance)) * 0.45;
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
