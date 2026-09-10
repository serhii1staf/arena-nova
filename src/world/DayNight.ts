import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  type DirectionalLight,
  type FogExp2,
  Group,
  type HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  Points,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { surfaceBiomeAt, type BiomeId } from './WorldGen.ts';
import { createAurora, type AuroraField } from './Aurora.ts';
import { Weather } from './Weather.ts';

/**
 * DayNight
 * --------
 * Drives the whole sky: where the sun and moon are, what colour the light is,
 * how thick and what colour the haze is, and how bright the stars are. Every
 * consumer reads one state object per frame, so the lighting rig, the fog, the
 * sky dome tint and the firefly density can never disagree about what time it is.
 *
 * The palette is expressed as day / golden-hour / night stops that are blended by
 * the sun's own elevation rather than by the clock. That way dawn and dusk fall
 * out of the geometry instead of needing their own timeline, and a change to the
 * sun's arc automatically moves the colours with it.
 */

/** Seconds of real time for one full day. */
const DAY_LENGTH = 600;
/** Distance the celestial bodies sit from the camera. Inside the sky dome. */
const SKY_RADIUS = 4200;

interface Palette {
  sun: Color;
  sunIntensity: number;
  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  fog: Color;
  fogDensity: number;
  skyTint: Color;
}

const DAY: Palette = {
  sun: new Color(1.0, 0.98, 0.88),
  sunIntensity: 3.4,
  hemiSky: new Color(0.8, 0.9, 0.85),
  hemiGround: new Color(0.25, 0.3, 0.2),
  hemiIntensity: 1.4,
  fog: new Color(0.68, 0.78, 0.76),
  fogDensity: 0.00085,
  skyTint: new Color(1, 1, 1),
};

const GOLDEN: Palette = {
  sun: new Color(1.0, 0.62, 0.33),
  sunIntensity: 2.6,
  hemiSky: new Color(0.72, 0.6, 0.55),
  hemiGround: new Color(0.24, 0.18, 0.14),
  hemiIntensity: 1.0,
  fog: new Color(0.85, 0.6, 0.45),
  fogDensity: 0.0011,
  skyTint: new Color(1.0, 0.72, 0.55),
};

const NIGHT: Palette = {
  sun: new Color(0.42, 0.54, 0.9),
  sunIntensity: 0,
  hemiSky: new Color(0.09, 0.13, 0.24),
  hemiGround: new Color(0.03, 0.04, 0.07),
  // Low enough that the fireflies genuinely contribute, high enough to navigate.
  hemiIntensity: 0.24,
  fog: new Color(0.04, 0.06, 0.12),
  fogDensity: 0.0013,
  skyTint: new Color(0.1, 0.14, 0.28),
};

/** Biomes where the air holds moisture, so the haze thickens under the canopy. */
const FOG_BY_BIOME: Partial<Record<BiomeId, { multiplier: number; tint: Color }>> = {
  jungle: { multiplier: 2.4, tint: new Color(0.42, 0.55, 0.44) },
  pine: { multiplier: 2.1, tint: new Color(0.5, 0.56, 0.56) },
  wetland: { multiplier: 3.0, tint: new Color(0.52, 0.58, 0.5) },
  snow: { multiplier: 1.9, tint: new Color(0.82, 0.87, 0.92) },
};

/**
 * How much mist pools on the ground, per biome, before time of day is applied.
 *
 * Kept separate from `FOG_BY_BIOME` because the two answer different questions.
 * Distance haze is about how much air is between you and a ridge; ground mist is
 * about whether cold air settles where you are standing. A snowfield reads as
 * clear at a distance but drifts at your feet, and a jungle is the reverse.
 */
const MIST_BY_BIOME: Record<BiomeId, number> = {
  wetland: 1,
  pine: 0.82,
  jungle: 0.66,
  snow: 0.55,
  sakura: 0.44,
  meadow: 0.3,
  highland: 0.26,
  beach: 0.16,
  ocean: 0.12,
  savanna: 0.1,
};

