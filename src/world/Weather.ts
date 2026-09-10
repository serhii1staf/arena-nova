import type { BiomeId } from './WorldGen.ts';

/**
 * Weather
 * -------
 * How hard it is raining, right now, where the player is standing.
 *
 * Owned by `DayNight` and sampled the same way the rest of the sky is: one
 * number per frame that every consumer reads, so the drops, the wet ground and
 * the puddles can never disagree about the weather.
 *
 * Two things drive it. A slow front rolling over the whole map, so rain arrives
 * and leaves on its own rather than being a switch; and a per-biome ceiling, so a
 * wetland is often soaked and a savanna almost never is. The front is built from
 * two mismatched sine waves instead of noise — over the minutes a session lasts
 * that is indistinguishable from weather, and it costs two `sin` calls a frame.
 *
 * Most of the range is deliberately dry. The front has to climb well into its
 * upper band before any rain falls at all, which is what makes a downpour feel
 * like an event instead of the default state of the world.
 */

/**
 * Ceiling on rain intensity per biome, before the front is applied.
 *
 * Kept separate from the fog and mist tables for the same reason those are
 * separate from each other: they answer different questions. Ground mist is
 * about cold air settling where you stand; this is about how much water the sky
 * over that biome carries. A snowfield is misty and barely rains; a jungle is
 * the reverse of a savanna.
 */
const RAIN_BY_BIOME: Record<BiomeId, number> = {
  wetland: 1,
  jungle: 0.95,
  ocean: 0.8,
  pine: 0.72,
  sakura: 0.52,
  meadow: 0.46,
  highland: 0.4,
  beach: 0.34,
  snow: 0.22,
  savanna: 0.06,
};

function smoothStep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class Weather {
  /** 0 = dry, 1 = downpour. Eased, so a squall builds instead of appearing. */
  rain = 0;

  /** Eased biome ceiling. Biome lookups snap to an 8 m lattice; this hides it. */
  private ceiling = RAIN_BY_BIOME.meadow;

  /**
   * Offset into the front. Zero by default, which starts every session dry and
   * lets the first shower build a little under a minute in — deterministic, so a
   * probe measuring the frame budget sees the same weather every run.
   */
  private readonly phase: number;

  constructor(phase = 0) {
    this.phase = phase;
  }

  update(dt: number, elapsed: number, biome: BiomeId): void {
    const k = Math.min(1, dt * 0.5);
    this.ceiling += ((RAIN_BY_BIOME[biome] ?? 0.4) - this.ceiling) * k;

    // Periods of roughly 300 s and 860 s. Neither divides the other, so wet
    // spells do not arrive on a schedule you can learn.
    const front =
      Math.sin(elapsed * 0.0209 + this.phase) * 0.62 +
      Math.sin(elapsed * 0.0073 + this.phase * 1.7) * 0.38;
    const target = smoothStep(0.18, 0.92, front) * this.ceiling;

    // Eased over a few seconds. Rain that snapped to full strength would betray
    // the sine underneath it, and the drop field has no fade of its own.
    this.rain += (target - this.rain) * Math.min(1, dt * 0.35);
    if (this.rain < 0.002) this.rain = 0;
  }
}
