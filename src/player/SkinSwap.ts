import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Points,
  ShaderMaterial,
  type Vector3,
} from 'three';

/**
 * SkinSwap
 * --------
 * The puff of motes that covers a character change: the body bursts apart, and
 * the new one is already standing there when the motes clear.
 *
 * It is a cover, not a simulation. Dissolving the actual mesh would mean cloning
 * its materials per instance to animate opacity — the prototype's materials are
 * shared by every player wearing that model, so touching them would fade
 * everybody at once — and sampling live skinned vertex positions on the CPU every
 * frame. A cloud filling the body's volume reads the same at this scale for one
 * draw call and no allocation during play.
 *
 * The exchange happens at `SWAP_AT`, once the cloud is dense enough to hide it,
 * which is why the caller is handed a callback rather than doing it up front.
 */

const PARTICLES = 190;
/** Seconds for the whole effect. */
const DURATION = 0.85;
/** Fraction of the effect at which the cloud is thick enough to swap behind. */
const SWAP_AT = 0.17;

const VERT = /* glsl */ `
  attribute vec3 aBase;
  attribute vec3 aDir;
  attribute float aSeed;
  attribute float aSize;

  uniform float uT;
  uniform float uPixelRatio;

  varying float vAlpha;

  void main() {
    float t = clamp(uT, 0.0, 1.0);
    // Fast outward burst that slows down, rather than a linear drift.
    float e = 1.0 - pow(1.0 - t, 2.4);

    vec3 p = aBase + aDir * e * (0.5 + aSeed * 0.75);
    // Rise, then sag: motes behave like embers, not like shrapnel.
    p.y += e * (0.3 + aSeed * 0.55) - e * e * 0.3;

    // A little swirl around the body axis so it does not read as a sphere.
    float ang = e * (2.2 + aSeed * 3.2);
    float c = cos(ang);
    float s = sin(ang);
    p.xz = mat2(c, -s, s, c) * p.xz;

    // In quickly, out gently, and never a hard edge at either end.
    float a = sin(3.14159265 * t);
    vAlpha = a * a;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    // Tuned to read as dust rather than as blobs when the camera is close in.
    gl_PointSize = aSize * uPixelRatio * (8.5 / max(0.5, -mv.z));
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;

  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d);
    if (r > 0.5) discard;
    gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, r) * vAlpha);
  }
`;

export class SkinSwap {
  readonly object = new Group();

  private readonly points: Points;
  private readonly geometry: BufferGeometry;
  private readonly material: ShaderMaterial;
  private elapsed = 0;
  private swapped = false;
  private onSwap: (() => void) | null;

  /** True once the effect has run its course and should be disposed. */
  get finished(): boolean {
    return this.elapsed >= DURATION;
  }

  /**
   * `height` and `radius` describe the body the motes should fill. `onSwap` runs
   * once, partway through, and is where the old model is exchanged for the new.
   */
  constructor(height: number, radius: number, onSwap: () => void) {
    this.onSwap = onSwap;

    const base = new Float32Array(PARTICLES * 3);
    const dir = new Float32Array(PARTICLES * 3);
    const seed = new Float32Array(PARTICLES);
    const size = new Float32Array(PARTICLES);

    for (let i = 0; i < PARTICLES; i++) {
      // Fill a cylinder around the body, denser toward the middle of the torso so
      // the silhouette is covered where it is widest.
      const ang = Math.random() * Math.PI * 2;
      const r = radius * Math.sqrt(Math.random());
      const h = Math.pow(Math.random(), 0.85) * height;
      const bx = Math.cos(ang) * r;
      const bz = Math.sin(ang) * r;
      base[i * 3] = bx;
      base[i * 3 + 1] = h;
      base[i * 3 + 2] = bz;

      // Outward from the body axis, with a little vertical spread.
      const len = Math.max(1e-3, Math.hypot(bx, bz));
      dir[i * 3] = (bx / len) * (0.6 + Math.random() * 0.8);
      dir[i * 3 + 1] = (Math.random() - 0.35) * 0.7;
      dir[i * 3 + 2] = (bz / len) * (0.6 + Math.random() * 0.8);

      seed[i] = Math.random();
      size[i] = 1 + Math.random() * 1.7;
    }

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(base.slice(), 3));
    this.geometry.setAttribute('aBase', new BufferAttribute(base, 3));
    this.geometry.setAttribute('aDir', new BufferAttribute(dir, 3));
    this.geometry.setAttribute('aSeed', new BufferAttribute(seed, 1));
    this.geometry.setAttribute('aSize', new BufferAttribute(size, 1));

    this.material = new ShaderMaterial({
      uniforms: {
        uT: { value: 0 },
        uColor: { value: new Color(0.72, 0.86, 1.0) },
        uPixelRatio: { value: Math.min(2, globalThis.devicePixelRatio || 1) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.points = new Points(this.geometry, this.material);
    // The cloud is animated in the shader, so its bounds are wrong by
    // construction and culling it would make it vanish at the edge of view.
    this.points.frustumCulled = false;
    this.object.add(this.points);
  }

  /** Keep the cloud on the body while it walks. */
  setCentre(pos: Vector3): void {
    this.object.position.copy(pos);
  }

  update(dt: number): void {
    this.elapsed += dt;
    const t = this.elapsed / DURATION;
    this.material.uniforms.uT!.value = t;
    if (!this.swapped && t >= SWAP_AT) {
      this.swapped = true;
      const fn = this.onSwap;
      this.onSwap = null;
      fn?.();
    }
  }

  /** Runs the exchange even if the effect is cut short, so no state is stranded. */
  dispose(): void {
    if (!this.swapped) {
      this.swapped = true;
      const fn = this.onSwap;
      this.onSwap = null;
      fn?.();
    }
    this.geometry.dispose();
    this.material.dispose();
    this.object.removeFromParent();
  }
}
