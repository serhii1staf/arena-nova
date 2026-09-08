/**
 * QualityManager
 * --------------
 * Detects the device capability tier on startup and then keeps frame-time under
 * control at runtime via dynamic resolution scaling. This is the backbone of the
 * "runs smoothly everywhere" requirement — from a phone browser to a desktop GPU.
 */

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  /** Hard cap on devicePixelRatio (before dynamic scaling). */
  pixelRatioCap: number;
  shadowsEnabled: boolean;
  shadowMapSize: number;
  /** Screen-space effects. */
  bloom: boolean;
  godRays: boolean;
  smaa: boolean;
  /** Multiplier applied to instanced vegetation counts. */
  vegetationDensity: number;
  /** Floating dust/pollen particle count. */
  particleCount: number;
  /** Fog far distance / effective draw distance. */
  drawDistance: number;
  /** Texture anisotropy. */
  anisotropy: number;
}

const PRESETS: Record<QualityTier, QualitySettings> = {
  low: {
    pixelRatioCap: 1,
    shadowsEnabled: false,
    shadowMapSize: 1024,
    bloom: true,
    godRays: false,
    smaa: false,
    vegetationDensity: 0.35,
    particleCount: 500,
    drawDistance: 140,
    anisotropy: 1,
  },
  medium: {
    pixelRatioCap: 1.25,
    shadowsEnabled: true,
    shadowMapSize: 1536,
    bloom: true,
    godRays: false,
    smaa: true,
    vegetationDensity: 0.6,
    particleCount: 1200,
    drawDistance: 200,
    anisotropy: 4,
  },
  high: {
    pixelRatioCap: 1.75,
    shadowsEnabled: true,
    shadowMapSize: 2048,
    bloom: true,
    godRays: true,
    smaa: true,
    vegetationDensity: 1,
    particleCount: 2600,
    drawDistance: 280,
    anisotropy: 8,
  },
  ultra: {
    pixelRatioCap: 2,
    shadowsEnabled: true,
    shadowMapSize: 4096,
    bloom: true,
    godRays: true,
    smaa: true,
    vegetationDensity: 1.5,
    particleCount: 4200,
    drawDistance: 360,
    anisotropy: 16,
  },
};

type ChangeListener = (settings: QualitySettings, tier: QualityTier) => void;

export class QualityManager {
  tier: QualityTier;
  settings: QualitySettings;

  /** Dynamic resolution multiplier (0.5 .. 1.0), driven by measured FPS. */
  private resolutionScale = 1;
  private targetResolutionScale = 1;

  private readonly listeners = new Set<ChangeListener>();

  // Rolling FPS estimate.
  private fpsEMA = 60;
  private adaptCooldown = 0;

  constructor(tier?: QualityTier) {
    this.tier = tier ?? QualityManager.detectTier();
    this.settings = { ...PRESETS[this.tier] };
  }

  /** Best-effort GPU/device tier detection. Conservative on mobile. */
  static detectTier(): QualityTier {
    if (typeof navigator === 'undefined') return 'high';

    const ua = navigator.userAgent || '';
    const isMobile = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua);
    const cores = navigator.hardwareConcurrency ?? 4;
    // deviceMemory is Chromium-only; treat missing as "unknown/decent".
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;

    const gpu = QualityManager.readGPUString().toLowerCase();
    const weakGPU = /(mali|adreno 5|adreno 6[0-2]|powervr|intel.*(hd|uhd) graphics)/.test(gpu);
    const strongGPU = /(rtx|radeon rx|apple m[1-9]|adreno 7|adreno 8)/.test(gpu);

    if (isMobile) {
      if (strongGPU && cores >= 6) return 'high';
      if (weakGPU || cores <= 4 || mem <= 3) return 'low';
      return 'medium';
    }

    if (strongGPU && cores >= 8 && mem >= 8) return 'ultra';
    if (weakGPU || cores <= 4 || mem <= 4) return 'medium';
    return 'high';
  }

  /** Reads the unmasked GPU renderer name if the extension is available. */
  private static readGPUString(): string {
    try {
      const canvas = document.createElement('canvas');
      const gl =
        canvas.getContext('webgl2') ??
        (canvas.getContext('webgl') as WebGLRenderingContext | null);
      if (!gl) return '';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (!dbg) return '';
      return String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '');
    } catch {
      return '';
    }
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Manually set a tier (e.g. from a settings menu). */
  setTier(tier: QualityTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.settings = { ...PRESETS[tier] };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.settings, this.tier);
  }

  /** The pixel ratio the renderer should actually use this frame. */
  get effectivePixelRatio(): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    return Math.min(dpr, this.settings.pixelRatioCap) * this.resolutionScale;
  }

  get currentResolutionScale(): number {
    return this.resolutionScale;
  }

  /**
   * Feed the measured frame delta. Returns true when the effective resolution
   * changed enough that the caller should resize the renderer/composer.
   */
  sampleFrame(dt: number): boolean {
    if (dt <= 0) return false;
    const instFps = 1 / dt;
    // Exponential moving average smooths out spikes.
    this.fpsEMA += (instFps - this.fpsEMA) * 0.05;

    this.adaptCooldown -= dt;
    if (this.adaptCooldown <= 0) {
      this.adaptCooldown = 0.5;
      if (this.fpsEMA < 45) {
        this.targetResolutionScale = Math.max(0.55, this.targetResolutionScale - 0.1);
      } else if (this.fpsEMA > 58 && this.targetResolutionScale < 1) {
        this.targetResolutionScale = Math.min(1, this.targetResolutionScale + 0.05);
      }
    }

    // Ease toward the target to avoid visible resolution "pops".
    const prev = this.resolutionScale;
    this.resolutionScale += (this.targetResolutionScale - this.resolutionScale) * 0.1;
    if (Math.abs(this.resolutionScale - this.targetResolutionScale) < 0.005) {
      this.resolutionScale = this.targetResolutionScale;
    }
    return Math.abs(this.resolutionScale - prev) > 0.01;
  }

  get fps(): number {
    return this.fpsEMA;
  }
}
