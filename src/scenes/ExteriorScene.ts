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
import { buildExterior, type AtmosphereState, type ExteriorBuild } from '../world/Exterior.ts';
import { buildDragon, type DragonBuild } from '../world/Dragon.ts';
import { DayNight } from '../world/DayNight.ts';
import { RemoteCrowd } from '../net/RemoteCrowd.ts';
import { ensureConnected, gameSession } from '../net/session.ts';
import { LocalPublisher } from '../net/publish.ts';

/**
 * ExteriorScene — the open world reached through the cathedral door: rolling
 * jungle hills, palms, rocks and water under a hazy sky. Walk back to the
 * doorway to return to the lobby.
 */
export class ExteriorScene implements GameScene {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  godRaysSource: Mesh | null = null;

  /** Drives the vignette and bloom after sunset. Read by the engine each frame. */
  get nightFactor(): number {
    return this.dayNight?.nightFactor ?? 0;
  }

  private world!: ExteriorBuild;
  private dragon!: DragonBuild;
  private player!: PlayerController;
  private character!: Avatar;
  private audio!: AudioManager;
  private ctx!: EngineContext;
  private sun!: DirectionalLight;
  private moon!: DirectionalLight;
  private hemi!: HemisphereLight;
  private dayNight!: DayNight;
  private fog!: FogExp2;
  private background!: Color;
  private crowd!: RemoteCrowd;
  private readonly net = gameSession();
  private readonly publisher = new LocalPublisher();
  /** Reused each frame; the world only reads it. */
  private readonly air: AtmosphereState = {
    nightFactor: 0,
    mist: 0,
    rain: 0,
    snow: 0,
    snowCover: 0,
    wetness: 0,
    air: new Color(0.68, 0.78, 0.76),
  };
  private time = 0;
  /** Which foot the next print belongs to, so a trail is a pair of tracks. */
  private leftFoot = false;
  private returning = false;
  /**
   * How far the shadow-casting lights sit from the player. A directional light's
   * shadow only covers a fixed box, so the rig travels with the player;
   * otherwise shadows would only exist near spawn.
   */
  private static readonly LIGHT_DISTANCE = 260;

  constructor() {
    // Far plane covers the streamed view distance plus the sky dome.
    this.camera = new PerspectiveCamera(GameConfig.camera.fov, 1, GameConfig.camera.near, 9000);
  }

  /** Exposed for the HUD/diagnostics. */
  worldStats(): { chunks: number; pending: number; biome: string; animals: number } {
    return this.world.stats();
  }

  async init(ctx: EngineContext): Promise<void> {
    this.ctx = ctx;
    this.audio = ctx.audio;
    const q = ctx.quality.settings;

    // Exponential haze stacks ridges into the horizon and hides the streaming
    // edge. Thin enough that distant mountains stay visible, which is what makes
    // the world read as large.
    this.background = new Color(0.62, 0.75, 0.78);
    this.fog = new FogExp2(new Color(0.68, 0.78, 0.76), 0.00085);
    this.scene.background = this.background;
    this.scene.fog = this.fog;

    this.world = buildExterior(ctx.assets, q);
    this.scene.add(this.world.group);
    // Build the ground and nearby props before the player can move, so nobody
    // ever falls through a chunk that hasn't streamed in yet.
    this.world.prime();

    // A dragon patrolling the sky over the island.
    this.dragon = buildDragon(new Vector3(0, 0, 40), 240, 90);
    this.scene.add(this.dragon.group);

    // Lighting rig. Colours and intensities are owned by the day/night cycle;
    // the values here just get the objects into the scene with the right shape.
    const hemi = new HemisphereLight(new Color(0.8, 0.9, 0.85), new Color(0.25, 0.3, 0.2), 1.4);
    this.scene.add(hemi);
    this.hemi = hemi;

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

    // Fill from the opposite side. It carries moonlight after dark, which keeps
    // night readable without paying for a second shadow map. Added here, before
    // the shader warm-up, so the scene's light count never changes during play.
    const moon = new DirectionalLight(new Color(0.5, 0.62, 0.95), 0);
    this.scene.add(moon.target);
    this.scene.add(moon);
    this.moon = moon;

    this.dayNight = new DayNight();
    this.scene.add(this.dayNight.group);
    // Crepuscular rays through the treeline. The effect was already configured
    // and switched on for the high and ultra tiers, but nothing outdoors ever
    // named a source mesh, so it did nothing here.
    this.godRaysSource = this.dayNight.sunMesh;

    this.player = new PlayerController(this.camera, ctx.input, {
      collide: (p) => this.world.collide(p),
      floorHeightAt: (x, z) => this.world.floorHeightAt(x, z),
      blocksCamera: (x, y, z) => this.world.blocksCamera(x, y, z),
    });
    this.player.spawn(this.world.spawn.x, this.world.spawn.z, this.world.spawn.yaw);

    this.character = new Avatar();
    this.character.object.visible = false;
    this.scene.add(this.character.object);

    // Other players. The session is shared with the lobby, so walking through the
    // portal keeps you in the same room instead of reconnecting.
    this.crowd = new RemoteCrowd(this.net, GameConfig.player.sprintSpeed);
    this.scene.add(this.crowd.group);
    ensureConnected();

    // Compile every program now, while the transition is still faded out.
    // Otherwise the first frame in the open world has to compile the terrain, the
    // wind-injected vegetation programs, the ember, portal, dragon, wildlife and
    // particle shaders all at once — which is a large part of why stepping through
    // the portal used to drop the frame rate off a cliff.
    //
    // Synchronous `compile`, not `compileAsync`. The async version polls material
    // readiness through `KHR_parallel_shader_compile`, and on a driver without
    // that extension it throws from inside its own polling callback — which is
    // outside the promise, so the await never settles and the scene never
    // finishes initialising. The game would sit on the transition fade forever.
    try {
      ctx.renderer.compile(this.scene, this.camera);
    } catch {
      // Warm-up is an optimisation; never let it stop the scene from opening.
    }
  }

