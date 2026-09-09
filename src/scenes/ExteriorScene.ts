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
import { Avatar } from '../player/Avatar.ts';
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
  private character!: Avatar;
  private audio!: AudioManager;
  private ctx!: EngineContext;
  private sun!: DirectionalLight;
  private time = 0;
  private returning = false;
  /** Offset of the sun from the player, kept constant so shadows follow. */
  private readonly sunOffset = new Vector3(120, 200, 90);

  constructor() {
    // Far plane covers the streamed view distance plus the sky dome.
    this.camera = new PerspectiveCamera(GameConfig.camera.fov, 1, GameConfig.camera.near, 9000);
  }

  /** Exposed for the HUD/diagnostics. */
  worldStats(): { chunks: number; pending: number; biome: string } {
    return this.world.stats();
  }

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.audio = ctx.audio;
    const q = ctx.quality.settings;

    // Exponential haze stacks ridges into the horizon and hides the streaming
    // edge. Thin enough that distant mountains stay visible, which is what makes
    // the world read as large.
    this.scene.background = new Color(0.62, 0.75, 0.78);
    this.scene.fog = new FogExp2(new Color(0.68, 0.78, 0.76), 0.00085);

    this.world = buildExterior(ctx.assets, q);
    this.scene.add(this.world.group);
    // Build the ground and nearby props before the player can move, so nobody
    // ever falls through a chunk that hasn't streamed in yet.
    this.world.prime();

    // A dragon patrolling the sky over the island.
    this.dragon = buildDragon(new Vector3(0, 0, 40), 240, 90);
    this.scene.add(this.dragon.group);

    // Bright outdoor lighting.
    const hemi = new HemisphereLight(new Color(0.8, 0.9, 0.85), new Color(0.25, 0.3, 0.2), 1.4);
    this.scene.add(hemi);
    const sun = new DirectionalLight(new Color(1.0, 0.98, 0.88), 3.4);
    sun.position.set(120, 200, 90);
    this.scene.add(sun.target);
    this.sun = sun;
    if (q.shadowsEnabled) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      const c = sun.shadow.camera;
      c.near = 1;
      c.far = 420;
      c.left = -120;
      c.right = 120;
      c.top = 120;
      c.bottom = -120;
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

    this.character = new Avatar();
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

    // A directional light's shadow only covers a fixed box, so move the whole
    // rig with the player — otherwise shadows would exist near spawn only.
    const p = this.player.renderPosition;
    this.sun.position.copy(p).add(this.sunOffset);
    this.sun.target.position.set(p.x, p.y, p.z);
    this.sun.target.updateMatrixWorld();

    this.world.update(this.time, frameDelta, p);
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



