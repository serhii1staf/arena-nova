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
import { createBuildSite, type BuildSite } from '../world/Building.ts';
import { setBuildSite } from '../ui/BuildBar.ts';
import { squadIds } from '../ui/Squad.ts';
import { surfaceGroundHeightAt, WORLD } from '../world/WorldGen.ts';
import { createGatherSite, type GatherSite } from '../world/Gatherables.ts';
import { consumeUse, initInteract, setPrompt } from '../ui/Interact.ts';
import { openInventory, setBenchPlacer, setBenchProbe } from '../ui/GameUI.ts';
import { inventory } from '../game/Inventory.ts';
import { ITEMS, type ItemId } from '../game/Items.ts';
import { t } from '../ui/i18n.ts';
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
  /**
   * Readable rather than private so a test can ask the crowd the same sight question the
   * highlight asks. It had been reimplementing the sampling policy, and a copy of a
   * policy is a copy that drifts — see `RemoteCrowd.hiddenBetween`.
   */
  crowd!: RemoteCrowd;
  private buildSite!: BuildSite;
  private gather!: GatherSite;
  /** Reused each frame for the build aim ray; allocating two vectors per frame here
   * would be pure churn for something that is off most of the time. */
  private readonly aimFrom = new Vector3();
  private readonly aimDir = new Vector3();
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
      // World first: it clamps to the map and walks the body off the shoreline.
      // Built pieces push afterwards, so a wall cannot shove you into the sea only
      // for the shoreline pass to shove you back through the wall.
      collide: (p) => {
        this.world.collide(p);
        this.buildSite?.collide(p, 0.4);
        // Trunks and benches. Sticks and stones deliberately do not push: being
        // stopped by an ankle-high twig is worse than walking over it.
        this.gather?.collide(p, 0.4);
      },
      // Composed, not replaced: the world answers first and the build site raises
      // the answer where it has a floor, a ramp or a roof. The site is created a
      // few lines below, so these are written to survive being asked before it
      // exists.
      floorHeightAt: (x, z, fromY) => {
        const ground = this.world.floorHeightAt(x, z);
        return this.buildSite?.heightAt(x, z, ground, fromY) ?? ground;
      },
      blocksCamera: (x, y, z) =>
        this.world.blocksCamera(x, y, z) || (this.buildSite?.blocksCamera(x, y, z) ?? false),
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

    // Admin construction. Built here rather than inside the world so it survives
    // chunk streaming untouched — pieces are placed by hand and must not be
    // unloaded when the player walks away from them — but it registers its
    // colliders in the world's own registry, so what you build is as solid as what
    // grew there.
    this.buildSite = createBuildSite(ctx.assets);
    this.scene.add(this.buildSite.group);
    setBuildSite(this.buildSite);

    // Sticks, stones, dead trees and workbenches. Nothing is stored: every one is
    // derived from its own grid cell, so the world is consistent without a spawn list
    // and only what is near the player exists as geometry.
    this.gather = createGatherSite();
    this.scene.add(this.gather.group);
    initInteract();
    setBenchProbe(() => this.gather.atBench(this.player.feetPosition));
    // Putting down a bench you made. The panel asks; the scene knows where "in front
    // of you" is and whether anything is already standing there.
    setBenchPlacer(() => {
      const feet = this.player.feetPosition;
      const yaw = this.player.viewYaw;
      // Two and a half metres ahead, and turned to face you — you build a bench to
      // stand at, not to look at the back of.
      const x = feet.x - Math.sin(yaw) * 2.5;
      const z = feet.z - Math.cos(yaw) * 2.5;
      return this.gather.placeBench(x, z, yaw + Math.PI);
    });

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
    // Admin body scale. Cheap: a comparison inside the avatar, and nothing at all
    // for a normal session where it stays at 1.
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
    // Squad members behind terrain or behind something built are drawn through it.
    // The sight test reuses the very predicate the third-person camera uses to pull
    // itself in, so "can I see them" and "can the camera see past that" are one
    // answer rather than two that could disagree.
    //
    // Called unconditionally, not only while a squad exists. It is also what puts a
    // player's own materials back when they leave the squad, and gating it on a
    // non-empty squad meant the last member to leave kept their highlight for ever.
    //
    // Terrain and built structures block the sight line; trees deliberately do not.
    // `world.blocksCamera` would also count every trunk and boulder, which is right
    // for pulling a camera in and wrong here — a teammate six metres away in a wood
    // would flicker in and out of being "hidden" with every trunk that crossed the
    // line. What the highlight is for is a hill or a wall between you.
    this.camera.getWorldPosition(this.aimFrom);
    this.crowd.highlight(squadIds(), this.aimFrom, this.sightBlocked);
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
    this.stepSurvival(frameDelta);
    // Firelight follows the player rather than existing per fire, so a room full of
    // torches costs the same as one torch.
    this.buildSite.lightUp(p);

    // Build preview. Driven from the camera rather than from the body, so the piece
    // lands where the crosshair points in third person too. Returns immediately
    // while build mode is off, which is every frame of a normal session.
    // Also runs with the mode shut once anything is standing, because doors have to
    // be usable without entering a construction mode to open one. Still nothing at
    // all for a session that has built nothing, which is every normal session.
    if (this.buildSite.active || this.buildSite.count() > 0) {
      this.camera.getWorldPosition(this.aimFrom);
      this.camera.getWorldDirection(this.aimDir);
      // The height a piece lands on includes what has already been built, not just the
      // terrain. Asking the world alone is why a bed put down on a floor sank into it and
      // a lantern could not be stood on a table: the preview was measuring the ground
      // under the floor rather than the floor. Unbounded on purpose — for placing, the
      // top of whatever is there is exactly what you want.
      this.buildSite.update(this.aimFrom, this.aimDir, this.player.feetPosition, (x, z) =>
        this.buildSite.heightAt(x, z, this.world.floorHeightAt(x, z)),
      );
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Gathering, felling, benches, thirst.
   *
   * All of it hangs off one thing being in reach, so it is one pass rather than four
   * that each walk the same list. The heavy part — deciding what exists nearby — only
   * runs when the player crosses a cell boundary, inside `gather.update`.
   */
  private stepSurvival(dt: number): void {
    const feet = this.player.feetPosition;
    this.gather.update(feet, dt);
    inventory().tick(dt);

    // Standing in water fills the water meter. Cheap, and it is the one source of
    // drink in the world, so it does not need a container to be useful.
    if (feet.y <= WORLD.waterLevel + 0.9) inventory().drink();

    this.camera.getWorldDirection(this.aimDir);
    const target = this.gather.aimed(feet, this.aimDir);
    const door = this.buildSite.reachableKind();

    // One prompt, and the nearer intent wins. A door is only offered when there is no
    // pickup in reach, because reaching for a stick at your feet is the more likely
    // meaning when both are there.
    if (target) {
      setPrompt(this.promptFor(target.kind));
      if (consumeUse()) this.use(target.kind, target);
    } else if (door) {
      setPrompt(t(this.buildSite.reachableOpen() ? 'build.shutDoor' : 'build.openDoor'));
      if (consumeUse()) this.buildSite.interact();
    } else {
      setPrompt(null);
      consumeUse();
    }
  }

  /** What the prompt should say for a thing in reach. */
  private promptFor(kind: ItemId | 'snag' | 'bench'): string {
    if (kind === 'bench') return t('gather.bench');
    if (kind === 'snag') {
      return inventory().hasTool('axe') ? t('gather.fell') : t('gather.needAxe');
    }
    return `${t('gather.take')} ${t(`item.${kind}`)}`;
  }

  private use(kind: ItemId | 'snag' | 'bench', target: Parameters<GatherSite['take']>[0]): void {
    if (kind === 'bench') {
      openInventory();
      return;
    }
    if (kind === 'snag') {
      // An axe is the gate rather than a strength check: the point of the axe is that
      // it opens timber up, and a player without one should be told, not silently
      // ignored.
      if (!inventory().hasTool('axe')) return;
      this.gather.take(target);
      return;
    }
    // Only removed if it actually fitted, so a full bag leaves the item on the ground
    // instead of destroying it.
    const stack = kind === 'stick' || kind === 'stone' || kind === 'fibre' ? 2 : 1;
    if (inventory().add(kind, Math.min(stack, ITEMS[kind].stack)) > 0) this.gather.take(target);
  }

  /**
   * Whether a point is inside something that would hide a squad member.
   *
   * A bound arrow so it can be handed straight to the crowd without allocating a
   * closure per frame, and public so it is the one definition of "in the way" —
   * anything asking the question, including the probe, asks this rather than
   * reassembling the same expression and drifting from it.
   */
  readonly sightBlocked = (x: number, y: number, z: number): boolean =>
    y < surfaceGroundHeightAt(x, z) || (this.buildSite?.blocksCamera(x, y, z) ?? false);

  /** Debug/menu hook: set the third-person camera distance. */
  setCameraZoom(distance: number): void {
    this.player.setZoom(distance);
  }

  dispose(): void {
    // Withdrawn before the site is torn down, so the hotbar cannot hold a pointer
    // into a disposed world for even one frame.
    setBuildSite(null);
    setBenchProbe(null);
    setBenchPlacer(null);
    this.gather?.dispose();
    this.buildSite?.dispose();
    this.crowd?.dispose();
    this.character?.dispose();
    this.dragon?.dispose();
    this.dayNight?.dispose();
    this.world?.dispose();
  }
}