  update(dt: number): void {
    this.player.update(dt);
    const f = this.player.feetPosition;
    if (!this.returning && this.world.isAtPortal(f.x, f.y + 1, f.z)) {
      this.returning = true;
      this.ctx.requestScene('lobby');
    }

    this.publisher.step(this.net, this.player, dt);
    this.net.update();
  }

  render(alpha: number, frameDelta: number): void {
    this.time += frameDelta;
    this.player.render(alpha, frameDelta);

    // Hidden in first person, but still driven: the avatar owns its animation
    // mixer and its character-change effect, and skipping the call left both
    // frozen — a skin change requested from a first-person view never completed
    // and its particle cloud was never released.
    this.character.object.visible = this.player.thirdPerson;
    this.character.update(
      this.player.renderPosition,
      this.player.viewYaw,
      {
        speed01: this.player.speed01,
        grounded: this.player.isGrounded,
        phase: this.player.animPhase,
        vy: this.player.verticalSpeed,
      },
      frameDelta,
    );

    if (this.player.consumeFootstep()) {
      this.audio.footstep(this.player.speed01);
      // Stamped from the same flag that plays the sound, so a print appears exactly
      // when a foot lands rather than on a timer that drifts against the stride.
      // Offset to the side the foot actually falls on, alternating, or a run leaves
      // one central furrow instead of a pair of tracks.
      const f = this.player.feetPosition;
      this.leftFoot = !this.leftFoot;
      const side = this.leftFoot ? -0.16 : 0.16;
      const yaw = this.player.viewYaw;
      this.world.markSnow(f.x + Math.cos(yaw) * side, f.z - Math.sin(yaw) * side);
    }
    if (this.player.consumeJumped()) this.audio.jump();
    if (this.player.consumeLanded()) this.audio.land();

    const p = this.player.renderPosition;

    // Advance the clock, then place the lighting rig along the new sun/moon
    // directions and push the palette into the lights, fog and sky.
    this.dayNight.update(frameDelta, p);
    const d = ExteriorScene.LIGHT_DISTANCE;
    this.sun.position.copy(p).addScaledVector(this.dayNight.sunDir, d);
    this.sun.target.position.set(p.x, p.y, p.z);
    this.sun.target.updateMatrixWorld();
    this.moon.position.copy(p).addScaledVector(this.dayNight.moonDir, d);
    this.moon.target.position.set(p.x, p.y, p.z);
    this.moon.target.updateMatrixWorld();
    this.dayNight.applyTo({
      sun: this.sun,
      moon: this.moon,
      hemi: this.hemi,
      fog: this.fog,
      background: this.background,
      skyMaterial: this.world.skyMaterial,
    });

    this.crowd.update(frameDelta);
    // The fog colour is read back out after `applyTo` wrote it, so mist and motes
    // take the colour of the air rather than carrying a palette of their own.
    this.air.nightFactor = this.dayNight.nightFactor;
    this.air.mist = this.dayNight.mistAmount;
    this.air.rain = this.dayNight.rainAmount;
    this.air.snow = this.dayNight.snowAmount;
    this.air.snowCover = this.dayNight.snowCover;
    this.air.wetness = this.dayNight.wetness;
    this.air.air.copy(this.fog.color);
    this.world.update(this.time, frameDelta, p, this.air);
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
    this.crowd?.dispose();
    this.character?.dispose();
    this.dragon?.dispose();
    this.dayNight?.dispose();
    this.world?.dispose();
  }
}



