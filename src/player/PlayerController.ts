import { Euler, MathUtils, PerspectiveCamera, Vector2, Vector3 } from 'three';
import { GameConfig } from '../config.ts';
import type { Input } from '../core/Input.ts';

export interface PlayerCollision {
  /** Resolve horizontal collisions in-place. */
  collide(pos: Vector3): void;
  /** Ground height at a world XZ. */
  floorHeightAt(x: number, z: number): number;
  /**
   * Optional: true when a point is inside geometry, so the third-person camera
   * can stop short instead of ending up inside a rock or wall.
   */
  blocksCamera?(x: number, y: number, z: number): boolean;
}

/**
 * PlayerController
 * ----------------
 * Smooth first/third-person controller. Physics run on the fixed timestep
 * (stable, network-friendly); look, zoom and camera placement are interpolated
 * every frame. Mouse wheel dollies the camera from first person (distance 0)
 * out to a behind-the-shoulder third-person view.
 *
 * It also publishes a small animation/locomotion state that the character model
 * and audio read each frame (speed, phase, grounded, footstep/jump/land events).
 */
export class PlayerController {
  readonly camera: PerspectiveCamera;
  private readonly input: Input;
  private readonly world: PlayerCollision;

  /** Feet position. Camera sits `eyeHeight` above this (first person). */
  private readonly position = new Vector3();
  private readonly prevPosition = new Vector3();
  private readonly velocity = new Vector3();
  private grounded = false;

  private yaw = 0;
  private pitch = 0;
  private camDist = 0;
  private camDistTarget = 0;

  // ---- Published locomotion state (read by CharacterModel / audio) ----
  /** Interpolated feet position for the current frame. */
  readonly renderPosition = new Vector3();
  /** Authoritative feet position (fixed-step). Used for triggers/zones. */
  get feetPosition(): Vector3 {
    return this.position;
  }
  viewYaw = 0;
  animPhase = 0;
  /** Horizontal speed normalised to sprint (0..1). */
  speed01 = 0;
  isGrounded = false;
  /** Metres per second, signed. Lets the rig tell rising from falling. */
  verticalSpeed = 0;
  /** How long the body has genuinely had no ground under it. */
  private airborneFor = 0;
  private footstepFlag = false;
  private jumpedFlag = false;
  private landedFlag = false;
  private lastStepIndex = 0;

  private readonly lookScratch = new Vector2();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly wish = new Vector3();
  private readonly viewDir = new Vector3();
  private readonly camScratch = new Vector3();

  constructor(camera: PerspectiveCamera, input: Input, world: PlayerCollision) {
    this.camera = camera;
    this.input = input;
    this.world = world;
  }

  spawn(x: number, z: number, yaw: number): void {
    const y = this.world.floorHeightAt(x, z);
    this.position.set(x, y, z);
    this.prevPosition.copy(this.position);
    this.renderPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.viewYaw = yaw;
    this.pitch = 0;
  }

  get thirdPerson(): boolean {
    return this.camDist > 0.4;
  }

  /** Set camera orbit distance directly (0 = first person). For menus/debug. */
  setZoom(distance: number): void {
    const d = MathUtils.clamp(distance, 0, GameConfig.player.cameraMaxDistance);
    this.camDistTarget = d;
    this.camDist = d;
  }

  consumeFootstep(): boolean {
    const v = this.footstepFlag;
    this.footstepFlag = false;
    return v;
  }
  consumeJumped(): boolean {
    const v = this.jumpedFlag;
    this.jumpedFlag = false;
    return v;
  }
  consumeLanded(): boolean {
    const v = this.landedFlag;
    this.landedFlag = false;
    return v;
  }

