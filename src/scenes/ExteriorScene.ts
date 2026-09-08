import {
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  type Mesh,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import { GameConfig } from '../config.ts';
import type { EngineContext, GameScene } from '../core/context.ts';
import type { AudioManager } from '../core/AudioManager.ts';
import { PlayerController } from '../player/PlayerController.ts';
import { CharacterModel } from '../player/CharacterModel.ts';
import { buildExterior, type ExteriorBuild } from '../world/Exterior.ts';
import { buildDragon, type DragonBuild } from '../world/Dragon.ts';

/**
 * ExteriorScene — the open world reached through the cathedral door: rolling
 * jungle hills, palms, rocks and water under a hazy sky. Walk back to the
 * doorway to return to the lobby.
 */
export class ExteriorScene implements GameScene {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  godRaysSource: Mesh | null = null;

  private world!: ExteriorBuild;
  private dragon!: DragonBuild;
  private player!: PlayerController;
  private character!: CharacterModel;
  private audio!: AudioManager;
  private ctx!: EngineContext;
  private time = 0;
  private returning = false;

  constructor() {
    this.camera = new PerspectiveCamera(GameConfig.camera.fov, 1, GameConfig.camera.near, 600);
  }

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.audio = ctx.audio;
    const q = ctx.quality.settings;

    // Exponential haze: it thickens smoothly with distance, so ridges stack into
    // the horizon and the island keeps its atmosphere while still reading big.
    // (A hard linear near/far cutoff looked flat and killed the depth.)
    this.scene.background = new Color(0.62, 0.75, 0.78);
    this.scene.fog = new FogExp2(new Color(0.68, 0.78, 0.76), 0.0034);

    this.world = buildExterior(ctx.assets, q);
    this.scene.add(this.world.group);

    // A dragon patrolling the sky over the island.
    this.dragon = buildDragon(new Vector3(0, 0, 40), 150, 62);
    this.scene.add(this.dragon.group);

    // Bright outdoor lighting.
    const hemi = new HemisphereLight(new Color(0.8, 0.9, 0.85), new Color(0.25, 0.3, 0.2), 1.4);
    this.scene.add(hemi);
    const sun = new DirectionalLight(new Color(1.0, 0.98, 0.88), 3.4);
    sun.position.set(40, 70, 30);
    sun.target.position.set(0, 0, 30);
    this.scene.add(sun.target);
    if (q.shadowsEnabled) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      const c = sun.shadow.camera;
      c.near = 1;
      c.far = 240;
      c.left = -70;
      c.right = 70;
      c.top = 70;
      c.bottom = -70;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.04;
    }
    this.scene.add(sun);

    this.player = new PlayerController(this.camera, ctx.input, {
      collide: (p) => this.world.collide(p),
      floorHeightAt: (x, z) => this.world.floorHeightAt(x, z),
      blocksCamera: (x, y, z) => this.world.blocksCamera(x, y, z),
    });
    this.player.spawn(this.world.spawn.x, this.world.spawn.z, this.world.spawn.yaw);

    this.character = new CharacterModel();
    this.character.object.visible = false;
    this.scene.add(this.character.object);
  }

  update(dt: number): void {
    this.player.update(dt);
    const f = this.player.feetPosition;
    if (!this.returning && this.world.isAtPortal(f.x, f.y + 1, f.z)) {
      this.returning = true;
      this.ctx.requestScene('lobby');
    }
  }

  render(alpha: number, frameDelta: number): void {
    this.time += frameDelta;
    this.player.render(alpha, frameDelta);

    this.character.object.visible = this.player.thirdPerson;
    if (this.player.thirdPerson) {
      this.character.update(
        this.player.renderPosition,
        this.player.viewYaw,
        { speed01: this.player.speed01, grounded: this.player.isGrounded, phase: this.player.animPhase },
        frameDelta,
      );
    }

    if (this.player.consumeFootstep()) this.audio.footstep(this.player.speed01);
    if (this.player.consumeJumped()) this.audio.jump();
    if (this.player.consumeLanded()) this.audio.land();

    this.world.update(this.time);
    this.dragon.update(this.time, frameDelta);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /** Debug/menu hook: set the third-person camera distance. */
  setCameraZoom(distance: number): void {
    this.player.setZoom(distance);
  }

  dispose(): void {
    this.character?.dispose();
    this.dragon?.dispose();
    this.world?.dispose();
  }
}



