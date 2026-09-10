import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  PointLight,
  Scene,
  Vector3,
} from 'three';
import { GameConfig } from '../config.ts';
import type { EngineContext, GameScene } from '../core/context.ts';
import type { AudioManager } from '../core/AudioManager.ts';
import { PlayerController } from '../player/PlayerController.ts';
import { Avatar } from '../player/Avatar.ts';
import { RemoteCrowd } from '../net/RemoteCrowd.ts';
import { ensureConnected, gameSession } from '../net/session.ts';
import { LocalPublisher } from '../net/publish.ts';
import { buildCathedral, LAYOUT, type CathedralBuild } from '../world/Cathedral.ts';
import { buildVegetation, type VegetationBuild } from '../world/Vegetation.ts';
import { buildAtmosphere, type AtmosphereBuild } from '../world/Atmosphere.ts';
import { buildPortal, type PortalBuild } from '../world/Portal.ts';

/**
 * LobbyScene — the overgrown sanctuary. Assembles the procedural cathedral,
 * vegetation and atmosphere, lights it for the hazy green mood from the
 * reference art, drives the first-person player, and is already wired to the
 * (offline-by-default) network layer for future online play.
 */
export class LobbyScene implements GameScene {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  godRaysSource: Mesh | null = null;

  private cathedral!: CathedralBuild;
  private vegetation!: VegetationBuild;
  private atmosphere!: AtmosphereBuild;
  private portal!: PortalBuild;
  private player!: PlayerController;
  private character!: Avatar;
  private audio!: AudioManager;
  private readonly net = gameSession();
  private crowd!: RemoteCrowd;


  private time = 0;
  private readonly publisher = new LocalPublisher();
  private unsub: Array<() => void> = [];
  private ctx!: EngineContext;
  private exiting = false;

  constructor() {
    this.camera = new PerspectiveCamera(
      GameConfig.camera.fov,
      1,
      GameConfig.camera.near,
      GameConfig.camera.far,
    );
  }

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.audio = ctx.audio;
    const q = ctx.quality.settings;

    // --- Mood: background + distance fog -----------------------------------
    this.scene.background = new Color(0.16, 0.22, 0.15);
    this.scene.fog = new Fog(new Color(0.34, 0.44, 0.3), q.drawDistance * 0.12, q.drawDistance);

    // --- World -------------------------------------------------------------
    this.cathedral = buildCathedral(ctx.assets);
    this.scene.add(this.cathedral.group);
    this.godRaysSource = this.cathedral.sunMesh;

    this.vegetation = buildVegetation(ctx.assets, q);
    this.scene.add(this.vegetation.group);

    this.atmosphere = buildAtmosphere(q, ctx.assets);
    this.scene.add(this.atmosphere.group);

    // The way out: a portal filling the entrance doorway.
    this.portal = buildPortal({
      position: new Vector3(0, 3.1, LAYOUT.entranceZ - 0.7),
      width: 3.9,
      height: 5.8,
      facing: 0,
      withBacking: true, // seals the doorway so you can't see past the vortex
    });
    this.scene.add(this.portal.group);


    // --- Lighting ----------------------------------------------------------
    const hemi = new HemisphereLight(new Color(0.7, 0.85, 0.6), new Color(0.12, 0.16, 0.1), 1.1);
    this.scene.add(hemi);

    const sun = new DirectionalLight(new Color(0.95, 1.0, 0.82), 3.1);
    sun.position.set(3, 22, LAYOUT.apseZ - 2);
    sun.target.position.set(0, 3, 6);
    this.scene.add(sun.target);
    if (q.shadowsEnabled) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      const cam = sun.shadow.camera;
      cam.near = 1;
      cam.far = 90;
      cam.left = -22;
      cam.right = 22;
      cam.top = 34;
      cam.bottom = -34;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.03;
    }
    this.scene.add(sun);

    // Warm fill glowing out of the apse window.
    const glow = new PointLight(new Color(0.8, 1.0, 0.7), 90, 60, 2);
    glow.position.set(0, 9, LAYOUT.apseZ + 3);
    this.scene.add(glow);

    // --- Player ------------------------------------------------------------
    this.player = new PlayerController(this.camera, ctx.input, {
      collide: (p) => this.cathedral.collide(p),
      floorHeightAt: (x, z) => this.cathedral.floorHeightAt(x, z),
      blocksCamera: (x, y, z) => this.cathedral.blocksCamera(x, y, z),
    });
    this.player.spawn(0, LAYOUT.entranceZ - 4, 0);

    // Third-person avatar (hidden in first person).
    this.character = new Avatar();
    this.character.object.visible = false;
    this.scene.add(this.character.object);

    // --- Network -----------------------------------------------------------
    // The session is shared with every other scene, so walking through the portal
    // no longer drops you out of the room.
    this.crowd = new RemoteCrowd(this.net, GameConfig.player.sprintSpeed);
    this.scene.add(this.crowd.group);
    ensureConnected();
  }

  update(dt: number): void {
    this.player.update(dt);

    // Step into the portal → open world.
    const f = this.player.feetPosition;
    if (!this.exiting && this.portal.contains(f.x, f.y + 1, f.z)) {
      this.exiting = true;
      this.ctx.requestScene('exterior');
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
    this.character.scaleBody(this.player.bodyScale);
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

    // Procedural sound effects.
    if (this.player.consumeFootstep()) this.audio.footstep(this.player.speed01);
    if (this.player.consumeJumped()) this.audio.jump();
    if (this.player.consumeLanded()) this.audio.land();

    this.vegetation.update(this.time);
    this.atmosphere.update(this.time, this.camera);
    this.portal.update(this.time);

    this.crowd.update(frameDelta);
  }

  /** Debug/menu hook: set the third-person camera distance (0 = first person). */
  setCameraZoom(distance: number): void {
    this.player.setZoom(distance);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.crowd?.dispose();
    this.character?.dispose();
    this.portal?.dispose();
    this.vegetation?.dispose();
    this.atmosphere?.dispose();
    this.cathedral?.dispose();
  }
}



