import { HalfFloatType, type WebGLRenderer } from 'three';
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  GodRaysEffect,
  KernelSize,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import type { GameScene } from '../core/context.ts';
import type { QualitySettings } from '../core/QualityManager.ts';

/**
 * PostFX
 * ------
 * Owns the HDR post-processing stack. Pipeline (in linear HDR, tonemapped last):
 *
 *   RenderPass → [GodRays] → [Bloom → ACES ToneMapping → Vignette] → [SMAA]
 *
 * The composer is rebuilt whenever the scene or quality tier changes; dynamic
 * resolution only calls `setSize` (cheap). Renderer tone mapping is disabled so
 * ACES happens exactly once here.
 */
export class PostFX {
  composer: EffectComposer;
  private readonly renderer: WebGLRenderer;
  private width = 1;
  private height = 1;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    this.composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType });
  }

  build(scene: GameScene, q: QualitySettings): void {
    // Fully rebuild: recreate the composer so all render targets are fresh.
    this.composer.dispose();
    this.composer = new EffectComposer(this.renderer, { frameBufferType: HalfFloatType });

    this.composer.addPass(new RenderPass(scene.scene, scene.camera));

    if (q.godRays && scene.godRaysSource) {
      const godRays = new GodRaysEffect(scene.camera, scene.godRaysSource, {
        density: 0.92,
        decay: 0.9,
        weight: 0.4,
        exposure: 0.45,
        samples: 60,
        clampMax: 0.9,
        blur: true,
        kernelSize: KernelSize.SMALL,
        resolutionScale: 0.6,
      });
      this.composer.addPass(new EffectPass(scene.camera, godRays));
    }

    const bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 0.72,
      luminanceSmoothing: 0.28,
      intensity: q.bloom ? 0.95 : 0,
      radius: 0.7,
      levels: 8,
    });

    const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });

    const vignette = new VignetteEffect({ offset: 0.34, darkness: 0.62 });

    this.composer.addPass(new EffectPass(scene.camera, bloom, toneMapping, vignette));

    if (q.smaa) {
      const smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });
      this.composer.addPass(new EffectPass(scene.camera, smaa));
    }

    this.composer.setSize(this.width, this.height);
  }

  /** `width`/`height` are CSS pixels; the composer applies the renderer's
   *  pixel ratio internally, so dynamic resolution works by adjusting that. */
  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.composer.setSize(this.width, this.height);
  }

  render(deltaTime: number): void {
    this.composer.render(deltaTime);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
