import {
  AdditiveBlending,
  BackSide,
  CylinderGeometry,
  Mesh,
  ShaderMaterial,
  type Vector3,
} from 'three';

/**
 * Aurora
 * ------
 * Northern lights: curtains of green and violet hanging over the world after
 * dark.
 *
 * One open-ended cylinder around the player, drawn from the inside, with every
 * curtain formed in the fragment shader. A cylinder rather than a few billboards
 * because the bands have to keep their shape as you turn — a flat curtain gives
 * itself away the moment you walk past its edge, and a ring has no edge.
 *
 * The shape is layered sine bands rather than a noise texture. Aurora is smooth,
 * vertically streaked and slowly shearing, which is exactly what a few sines at
 * different rates give; a noise lookup would cost a texture and look busier than
 * the real thing.
 *
 * Sits inside the sky dome and outside anything else, is additive, and writes no
 * depth — so terrain and mountains occlude it correctly while it never occludes
 * anything itself.
 */

/** Radius of the curtain ring, well inside the sky dome. */
const RADIUS = 2400;
const HEIGHT = 1100;
/** Height of the base above the player. Aurora is high; this keeps it overhead. */
const BASE = 240;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uAmount;
  varying vec2 vUv;

  void main() {
    // uv.x runs once around the ring, uv.y from the base upward.
    float x = vUv.x * 6.2831853;
    float y = vUv.y;

    // Only part of the sky carries the display, and that part drifts. Otherwise
    // the aurora is a uniform band all the way round, which reads as a bug.
    float centre = uTime * 0.006;
    float d = abs(fract(vUv.x - centre + 0.5) - 0.5);
    // Wide: a narrow arc is easy to miss entirely depending on which way you
    // happen to be facing, and the point of an aurora is that it dominates the
    // sky. Still falls off, so it is a display in part of the sky rather than a
    // uniform band all the way round.
    float window = 1.0 - smoothstep(0.20, 0.50, d);
    if (window <= 0.001) discard;

    // Curtains: three shearing waves at different rates. The vertical term makes
    // each band lean as it rises, which is what gives the folded-sheet look.
    //
    // Every frequency here MUST be a whole number. x runs 0..2PI once around the
    // ring, so a fractional multiplier does not come back to the same phase after
    // a full turn: the pattern fails to close and leaves a hard vertical seam
    // down the sky where the two ends of the cylinder meet.
    float lean = y * 1.7;
    float w1 = sin(x * 3.0 + lean + uTime * 0.10);
    float w2 = sin(x * 7.0 - lean * 0.6 + uTime * 0.16) * 0.6;
    float w3 = sin(x * 13.0 + lean * 1.4 - uTime * 0.23) * 0.35;
    float folds = w1 + w2 + w3;

    // Turn the wave field into discrete ribbons with soft edges.
    float ribbon = pow(max(0.0, 1.0 - abs(folds) * 0.42), 2.4);

    // Bright and dense at the bottom, dissolving into streaks at the top.
    float rise = smoothstep(0.0, 0.10, y) * (1.0 - smoothstep(0.55, 1.0, y));
    // Vertical streaking, the giveaway detail of a real aurora. Whole numbers
    // again, for the same reason as the folds.
    float streak = 0.75 + 0.25 * sin(x * 41.0 + sin(x * 7.0) * 3.0);

    // Brightness waves running along the curtain. This is the shimmer: in a real
    // display the light does not simply fade up and down, pulses travel sideways
    // through the sheet and overlap. Two speeds in opposite directions, plus a
    // faster ripple, so the interference never repeats visibly.
    float p1 = sin(x * 2.0 - uTime * 0.55 + y * 2.0);
    float p2 = sin(x * 5.0 + uTime * 0.37 - y * 1.3);
    float p3 = sin(x * 11.0 - uTime * 0.9 + y * 4.0);
    float shimmer = 0.55 + 0.45 * (0.5 + 0.28 * p1 + 0.16 * p2 + 0.10 * p3);

    float a = ribbon * rise * window * streak * shimmer * uAmount;
    if (a <= 0.002) discard;

    // Green at the base through cyan to violet at the tips.
    vec3 low = vec3(0.15, 1.0, 0.45);
    vec3 mid = vec3(0.25, 0.85, 0.8);
    vec3 high = vec3(0.55, 0.35, 0.95);
    vec3 col = mix(low, mid, smoothstep(0.0, 0.4, y));
    col = mix(col, high, smoothstep(0.35, 0.9, y));

    // The hue drifts along the curtain as well as up it, tied to the same waves
    // that drive the brightness. Height alone gives a static gradient that a
    // pulsing alpha cannot rescue — it reads as a lit backdrop rather than
    // something alive. Coupling colour to the travelling pulses is what makes it
    // shift and swim.
    float hueShift = 0.5 + 0.5 * p1 * p2;
    col = mix(col, vec3(0.45, 0.55, 1.0), hueShift * 0.20 * y);
    // Ribbon cores run hotter and greener than their edges, the way a bright fold
    // photographs almost white-green.
    col += vec3(0.20, 0.55, 0.28) * pow(ribbon, 2.0);

    // Additive over a night sky, so the alpha has to be generous to register at
    // all: the ribbon term alone lands around a tenth, which is invisible.
    gl_FragColor = vec4(col, min(1.0, a * 2.1));
  }
`;

export interface AuroraField {
  mesh: Mesh;
  /** `amount` is 0..1; the whole thing switches off in daylight. */
  update(centre: Vector3, elapsed: number, amount: number): void;
  dispose(): void;
}

export function createAurora(): AuroraField {
  // Open-ended: only the wall is wanted, and the wall is what the shader draws on.
  const geometry = new CylinderGeometry(RADIUS, RADIUS * 1.15, HEIGHT, 96, 1, true);
  const uniforms = {
    uTime: { value: 0 },
    uAmount: { value: 0 },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    // Seen from inside the ring.
    side: BackSide,
    blending: AdditiveBlending,
    fog: false,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'Aurora';
  // Behind everything solid, like the stars: it must not occlude terrain, and
  // terrain must occlude it.
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  mesh.visible = false;

  const update = (centre: Vector3, elapsed: number, amount: number): void => {
    const a = Math.min(1, Math.max(0, amount));
    mesh.visible = a > 0.01;
    if (!mesh.visible) return;
    uniforms.uTime.value = elapsed;
    uniforms.uAmount.value = a;
    mesh.position.set(centre.x, centre.y + BASE + HEIGHT / 2, centre.z);
  };

  return {
    mesh,
    update,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      mesh.removeFromParent();
    },
  };
}
