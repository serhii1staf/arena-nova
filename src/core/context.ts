import type { Mesh, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import type { AssetManager } from './AssetManager.ts';
import type { AudioManager } from './AudioManager.ts';
import type { Input } from './Input.ts';
import type { QualityManager } from './QualityManager.ts';

/** Shared services handed to every scene. */
export interface EngineContext {
  renderer: WebGLRenderer;
  quality: QualityManager;
  input: Input;
  assets: AssetManager;
  /** Shared audio engine — survives scene switches so music never restarts. */
  audio: AudioManager;
  /** Current drawable size in CSS pixels. */
  width: number;
  height: number;
  /** Ask the engine to switch scenes (applied safely at the next frame start). */
  requestScene(name: string): void;
}

/**
 * A self-contained, disposable piece of the game (lobby, arena, menu…).
 * The engine drives its lifecycle and renders `scene` through `camera`.
 */
export interface GameScene {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;

  /**
   * Optional emissive mesh (e.g. the sun/window glow) used as the light source
   * for the screen-space god-rays effect. Null disables god rays for the scene.
   */
  readonly godRaysSource: Mesh | null;

  /**
   * How dark it is in this scene, 0..1. Read once per frame so post-processing can
   * close the vignette in and lift the glow after sunset. Scenes with no day cycle
   * leave it undefined and are treated as daylight.
   *
   * Declared here rather than handing scenes a reference to the post stack: a
   * scene should describe its own conditions, not reach into the renderer.
   */
  readonly nightFactor?: number;

  init(ctx: EngineContext): void | Promise<void>;
  /** Fixed-step logic update. `dt` is constant (GameConfig.fixedStep). */
  update(dt: number, elapsed: number): void;
  /** Per-frame visual update for smooth, framerate-independent animation. */
  render?(alpha: number, frameDelta: number): void;
  resize(width: number, height: number): void;
  dispose(): void;
}
