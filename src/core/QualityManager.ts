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

/** Dynamic resolution moves in fixed steps so it can't thrash the render targets. */
const RESOLUTION_STEP = 0.1;
/** Minimum seconds between two resolution changes. */
const RESIZE_COOLDOWN = 1.5;

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
  private resizeCooldown = 0;

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
   * Target frame rate used to judge whether we have headroom. Defaults to a
   * 60 Hz budget and is updated once the real display rate is measured, so the
   * thresholds stay meaningful on 144 Hz and 240 Hz screens.
   */
  private targetFps = 60;

  setTargetFps(fps: number): void {
    this.targetFps = Math.max(30, Math.min(1000, fps));
  }

  /** Seconds of frame samples still to be ignored before adapting again. */
  private warmup = 0;

  /**
   * Ignore frame timing for a moment, and forget what was measured before it.
   *
   * Called when the world is rebuilt from scratch. A scene switch is followed by a
   * couple of seconds of streaming backlog whose frame times describe the loader,
   * not the scene — and adapting to them is worse than useless: resolution walks
   * down in steps while the hitching lasts, every step reallocating the whole post
   * chain (which is itself a hitch), and because the average is a slow EMA the
   * world then stays soft long after streaming has settled. Measured leaving the
   * lobby: resolution fell to 0.7 and was still there fifteen seconds later.
   *
   * This only defers the decision. Once the window passes, a scene that genuinely
   * cannot hold the frame rate is adapted to exactly as before.
   */
  beginWarmup(seconds = 2.5): void {
    this.warmup = Math.max(this.warmup, seconds);
    // The EMA is reset rather than left to decay, so the frames recorded during the
    // hitch are not still dragging the average once adaptation resumes.
    this.fpsEMA = this.targetFps;
    this.adaptCooldown = Math.max(this.adaptCooldown, seconds);
  }

  /** Resolution scale rounded to a discrete step (see `sampleFrame`). */
  private quantise(v: number): number {
    return Math.round(v / RESOLUTION_STEP) * RESOLUTION_STEP;
  }

  /**
   * Feed the measured frame delta. Returns true only when the renderer actually
   * needs resizing.
   *
   * Resizing is *expensive*: it reallocates the whole post-processing chain
   * (HDR buffers, bloom mip pyramid, SMAA textures). Reporting a change on every
   * frame of a smooth ease therefore caused constant reallocation and visible
   * stutter — the higher the frame rate, the worse it got. So the scale is
   * quantised to discrete steps and guarded by a cooldown: at most one resize
   * per `RESIZE_COOLDOWN`, and only when the step genuinely changes.
   */
  sampleFrame(dt: number): boolean {
    if (dt <= 0) return false;

    // A warm-up window discards the sample outright rather than feeding it to the
    // EMA, because feeding it and merely postponing the decision would leave the
    // average poisoned by exactly the frames that are not representative.
    if (this.warmup > 0) {
      this.warmup -= dt;
      this.resizeCooldown -= dt;
      return false;
    }

    const instFps = 1 / dt;
    this.fpsEMA += (instFps - this.fpsEMA) * 0.05;

    this.resizeCooldown -= dt;
    this.adaptCooldown -= dt;

    if (this.adaptCooldown <= 0) {
      this.adaptCooldown = 0.75;
      // Judge against the actual target, not a hardcoded 60.
      const low = this.targetFps * 0.72;
      const high = this.targetFps * 0.92;
      if (this.fpsEMA < low) {
        this.targetResolutionScale = Math.max(0.55, this.targetResolutionScale - RESOLUTION_STEP);
      } else if (this.fpsEMA > high && this.targetResolutionScale < 1) {
        this.targetResolutionScale = Math.min(1, this.targetResolutionScale + RESOLUTION_STEP);
      }
    }

    const wanted = this.quantise(this.targetResolutionScale);
    if (wanted === this.quantise(this.resolutionScale)) return false;
    if (this.resizeCooldown > 0) return false;

    this.resolutionScale = wanted;
    this.resizeCooldown = RESIZE_COOLDOWN;
    return true;
  }

  get fps(): number {
    return this.fpsEMA;
  }
}