  /** Fixed-step physics + locomotion state. */
  update(dt: number): void {
    this.prevPosition.copy(this.position);
    const cfg = GameConfig.player;

    // Movement basis from yaw (camera looks -Z at yaw 0).
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    this.wish
      .set(0, 0, 0)
      .addScaledVector(this.forward, this.input.move.y)
      .addScaledVector(this.right, this.input.move.x);
    if (this.wish.lengthSq() > 1) this.wish.normalize();

    const targetSpeed = this.input.sprint ? cfg.sprintSpeed : cfg.walkSpeed;
    const targetVx = this.wish.x * targetSpeed;
    const targetVz = this.wish.z * targetSpeed;

    // Exponential approach: reaches full speed in ~0.3 s (responsive, not floaty).
    const accel = Math.min(1, cfg.acceleration * dt * 0.35);
    this.velocity.x += (targetVx - this.velocity.x) * accel;
    this.velocity.z += (targetVz - this.velocity.z) * accel;
    const damp = Math.max(0, 1 - cfg.damping * dt);
    if (this.wish.lengthSq() < 0.01) {
      this.velocity.x *= damp;
      this.velocity.z *= damp;
    }

    // Jump + gravity.
    if (this.grounded && this.input.consumeJump()) {
      this.velocity.y = cfg.jumpSpeed;
      this.grounded = false;
      this.jumpedFlag = true;
    } else {
      this.input.consumeJump();
    }
    this.velocity.y -= cfg.gravity * dt;

    // Integrate.
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.position.y += this.velocity.y * dt;

    // Horizontal collisions (walls + columns).
    this.world.collide(this.position);

    // Ground.
    //
    // Walking *downhill* needs a downward snap, not just the upward one. Landing
    // resets vertical velocity to zero every step, so at the start of the next
    // step the body can only fall gravity*dt² ≈ 5 mm while it travels up to
    // 127 mm forward at a sprint. Any slope steeper than about 8% therefore drops
    // away faster than the body falls: the probe reported airborne, the animation
    // switched to the fall clip, gravity built up for a few steps, the body
    // caught the surface and was snapped flat again — over and over, at step
    // rate. That is the hopping, juddering descent, and it also stalled the
    // stride phase and the footstep events, which only advance while grounded.
    //
    // The allowance is derived from how far the body actually moved this step
    // rather than being a fixed number, so it scales with speed and cannot let a
    // stationary player sink. The constant floor on top of it is what carries the
    // player down single stair treads without leaving the ground.
    const floor = this.world.floorHeightAt(this.position.x, this.position.z);
    const wasGrounded = this.grounded;
    const travelled = Math.hypot(this.velocity.x, this.velocity.z) * dt;
    const snapDown = Math.max(cfg.groundSnapMin, travelled * cfg.groundSnapSlope);
    if (this.position.y <= floor) {
      if (!wasGrounded && this.velocity.y < -3) this.landedFlag = true;
      this.position.y = floor;
      this.velocity.y = 0;
      this.grounded = true;
    } else if (wasGrounded && this.velocity.y <= 0 && this.position.y - floor <= snapDown) {
      // Still following the surface, just downhill. Stay planted.
      this.position.y = floor;
      this.velocity.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    // Publish a slightly forgiving version of the flag to the animation layer.
    // A genuine step off a kerb or over a bump should not flip the whole body to
    // a falling pose for two frames; a real jump or fall still reads instantly
    // because the hold is shorter than a blend and is skipped while rising.
    if (this.grounded) this.airborneFor = 0;
    else this.airborneFor += dt;
    this.isGrounded =
      this.grounded || (this.airborneFor < cfg.coyoteTime && this.velocity.y < cfg.jumpSpeed * 0.2);
    this.verticalSpeed = this.velocity.y;

    // Locomotion state for animation + footstep events.
    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.speed01 = MathUtils.clamp(hSpeed / cfg.sprintSpeed, 0, 1);
    if (this.isGrounded && hSpeed > 0.4) {
      this.animPhase += hSpeed * dt * 1.9;
      const step = Math.floor(this.animPhase / Math.PI);
      if (step !== this.lastStepIndex) {
        this.lastStepIndex = step;
        this.footstepFlag = true;
      }
    }
  }

  /** Per-frame: look, zoom, and place the interpolated first/third-person camera. */
  render(alpha: number, frameDelta: number): void {
    const cfg = GameConfig.player;

    // Look.
    const look = this.input.consumeLook(this.lookScratch);
    const sens =
      (this.input.lookCameFromTouch ? cfg.touchLookSensitivity : cfg.mouseSensitivity) *
      this.input.lookSensitivityScale;
    this.yaw -= look.x * sens;
    this.pitch -= look.y * sens;
    this.pitch = MathUtils.clamp(this.pitch, -1.45, 1.45);
    this.viewYaw = this.yaw;

    // Zoom (mouse wheel) → target camera distance.
    const wheel = this.input.consumeWheel();
    if (wheel !== 0) {
      this.camDistTarget = MathUtils.clamp(
        this.camDistTarget + wheel * 0.01 * cfg.cameraZoomSpeed,
        0,
        cfg.cameraMaxDistance,
      );
    }
    this.camDist += (this.camDistTarget - this.camDist) * Math.min(1, frameDelta * 12);

    this.euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);

    // Interpolated feet, then eye pivot.
    this.renderPosition.lerpVectors(this.prevPosition, this.position, alpha);
    const pivotY = this.renderPosition.y + cfg.eyeHeight;

    if (this.camDist < 0.4) {
      // First person.
      this.camera.position.set(this.renderPosition.x, pivotY, this.renderPosition.z);
    } else {
      // Third person: dolly back along the view direction, but stop short of
      // anything solid so the camera never ends up inside a rock or wall.
      this.viewDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const blocks = this.world.blocksCamera?.bind(this.world);
      let dist = this.camDist;
      if (blocks) {
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          const d = (this.camDist * i) / steps;
          const px = this.renderPosition.x - this.viewDir.x * d;
          const py = pivotY - this.viewDir.y * d;
          const pz = this.renderPosition.z - this.viewDir.z * d;
          if (blocks(px, py, pz)) {
            dist = Math.max(0.6, (this.camDist * (i - 1)) / steps);
            break;
          }
        }
      }
      this.camScratch.set(
        this.renderPosition.x - this.viewDir.x * dist,
        pivotY - this.viewDir.y * dist,
        this.renderPosition.z - this.viewDir.z * dist,
      );
      const camFloor = this.world.floorHeightAt(this.camScratch.x, this.camScratch.z) + 0.45;
      if (this.camScratch.y < camFloor) this.camScratch.y = camFloor;
      this.camera.position.copy(this.camScratch);
    }
  }
}
