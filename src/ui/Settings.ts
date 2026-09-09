import type { Engine } from '../core/Engine.ts';
import type { QualityTier } from '../core/QualityManager.ts';
import { setNativeFpsMode } from './native.ts';

/**
 * Frame pacing. `vsync` follows the display (smoothest); a number caps the
 * engine's own loop; `unlimited` removes the vsync ceiling entirely and needs a
 * restart, because it depends on browser-engine flags set at process start.
 */
export type FpsMode = 'vsync' | '60' | '120' | '144' | '240' | 'unlimited';

export interface GameSettings {
  quality: QualityTier;
  music: number; // 0..1
  sfx: number; // 0..1
  sensitivity: number; // multiplier, 1 = default
  fov: number; // degrees
  fpsMode: FpsMode;
}

const STORAGE_KEY = 'arena-nova.settings.v1';

const DEFAULTS: GameSettings = {
  quality: 'high',
  music: 0.5,
  sfx: 0.8,
  sensitivity: 1,
  fov: 68,
  // Follow the display by default: it is by far the smoothest option, and
  // rendering frames the monitor can't show only adds latency and heat.
  fpsMode: 'vsync',
};

/**
 * Persistent player settings. Values are applied straight to the live engine, so
 * changes take effect while the pause menu is open, and re-applied whenever a
 * new scene loads (each scene builds its own camera).
 */
export class SettingsStore {
  readonly values: GameSettings;
  private readonly engine: Engine;

  constructor(engine: Engine) {
    this.engine = engine;
    this.values = { ...DEFAULTS, ...SettingsStore.load() };
    // Default the quality tier to whatever the device probe chose, unless the
    // player has explicitly picked one before.
    if (!SettingsStore.load().quality) this.values.quality = engine.quality.tier;

    // Re-apply per-scene state (camera FOV) after every scene switch.
    engine.scenes.onChange(() => this.applyFov());
  }

  private static load(): Partial<GameSettings> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Partial<GameSettings>) : {};
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch {
      /* storage unavailable — settings simply won't persist */
    }
  }

  /** Push every value into the engine. Call once after construction. */
  applyAll(): void {
    this.setQuality(this.values.quality);
    this.setMusic(this.values.music);
    this.setSfx(this.values.sfx);
    this.setSensitivity(this.values.sensitivity);
    this.applyFpsMode();
    this.applyFov();
  }

  /**
   * Applies the frame-pacing choice. Numeric modes take effect immediately via
   * the engine's own limiter; `unlimited` only takes effect after a restart.
   * Returns true when a restart is needed.
   */
  setFpsMode(mode: FpsMode): boolean {
    this.values.fpsMode = mode;
    this.save();
    this.applyFpsMode();
    void setNativeFpsMode(mode === 'unlimited' ? 'unlimited' : 'vsync');
    return mode === 'unlimited';
  }

  private applyFpsMode(): void {
    const mode = this.values.fpsMode;
    // 'vsync' and 'unlimited' both leave the engine loop unthrottled; the
    // difference lives in the browser-engine flags chosen at startup.
    const limit = mode === 'vsync' || mode === 'unlimited' ? 0 : Number(mode);
    this.engine.setFpsLimit(limit);
  }

  setQuality(tier: QualityTier): void {
    this.values.quality = tier;
    this.engine.quality.setTier(tier);
    this.save();
  }

  setMusic(v: number): void {
    this.values.music = v;
    this.engine.audio.setMusicVolume(v);
    this.save();
  }

  setSfx(v: number): void {
    this.values.sfx = v;
    this.engine.audio.setSfxVolume(v);
    this.save();
  }

  setSensitivity(v: number): void {
    this.values.sensitivity = v;
    this.engine.input.lookSensitivityScale = v;
    this.save();
  }

  setFov(deg: number): void {
    this.values.fov = deg;
    this.applyFov();
    this.save();
  }

  private applyFov(): void {
    const cam = this.engine.scenes.current?.camera;
    if (!cam) return;
    cam.fov = this.values.fov;
    cam.updateProjectionMatrix();
  }
}
