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
import { cellRandom, surfaceBiomeAt, WORLD, type BiomeId } from './WorldGen.ts';
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
/**
 * How fast lying snow builds up in a full storm, and how fast it goes in full sun,
 * as a fraction of total cover per second.
 *
 * Melting is the faster of the two on purpose. Snow that accumulated as easily as
 * it thawed would leave the range white almost permanently, because a front passes
 * far more often than a whole clear day does — and permanent snow says nothing. The
 * asymmetry is what makes a covering read as weather that happened rather than as
 * a texture that was always there.
 */
/**
 * The colour of air over snow: cold, desaturated, faintly blue.
 *
 * Slightly blue rather than neutral grey on purpose. Snow is bright enough that
 * the light bouncing off it dominates what fills the shadows, and that light has
 * been through ice — which is why photographs of snow have blue shadows and why
 * neutral grey haze over a snowfield reads as smog.
 */
const SNOW_AIR = new Color(0.82, 0.86, 0.92);

const SNOW_SETTLE_RATE = 0.022;
const SNOW_MELT_RATE = 0.03;

/**
 * Altitudes between which precipitation turns from rain to snow, in metres.
 *
 * A band rather than a line: at the bottom it is all rain, at the top all snow,
 * and in between both are drawn at partial strength, which is what sleet is. A
 * hard threshold would make the transition pop as the player walked uphill.
 *
 * The band sits below `WORLD.snowLine` because that constant marks where the
 * terrain is *permanently* white; weather turns to snow well before that, which is
 * exactly what puts fresh snow on ground that is normally bare.
 */
/**
 * Lowered from 0.52. At that fraction the band began around 148 m, which almost no
 * routine play reaches — a front arriving while the player was anywhere near the
 * plaza came down entirely as rain, so falling snow was something you had to go
 * mountaineering to witness even though the covering on the peaks was working.
 */
const FREEZE_LOW = WORLD.snowLine * 0.34;
const FREEZE_HIGH = WORLD.snowLine * 0.92;

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

// ---------------------------------------------------------------------------
// Aurora schedule
// ---------------------------------------------------------------------------

/**
 * Share of nights that carry a display. Around two in five, so one is typically
 * two or three nights away — often enough to be worth looking up on a clear
 * night, rare enough that finding one is a find rather than a fixture.
 */
const AURORA_NIGHTS = 0.4;
/**
 * Salt for the schedule hash. Arbitrary but fixed: changing it reshuffles which
 * nights have a display for every player.
 */
const AURORA_SALT = 7331;
/** A display night peaks somewhere in this band. */
const AURORA_MIN_STRENGTH = 0.38;
const AURORA_MAX_STRENGTH = 1;

/**
 * How strong night `index` is, or 0 for a night with no display at all.
 *
 * Hashed from the night index rather than rolled when the night begins. The
 * amount is recomputed from scratch every frame, so a fresh roll would flicker
 * and a stored roll would be one more piece of state to keep in step with the
 * clock; a hash gives the same answer every time it is asked, in any order, from
 * any starting point — including after the clock is driven forwards or back.
 *
 * Strength comes out of the *same* number that decides whether there is a
 * display, remapped across the band below the threshold. Nothing to keep in
 * agreement, and a weak showing is as likely as one that fills the sky.
 */