/** Shared, so the no-fog branch does not allocate a Color every frame. */
const WHITE = new Color(1, 1, 1);

function smoothStep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const STAR_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  uniform float uTime;
  uniform float uPixelRatio;
  varying float vTwinkle;
  void main() {
    vTwinkle = 0.65 + 0.35 * sin(uTime * 1.7 + aPhase * 6.283);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio;
  }
`;

const STAR_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying float vTwinkle;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d);
    if (r > 0.5) discard;
    float a = smoothstep(0.5, 0.0, r) * uOpacity * vTwinkle;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(1.0, 0.98, 0.94, a);
  }
`;

const HALO_VERT = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vToEye;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vToEye = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const HALO_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vNormalW;
  varying vec3 vToEye;
  void main() {
    // 1 at the point of the sphere facing the camera, 0 at its silhouette — a
    // radial gradient centred on the sun once projected to the screen.
    float f = max(0.0, dot(normalize(vNormalW), normalize(vToEye)));
    float a = pow(f, 1.8) * uOpacity;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

export interface DayNightTargets {
  /** The shadow-casting sun. */
  sun: DirectionalLight;
  /** Fill light from the opposite side; carries moonlight at night. */
  moon: DirectionalLight;
  hemi: HemisphereLight;
  fog: FogExp2;
  background: Color;
  /** Material of the sky dome, tinted to shift the whole sky. */
  skyMaterial: MeshBasicMaterial;
}

export class DayNight {
  /** Everything that has to sit far away and follow the camera. */
  readonly group = new Group();

  /** 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  t01: number;
  /** 0 in full daylight, 1 in full dark. Drives fireflies and stars. */
  nightFactor = 0;
  /** Current star visibility, exposed for diagnostics. */
  starOpacity = 0;
  /**
   * 0..1 density for the ground mist where the player is standing.
   *
   * Weighted heavily toward night and the golden hour: mist at midday reads as
   * haze and just looks like a dirty screen, while the same amount at dusk is
   * most of what makes a wood feel uneasy.
   */
  mistAmount = 0;

  /**
   * 0..1 rain intensity where the player is standing. Owned by `Weather`, which
   * sits here beside the mist and fog tables because it answers the same kind of
   * question: what is the sky doing, and how does this biome change the answer.
   */
  rainAmount = 0;

  /**
   * 0..1 how wet the ground is. Lags the rain in both directions — soaks in a
   * couple of seconds, takes most of a minute to dry — which is what stops the
   * world flipping between wet and dry as a shower passes over. Deliberately
   * read back through `rainAmount`, so forcing that value in a diagnostic soaks
   * the ground too instead of leaving it dry under a downpour.
   */
  wetness = 0;

  private readonly weather = new Weather();

  /**
   * The sun disc, offered as a god-rays source.
   *
   * The effect was configured and enabled on the high and ultra tiers all along,
   * but the open world never named a source mesh, so it silently did nothing
   * outdoors — only the cathedral had rays. The disc already dims to zero opacity
   * as it sets, so the rays fade themselves without extra bookkeeping.
   */
  get sunMesh(): Mesh {
    return this.sunDisc;
  }

  readonly sunDir = new Vector3(0, 1, 0);
  readonly moonDir = new Vector3(0, -1, 0);
  /** Bearing of the horizon glow — the sun's, but never below the skyline. */
  private readonly haloDir = new Vector3();

  private readonly sunDisc: Mesh;
  private readonly halo: Mesh;
  private readonly haloGeo: SphereGeometry;
  private readonly haloMat: ShaderMaterial;
  private readonly haloUniforms: { uColor: { value: Color }; uOpacity: { value: number } };
  private readonly moonDisc: Mesh;
  private readonly stars: Points;
  private readonly aurora: AuroraField;
  private readonly starUniforms: {
    uTime: { value: number };
    uOpacity: { value: number };
    uPixelRatio: { value: number };
  };
  private readonly sunMat: MeshBasicMaterial;
  private readonly moonMat: MeshBasicMaterial;
  private readonly starGeo: BufferGeometry;
  private readonly starMat: ShaderMaterial;
  private readonly sunGeo: SphereGeometry;
  private readonly moonGeo: SphereGeometry;

  /** Eased so walking into a forest thickens the haze gradually. */
  private fogMultiplier = 1;
  private readonly fogTint = new Color();
  private readonly scratch = new Color();
  private elapsed = 0;

  /** `startAt` is a time of day in the same 0..1 units; defaults to mid-morning. */
  constructor(startAt = 0.34) {
    this.t01 = startAt;
    this.group.name = 'Sky';

    this.sunGeo = new SphereGeometry(78, 16, 12);
    this.sunMat = new MeshBasicMaterial({
      color: new Color(1, 0.96, 0.85),
      fog: false,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
    });
    this.sunDisc = new Mesh(this.sunGeo, this.sunMat);
    // Drawn before the terrain, so the depth buffer is still empty and the disc
    // shows through the sky dome — yet the ground still covers it once it sets.
    this.sunDisc.renderOrder = -1;
    this.group.add(this.sunDisc);

    // Warm halo around the sun. The sky texture is a fixed image, so tinting it
    // can darken the blue but can never *add* the orange a sunset needs.
    //
    // It has to be a gradient, not a flat disc: a uniform additive sphere reads
    // as a hard-edged white blob once tone mapping and bloom get hold of it. The
    // shader fades the glow out toward the sphere's silhouette, which projects to
    // a soft radial falloff around the sun.
    this.haloGeo = new SphereGeometry(1700, 24, 16);
    this.haloUniforms = {
      uColor: { value: new Color(1.0, 0.45, 0.18) },
      uOpacity: { value: 0 },
    };
    this.haloMat = new ShaderMaterial({
      uniforms: this.haloUniforms,
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    });
    this.halo = new Mesh(this.haloGeo, this.haloMat);
    this.halo.renderOrder = -1;
    this.halo.frustumCulled = false;
    this.group.add(this.halo);

    this.moonGeo = new SphereGeometry(62, 16, 12);
    this.moonMat = new MeshBasicMaterial({
      color: new Color(0.9, 0.93, 1.0),
      fog: false,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
    });
    this.moonDisc = new Mesh(this.moonGeo, this.moonMat);
    this.moonDisc.renderOrder = -1;
    this.group.add(this.moonDisc);

    // ---- Stars -----------------------------------------------------------
    const count = 900;
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Upper hemisphere only; below the horizon they'd be inside the ground.
      const u = Math.random();
      const v = Math.random() * 0.92 + 0.06;
      const theta = u * Math.PI * 2;
      const y = Math.cos(v * Math.PI * 0.5);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      pos[i * 3] = Math.cos(theta) * r * SKY_RADIUS * 1.02;
      pos[i * 3 + 1] = y * SKY_RADIUS * 1.02;
      pos[i * 3 + 2] = Math.sin(theta) * r * SKY_RADIUS * 1.02;
      size[i] = 1.1 + Math.random() * 2.4;
      phase[i] = Math.random();
    }
    this.starGeo = new BufferGeometry();
    this.starGeo.setAttribute('position', new BufferAttribute(pos, 3));
    this.starGeo.setAttribute('aSize', new BufferAttribute(size, 1));
    this.starGeo.setAttribute('aPhase', new BufferAttribute(phase, 1));
    this.starUniforms = {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uPixelRatio: {
        value: Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2),
      },
    };
    this.starMat = new ShaderMaterial({
      uniforms: this.starUniforms,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    });
    this.stars = new Points(this.starGeo, this.starMat);
    this.stars.renderOrder = -1;
    this.stars.frustumCulled = false;
    this.group.add(this.stars);

    this.aurora = createAurora();
    this.group.add(this.aurora.mesh);
  }

  /** Advances the clock and recomputes the sky. Call once per rendered frame. */
  update(frameDelta: number, playerPos: Vector3): void {
    this.elapsed += frameDelta;
    this.t01 = (this.t01 + frameDelta / DAY_LENGTH) % 1;
    this.starUniforms.uTime.value = this.elapsed;

    // Sun arc: tilted so noon is high but not straight overhead, which keeps
    // shadows readable and stops the ground going flat at midday.
    const theta = (this.t01 - 0.25) * Math.PI * 2;
    const horiz = Math.cos(theta);
    this.sunDir.set(horiz * 0.36 + 0.16, Math.sin(theta) * 0.94, horiz * 0.9).normalize();
    this.moonDir.copy(this.sunDir).multiplyScalar(-1);

    const elev = this.sunDir.y;
    // Daylight is already well up by the time the sun reaches the horizon —
    // that is what civil twilight is. Ramping from below the horizon leaves room
    // for a real golden hour instead of snapping from night straight to noon.
    const dayness = smoothStep(-0.22, 0.16, elev);
    // Golden hour peaks exactly at the horizon, at sunrise and at sunset.
    const golden = 1 - smoothStep(0, 0.28, Math.abs(elev));
    // Fireflies and stars wait until the sun is properly down.
    this.nightFactor = 1 - smoothStep(-0.3, -0.02, elev);

    // Local air: thicker and greener under a canopy, and thicker again at night.
    const biome = surfaceBiomeAt(playerPos.x, playerPos.z);
    const local = FOG_BY_BIOME[biome];
    const targetMul = (local?.multiplier ?? 1) * (1 + this.nightFactor * 0.35);
    // Eased, so crossing a treeline is a gradual thickening rather than a step.
    const k = Math.min(1, frameDelta * 0.5);
    this.fogMultiplier += (targetMul - this.fogMultiplier) * k;
    this.fogTint.lerp(local?.tint ?? WHITE, k);

    // Ground mist: biome first, then time of day. Dawn and dusk get a lift of
    // their own so the mist is at its thickest exactly when the light is lowest.
    const targetMist =
      MIST_BY_BIOME[biome] * (0.18 + this.nightFactor * 0.72 + golden * 0.45);
    this.mistAmount += (Math.min(1, targetMist) - this.mistAmount) * k;

    // Rain, and the ground remembering it. The read of `this.rainAmount` is the
    // published value rather than the local one on purpose (see the field).
    this.weather.update(frameDelta, this.elapsed, biome);
    this.rainAmount = this.weather.rain;
    const rain = this.rainAmount;
    // Soaks about ten times faster than it dries.
    const soak = rain > this.wetness ? 0.5 : 0.045;
    this.wetness += (rain - this.wetness) * Math.min(1, frameDelta * soak);
    if (this.wetness < 0.002) this.wetness = 0;

    this.sunDisc.position.copy(playerPos).addScaledVector(this.sunDir, SKY_RADIUS);
    this.moonDisc.position.copy(playerPos).addScaledVector(this.moonDir, SKY_RADIUS);
    // The glow is pinned to just above the horizon on the sun's bearing rather
    // than to the sun itself. Once the sun dips, its own position is below the
    // skyline and the terrain simply covers the glow — but an afterglow over the
    // horizon is the whole point of a sunset.
    this.haloDir.copy(this.sunDir);
    this.haloDir.y = Math.max(this.haloDir.y, 0.05);
    this.haloDir.normalize();
    this.halo.position.copy(playerPos).addScaledVector(this.haloDir, SKY_RADIUS * 0.9);
    // Strongest at the horizon, and it lingers a little after the sun has set.
    this.haloUniforms.uOpacity.value = golden * (0.75 * smoothStep(-0.34, 0.02, elev) + 0.15);
    this.haloUniforms.uColor.value.setRGB(
      0.95,
      0.34 + (1 - golden) * 0.45,
      0.12 + (1 - golden) * 0.55,
    );
    this.group.position.set(0, 0, 0);
    this.stars.position.copy(playerPos);
    // Aurora comes up with the stars but lags them slightly and is never quite
    // steady, so it reads as weather rather than as a fixture of the sky.
    const auroraAmount =
      Math.pow(this.nightFactor, 1.8) * (0.55 + 0.45 * Math.sin(this.elapsed * 0.045));
    this.aurora.update(playerPos, this.elapsed, auroraAmount);

    // The sun disc dims and reddens into the haze as it sets; the moon only shows
    // once the sky is dark enough for it to read.
    this.sunMat.opacity = smoothStep(-0.12, 0.02, elev);
    this.sunMat.color.setRGB(1, 0.96 - golden * 0.3, 0.85 - golden * 0.5);
    this.moonMat.opacity = this.nightFactor * 0.95;
    this.starOpacity = Math.pow(this.nightFactor, 1.4) * 0.95;
    this.starUniforms.uOpacity.value = this.starOpacity;

    this.dayness = dayness;
    this.golden = golden;
  }

  private dayness = 1;
  private golden = 0;

  /** Writes the current state into the scene's lighting rig. */
  applyTo(t: DayNightTargets): void {
    const day = this.dayness;
    const gold = this.golden;

    // Night → day, then the golden cast layered on top near the horizon. The
    // golden weight is deliberately independent of `day`: gating it by daylight
    // cancelled it out at exactly the moment it should be strongest.
    const goldWeight = gold * 0.85;
    const blend = (out: Color, night: Color, dayC: Color, goldC: Color): void => {
      out.copy(night).lerp(dayC, day);
      out.lerp(goldC, goldWeight);
    };

    blend(t.sun.color, NIGHT.sun, DAY.sun, GOLDEN.sun);
    t.sun.intensity =
      (NIGHT.sunIntensity + (DAY.sunIntensity - NIGHT.sunIntensity) * day) * (1 - gold * 0.3);

    // The fill light carries the moon: it points the other way and only lights
    // anything once the sun is down, which is what makes night readable without
    // paying for a second shadow map.
    t.moon.intensity = this.nightFactor * 0.55;
    t.moon.color.setRGB(0.5, 0.62, 0.95);

    blend(t.hemi.color, NIGHT.hemiSky, DAY.hemiSky, GOLDEN.hemiSky);
    blend(t.hemi.groundColor, NIGHT.hemiGround, DAY.hemiGround, GOLDEN.hemiGround);
    t.hemi.intensity =
      NIGHT.hemiIntensity + (DAY.hemiIntensity - NIGHT.hemiIntensity) * day - gold * 0.25;

    blend(t.fog.color, NIGHT.fog, DAY.fog, GOLDEN.fog);
    // Canopy tint, applied as a multiply so it deepens rather than replaces.
    t.fog.color.multiply(this.scratch.setRGB(
      1 - (1 - this.fogTint.r) * 0.7,
      1 - (1 - this.fogTint.g) * 0.7,
      1 - (1 - this.fogTint.b) * 0.7,
    ));
    const baseDensity =
      NIGHT.fogDensity + (DAY.fogDensity - NIGHT.fogDensity) * day + gold * 0.00035;
    t.fog.density = baseDensity * this.fogMultiplier;

    t.background.copy(t.fog.color);
    blend(t.skyMaterial.color, NIGHT.skyTint, DAY.skyTint, GOLDEN.skyTint);
  }

  dispose(): void {
    this.aurora.dispose();
    this.sunGeo.dispose();
    this.moonGeo.dispose();
    this.haloGeo.dispose();
    this.haloMat.dispose();
    this.sunMat.dispose();
    this.moonMat.dispose();
    this.starGeo.dispose();
    this.starMat.dispose();
  }
}
