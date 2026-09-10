import {
  ACESFilmicToneMapping,
  NoToneMapping,
  PCFShadowMap,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { GameConfig } from '../config.ts';
import { AssetManager } from './AssetManager.ts';
import { AudioManager } from './AudioManager.ts';
import type { EngineContext } from './context.ts';
import { Input } from './Input.ts';
import { QualityManager } from './QualityManager.ts';
import { SceneManager } from './SceneManager.ts';
import { PostFX } from '../rendering/PostFX.ts';

interface EngineOptions {
  container: HTMLElement;
  onStats?: (text: string) => void;
  /** Called when a scene switch fades out ('out') and after it completes ('in'). */
  onTransition?: (phase: 'out' | 'in') => void;
}

/** How long to hold the fade before swapping scenes (ms). */
const TRANSITION_FADE_MS = 280;

/**
 * Engine
 * ------
 * The beating heart: owns the renderer, the fixed-timestep loop, dynamic
 * resolution, and wires together quality / input / assets / scenes / post-fx.
 *
 * Loop model: logic runs at a fixed 60 Hz (deterministic, network-friendly);
 * rendering is decoupled and interpolated for smoothness at any refresh rate.
 */
export class Engine {
  readonly renderer: WebGLRenderer;
  readonly quality: QualityManager;
  readonly input: Input;
  readonly assets: AssetManager;
  readonly audio: AudioManager;
  readonly scenes: SceneManager;
  readonly postfx: PostFX;

  private readonly ctx: EngineContext;
  private readonly container: HTMLElement;
  private readonly onStats: ((text: string) => void) | undefined;
  private readonly onTransition: ((phase: 'out' | 'in') => void) | undefined;
  private fadeUntil = 0;

  private rafId = 0;
  /** Per-frame hooks for UI that follows live state (no event to listen for). */
  private readonly frameHandlers = new Set<() => void>();
  private running = false;
  private lastTime = 0;
  private accumulator = 0;
  private elapsed = 0;
  private statsTimer = 0;
  private pendingScene: string | null = null;
  private switching = false;

  private readonly onResize = (): void => this.resize();

  constructor(opts: EngineOptions) {
    this.container = opts.container;
    this.onStats = opts.onStats;
    this.onTransition = opts.onTransition;

    this.renderer = new WebGLRenderer({
      antialias: false, // SMAA handles AA in post; cheaper + plays nice with HDR.
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Tone mapping is performed once in PostFX (ACES). Keep renderer neutral,
    // but keep a sane fallback constant referenced so imports stay meaningful.
    this.renderer.toneMapping = NoToneMapping;
    void ACESFilmicToneMapping;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.info.autoReset = false;

    this.container.appendChild(this.renderer.domElement);

    this.quality = new QualityManager();
    this.assets = new AssetManager(this.renderer.capabilities.getMaxAnisotropy());
    this.input = new Input(this.renderer.domElement);
    this.audio = new AudioManager();
    this.scenes = new SceneManager();
    this.postfx = new PostFX(this.renderer);

    this.applyQuality();

    this.ctx = {
      renderer: this.renderer,
      quality: this.quality,
      input: this.input,
      assets: this.assets,
      audio: this.audio,
      width: 1,
      height: 1,
      requestScene: (name: string) => this.requestScene(name),
    };
    this.scenes.attach(this.ctx);

    // When the active scene changes, re-point post-processing at it.
    this.scenes.onChange((scene) => this.postfx.build(scene, this.quality.settings));
    // When the quality tier changes, reconfigure renderer + rebuild post-fx.
    this.quality.onChange(() => {
      this.applyQuality();
      if (this.scenes.current) this.postfx.build(this.scenes.current, this.quality.settings);
    });

    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
  }

  private applyQuality(): void {
    const s = this.quality.settings;
    this.renderer.shadowMap.enabled = s.shadowsEnabled;
    this.renderer.setPixelRatio(this.quality.effectivePixelRatio);
  }

  /** Register a scene factory under a name. */
  registerScene(name: string, factory: () => import('./context.ts').GameScene): this {
    this.scenes.register(name, factory);
    return this;
  }

  /**
   * Request a scene switch. The screen fades out first, so the (unavoidable)
   * world-build hitch happens while hidden and the teleport feels smooth.
   */
  requestScene(name: string): void {
    if (this.pendingScene === name || this.scenes.currentName === name) return;
    this.pendingScene = name;
    this.fadeUntil = performance.now() + TRANSITION_FADE_MS;
    this.onTransition?.('out');
  }

  async start(initialScene: string): Promise<void> {
    this.resize();
    await this.scenes.switchTo(initialScene);
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  /**
   * Optional frame-rate ceiling in milliseconds per frame (0 = no limit).
   * Useful to stop the GPU rendering frames the display can never show, which
   * only wastes power and adds input latency.
   */
  private targetFrameMs = 0;
  private lastRenderAt = 0;

  /** `fps` of 0 means "no in-engine limit" (display vsync still applies). */
  setFpsLimit(fps: number): void {
    this.targetFrameMs = fps > 0 ? 1000 / fps : 0;
    this.quality.setTargetFps(fps > 0 ? fps : this.displayHz);
  }

  /** Measured refresh rate of the display, used for quality thresholds. */
  private displayHz = 60;
  private hzSamples: number[] = [];

  private measureDisplayHz(frameDelta: number): void {
    if (this.hzSamples.length >= 90 || frameDelta <= 0) return;
    this.hzSamples.push(1 / frameDelta);
    if (this.hzSamples.length === 90) {
      // Median is robust against startup hitches.
      const sorted = [...this.hzSamples].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 60;
      // Snap to the nearest common refresh rate.
      const common = [60, 75, 90, 100, 120, 144, 165, 240, 360];
      this.displayHz =
        common.reduce((best, hz) => (Math.abs(hz - median) < Math.abs(best - median) ? hz : best), 60);
      if (this.targetFrameMs === 0) this.quality.setTargetFps(this.displayHz);
    }
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    // Frame limiter: bail out early without touching the clock, so the skipped
    // time is still accounted for on the next rendered frame.
    //
    // The slack matters: when the chosen cap equals the display refresh rate,
    // a strict comparison would occasionally reject a frame that arrived a
    // fraction early and cause a visible hitch, so allow a small margin.
    if (this.targetFrameMs > 0 && now - this.lastRenderAt < this.targetFrameMs - 1.5) return;
    this.lastRenderAt = now;

    // Apply a requested scene switch once the fade-out has covered the screen.
    if (this.switching) return;
    if (this.pendingScene && this.pendingScene !== this.scenes.currentName) {
      if (now < this.fadeUntil) {
        // Keep rendering the old scene behind the fade.
        this.renderCurrent(now);
        return;
      }
      const target = this.pendingScene;
      const previous = this.scenes.currentName;
      this.pendingScene = null;
      this.switching = true;
      void this.scenes
        .switchTo(target)
        .catch((err: unknown) => {
          // Never leave the player on a black screen: report and fall back.
          console.error(`[Engine] Failed to load scene "${target}":`, err);
          if (previous && previous !== target) {
            return this.scenes.switchTo(previous).catch(() => undefined);
          }
          return undefined;
        })
        .finally(() => {
          this.switching = false;
          this.lastTime = performance.now();
          this.accumulator = 0;
          // The new scene streams its surroundings in over the next couple of
          // seconds. Those frames time the loader, not the scene, so they are not
          // allowed to drive dynamic resolution — see `beginWarmup`.
          this.quality.beginWarmup();
          this.onTransition?.('in');
        });
      return;
    }

    let frameDelta = (now - this.lastTime) / 1000;
    this.lastTime = now;
    this.measureDisplayHz(frameDelta);
    if (frameDelta > GameConfig.maxFrameDelta) frameDelta = GameConfig.maxFrameDelta;

    const scene = this.scenes.current;
    if (!scene) return;

    // 1) Sample raw input (keyboard → movement vector) once per frame.
    this.input.update();

    // 2) Fixed-step logic (may run 0..n times per rendered frame).
    // The cap must cover a full clamped frame (maxFrameDelta / fixedStep = 6),
    // otherwise the simulation falls behind wall-clock and motion turns into
    // slow-motion on weak hardware. `maxFrameDelta` already prevents a death
    // spiral by discarding time beyond it.
    this.accumulator += frameDelta;
    let guard = 0;
    while (this.accumulator >= GameConfig.fixedStep && guard++ < 8) {
      scene.update(GameConfig.fixedStep, this.elapsed);
      this.elapsed += GameConfig.fixedStep;
      this.accumulator -= GameConfig.fixedStep;
    }

    // 3) Per-frame visual update (interpolation, look, animation).
    const alpha = this.accumulator / GameConfig.fixedStep;
    scene.render?.(alpha, frameDelta);

    // 4) Dynamic resolution: adjust pixel ratio when FPS drifts.
    if (this.quality.sampleFrame(frameDelta)) {
      this.renderer.setPixelRatio(this.quality.effectivePixelRatio);
      this.postfx.setSize(this.ctx.width, this.ctx.height);
    }

    // 4b) Overlays that follow live state rather than events.
    for (const h of this.frameHandlers) h();

    // 5) Render through the post-processing composer, matching its mood to the
    //    scene's own conditions first.
    this.postfx.setMood(this.scenes.current?.nightFactor ?? 0);
    this.renderer.info.reset();
    this.postfx.render(frameDelta);

    this.updateStats(frameDelta);
  };

  /**
   * Registers a hook that runs once per rendered frame, before the composer.
   *
   * For overlays whose input is live state rather than an event — held keys,
   * measured latency — where the alternative is polling on a timer and being
   * either late or wasteful.
   */
  onFrame(handler: () => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  /** Re-render the current scene without stepping simulation (used mid-fade). */
  private renderCurrent(now: number): void {
    if (!this.scenes.current) return;
    this.lastTime = now;
    this.renderer.info.reset();
    this.postfx.render(0);
  }

  /** Worst frame time seen since the last stats refresh (spike detector). */
  private worstFrameMs = 0;

  private updateStats(frameDelta: number): void {
    if (!this.onStats) return;
    this.worstFrameMs = Math.max(this.worstFrameMs, frameDelta * 1000);
    this.statsTimer += frameDelta;
    if (this.statsTimer < 0.5) return;
    this.statsTimer = 0;
    const info = this.renderer.info;
    const scale = Math.round(this.quality.currentResolutionScale * 100);
    // Average frame time hides stutter; the worst frame in the window exposes it,
    // which is what actually makes a high-FPS game feel bad.
    const avgMs = 1000 / Math.max(1, this.quality.fps);
    this.onStats(
      `${Math.round(this.quality.fps)} fps · ${avgMs.toFixed(1)} ms (peak ${this.worstFrameMs.toFixed(1)})\n` +
        `${this.quality.tier} · res ${scale}% · ${this.displayHz}Hz\n` +
        `draws ${info.render.calls} · tris ${(info.render.triangles / 1000).toFixed(0)}k`,
    );
    this.worstFrameMs = 0;
  }

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.ctx.width = w;
    this.ctx.height = h;

    this.renderer.setPixelRatio(this.quality.effectivePixelRatio);
    this.renderer.setSize(w, h, true);
    this.postfx.setSize(w, h);
    this.scenes.resize(w, h);
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    this.input.dispose();
    this.audio.dispose();
    this.scenes.dispose();
    this.postfx.dispose();
    this.assets.disposeAll();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