function auroraStrengthFor(index: number): number {
  const r = cellRandom(index, 0, AURORA_SALT);
  if (r >= AURORA_NIGHTS) return 0;
  const t = r / AURORA_NIGHTS;
  return AURORA_MIN_STRENGTH + t * (AURORA_MAX_STRENGTH - AURORA_MIN_STRENGTH);
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

  /**
   * Days since the world began, fractional. This is the clock; everything else
   * about time of day is derived from it.
   *
   * Its fractional part is the time of day (`t01`) and its whole part is which
   * day we are on, which is what the aurora schedule keys off. Kept as one
   * number rather than a time plus a day counter so the two can never disagree,
   * and public because it *is* the clock: something that wants to look at three
   * consecutive nights advances this rather than waiting ten minutes a night.
   */
  clock = 0;

  /** 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  get t01(): number {
    return this.clock - Math.floor(this.clock);
  }

  /** Jumps to a time of day within the current day, leaving the date alone. */
  set t01(v: number) {
    this.clock = Math.floor(this.clock) + (((v % 1) + 1) % 1);
  }

  /**
   * Which night we are in, counting from the world's first.
   *
   * Offset by half a day so the index turns over at noon. A night straddles
   * midnight, so counting whole days would put the small hours in a different
   * night from the evening before them — and an aurora scheduled per night would
   * switch off half way through it.
   */
  get nightIndex(): number {
    return Math.floor(this.clock + 0.5);
  }

  /** 0 in full daylight, 1 in full dark. Drives fireflies and stars. */
  nightFactor = 0;
  /** Current star visibility, exposed for diagnostics. */
  starOpacity = 0;
  /**
   * What tonight's display peaks at, 0 on a night that has none. Constant for
   * the whole of one night; see `auroraStrengthFor`.
   */
  auroraStrength = 0;
  /** What the aurora is doing right now, 0..1. Exposed beside `starOpacity`. */
  auroraAmount = 0;
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

  /**
   * How hard it is snowing where the player is standing, 0..1.
   *
   * Separate from `rainAmount` rather than a sign on it, because the two are
   * drawn by different fields and can legitimately be non-zero within a few
   * hundred metres of each other — sleet at the treeline is rain below and snow
   * above, and the player walks between them.
   */
  snowAmount = 0;

  /**
   * How much snow is lying, 0..1. Not a depth in metres: it is how far down the
   * mountains the snowline has crept, which is what the eye actually reads.
   *
   * Slow in both directions and deliberately asymmetric — a night of snowfall
   * accumulates less than a clear afternoon melts — so a fall builds up over
   * minutes and a thaw takes longer still. A value that could swing inside a
   * minute would have the mountains flickering white as fronts passed.
   */
  snowCover = 0;

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
  /** Night the cached `auroraStrength` was computed for; -1 before the first. */
  private scheduledNight = -1;

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

  /**
   * How much of the precipitation at a given height falls as snow, 0..1.
   *
   * Altitude carries almost all of it, because a lapse rate is the one part of
   * this the player can act on: they can climb. Night adds a little, so a shower
   * that arrives as rain in the afternoon can arrive as snow after dark at the
   * same spot — which is a cheap way to make the same terrain read differently
   * across a day, and is also what really happens.
   */
  private freezingAt(height: number): number {
    const lift = this.nightFactor * 26;
    const t = (height + lift - FREEZE_LOW) / (FREEZE_HIGH - FREEZE_LOW);
    return Math.min(1, Math.max(0, t));
  }

  /**
   * Pinned weather, or `null` to let the sky decide again.
   *
   * Exists because weather is a slow function of time, biome and altitude, which is
   * exactly right for play and useless for looking at something on purpose: waiting
   * for a front to arrive at the altitude you happen to be standing at is not a
   * workflow. The admin panel and the diagnostics both need to hold a state still.
   */
  private forced: { rain: number; snow: number; cover: number } | null = null;

  /** Holds the weather at fixed values, or releases it when given `null`. */
  forceWeather(state: { rain: number; snow: number; cover: number } | null): void {
    this.forced = state;
  }

  /** True while the weather is pinned, so a UI can show it. */
  get weatherForced(): boolean {
    return this.forced !== null;
  }

  /** Advances the clock and recomputes the sky. Call once per rendered frame. */
  update(frameDelta: number, playerPos: Vector3): void {
    this.elapsed += frameDelta;
    this.clock += frameDelta / DAY_LENGTH;
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

    // Precipitation. One weather system decides *whether* it is falling; how
    // cold it is decides what it falls as. Rain and snow are the same front seen
    // at two temperatures, so they share a source and split — which is also why
    // they can never both be at full strength, and why climbing through a shower
    // turns it to snow around you rather than starting a second storm.
    this.weather.update(frameDelta, this.elapsed, biome);
    const falling = this.weather.rain;
    const freezing = this.freezingAt(playerPos.y);
    this.rainAmount = falling * (1 - freezing);
    this.snowAmount = falling * freezing;

    // The ground remembering the rain. The read of `this.rainAmount` is the
    // published value rather than the local one on purpose (see the field).
    const rain = this.rainAmount;
    // Soaks about ten times faster than it dries.
    const soak = rain > this.wetness ? 0.5 : 0.045;
    this.wetness += (rain - this.wetness) * Math.min(1, frameDelta * soak);
    if (this.wetness < 0.002) this.wetness = 0;

    // Lying snow. Accumulates from the whole front, not from what happens to be
    // falling at the player's own altitude: the summits are above the freezing
    // line whatever the valley is doing, and it is the summits this is for. Where
    // it actually settles is the terrain shader's decision (see `Terrain`), which
    // reads this depth against each fragment's own height and slope — so one
    // scalar covers a whole mountain range without a texture or a second pass.
    const settling = falling * SNOW_SETTLE_RATE;
    // Melt is driven by the sun being up, not by the hour: an overcast noon melts
    // far less than a clear one, and the sun elevation already carries both.
    const thaw = Math.max(0, this.sunDir.y) * (1 - falling * 0.75) * SNOW_MELT_RATE;
    this.snowCover += (settling - thaw) * frameDelta;
    this.snowCover = Math.min(1, Math.max(0, this.snowCover));

    // A pin overrides the result rather than the inputs. Doing it here, at the end,
    // means everything above still runs and stays consistent — so releasing the pin
    // returns to a plausible state instead of one frozen from minutes ago.
    if (this.forced) {
      this.rainAmount = this.forced.rain;
      this.snowAmount = this.forced.snow;
      this.snowCover = this.forced.cover;
      if (this.forced.rain > this.wetness) this.wetness = this.forced.rain;
    }

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

    // Aurora. Most nights have none — which ones do, and how strong, is hashed
    // from the night index, so the answer is stable however the clock moves. Only
    // recomputed when the night turns over, which is also what keeps the strength
    // constant for the whole of one night.
    if (this.nightIndex !== this.scheduledNight) {
      this.scheduledNight = this.nightIndex;
      this.auroraStrength = auroraStrengthFor(this.scheduledNight);
    }
    if (this.auroraStrength <= 0 || this.nightFactor <= 0.02) {
      // A quiet night, or daylight. The field is told once that it is off, hides
      // itself, and is not touched again until a display night comes round — same
      // shape as the fireflies skipping themselves in daylight, and for the same
      // reason: no uniform writes and no draw call.
      if (this.auroraAmount > 0) this.aurora.update(playerPos, this.elapsed, 0);
      this.auroraAmount = 0;
    } else {
      // Ramped rather than switched. `nightFactor` already climbs over dusk and
      // falls over dawn, and putting a smoothstep on top of it means the display
      // starts after the stars are out and is gone before the sky pales — about
      // twenty seconds each way at this day length. The breathing on top keeps it
      // from ever being steady, so it reads as weather.
      const ramp = smoothStep(0.08, 0.75, this.nightFactor);
      const breathe = 0.72 + 0.28 * Math.sin(this.elapsed * 0.045);
      this.auroraAmount = this.auroraStrength * ramp * breathe;
      this.aurora.update(playerPos, this.elapsed, this.auroraAmount);
    }

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
    // Snow changes what the ground bounces back.
    //
    // The hemisphere light's lower colour is the world's own reflected light, and
    // it is a dark green because the world is a jungle. Snow is the most
    // reflective surface in the scene and it is not green, so leaving that term
    // alone lit every snowfield from below with green — which is most of why the
    // first working version still read as bleached grass rather than as snow, even
    // once the surface itself was white. Brighter as well as cooler, because snow
    // returns several times more light than soil does.
    const bounce = Math.min(1, this.snowCover * 0.9 + this.snowAmount * 0.3);
    if (bounce > 0.001) t.hemi.groundColor.lerp(SNOW_AIR, bounce * 0.8);
    t.hemi.intensity =
      (NIGHT.hemiIntensity + (DAY.hemiIntensity - NIGHT.hemiIntensity) * day - gold * 0.25) *
      // Snow returns several times more light than soil, so the ambient term rises
      // with it. Applied here rather than beside the colour above because this is
      // where the intensity is decided; multiplying it earlier would be overwritten.
      (1 + bounce * 0.22);

    blend(t.fog.color, NIGHT.fog, DAY.fog, GOLDEN.fog);
    // Canopy tint, applied as a multiply so it deepens rather than replaces.
    t.fog.color.multiply(this.scratch.setRGB(
      1 - (1 - this.fogTint.r) * 0.7,
      1 - (1 - this.fogTint.g) * 0.7,
      1 - (1 - this.fogTint.b) * 0.7,
    ));
    // Snow takes the colour out of the air.
    //
    // Without this the snow looked wrong for a reason that was nothing to do with
    // the snow: the daytime haze is a warm green-teal, tuned for a jungle, and it
    // is composited over everything in view. A white slope seen through it comes
    // out pale green, so the ground read as bleached grass rather than as snow
    // however white the surface itself was made.
    //
    // Driven by lying cover as well as by what is falling, because a clear day
    // over a snowfield has the same cold cast — light bouncing off snow is what
    // produces it, and that outlasts the front by hours. Fog density is lifted at
    // the same time: falling snow genuinely shortens the view, and it is the one
    // cheap way to hide the streaming edge during a storm.
    const chill = Math.min(1, this.snowAmount * 0.8 + this.snowCover * 0.55);
    if (chill > 0.001) {
      t.fog.color.lerp(SNOW_AIR, chill * 0.75);
    }

    const baseDensity =
      NIGHT.fogDensity + (DAY.fogDensity - NIGHT.fogDensity) * day + gold * 0.00035;
    t.fog.density = baseDensity * this.fogMultiplier * (1 + this.snowAmount * 0.85);

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
