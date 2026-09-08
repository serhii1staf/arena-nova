import type { EngineContext, GameScene } from './context.ts';

export type SceneFactory = () => GameScene;
type SceneChangeListener = (scene: GameScene) => void;

/**
 * SceneManager
 * ------------
 * Registers named scene factories and swaps between them, guaranteeing the old
 * scene is fully disposed before the new one initialises. The engine listens
 * for changes to re-point post-processing at the new scene/camera.
 */
export class SceneManager {
  private readonly factories = new Map<string, SceneFactory>();
  private readonly listeners = new Set<SceneChangeListener>();
  private ctx: EngineContext | null = null;

  current: GameScene | null = null;
  currentName = '';

  register(name: string, factory: SceneFactory): this {
    this.factories.set(name, factory);
    return this;
  }

  attach(ctx: EngineContext): void {
    this.ctx = ctx;
  }

  onChange(listener: SceneChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async switchTo(name: string): Promise<GameScene> {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Scene "${name}" is not registered`);
    if (!this.ctx) throw new Error('SceneManager.attach(ctx) must be called first');

    if (this.current) {
      this.current.dispose();
      this.current = null;
    }

    const scene = factory();
    await scene.init(this.ctx);
    scene.resize(this.ctx.width, this.ctx.height);

    this.current = scene;
    this.currentName = name;
    for (const l of this.listeners) l(scene);
    return scene;
  }

  resize(width: number, height: number): void {
    this.current?.resize(width, height);
  }

  dispose(): void {
    this.current?.dispose();
    this.current = null;
    this.listeners.clear();
  }
}
