import type { Engine } from '../core/Engine.ts';
import type { QualityTier } from '../core/QualityManager.ts';

export interface GameSettings {
  quality: QualityTier;
  music: number; // 0..1
  sfx: number; // 0..1
  sensitivity: number; // multiplier, 1 = default
  fov: number; // degrees
}

const STORAGE_KEY = 'arena-nova.settings.v1';

const DEFAULTS: GameSettings = {
  quality: 'high',
  music: 0.5,
  sfx: 0.8,
  sensitivity: 1,
  fov: 68,
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
    this.applyFov();
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
