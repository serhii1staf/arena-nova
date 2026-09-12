import {
  Color,
  Group,
  Vector3,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
} from 'three';
import { Avatar } from '../player/Avatar.ts';
import type { NetworkManager, RemotePlayer } from './NetworkManager.ts';

/**
 * RemoteCrowd
 * -----------
 * Draws the other players. Shared by every scene, because "who else is here" is a
 * property of the session rather than of the map you happen to be standing on.
 *
 * Other players get the same `Avatar` the local player uses, so whatever model is
 * installed is what everyone sees — previously they were plain capsules, which
 * meant installing a character improved the view for you alone.
 *
 * They also need a locomotion state to animate, and the network only sends
 * positions. Speed is therefore differentiated from the interpolated position and
 * the stride phase is advanced from it, so a remote player walks when they are
 * walking and stands still when they stop.
 */

interface Tracked {
  avatar: Avatar;
  /** Previous interpolated position, for differentiating speed. */
  prev: Vector3;
  speed01: number;
  phase: number;
  primed: boolean;
  /** Smoothed vertical speed, m/s, derived from the interpolated path. */
  vy: number;
  /**
   * Per-mesh material pair for the see-through highlight: the material the rig came
   * with, and a private clone of it that ignores depth.
   *
   * Built lazily, and only for squad members. The clone is essential rather than
   * tidy: authored characters share one material set with a module-cached prototype,
   * so flipping `depthTest` on the material a rig hands you would make *every*
   * player wearing that character draw through walls. Cloning shares the textures,
   * so the cost is a small object per mesh and no extra shader — `depthTest` is
   * pipeline state, not a shader define.
   */
  overlay: { mesh: Mesh; normal: Material | Material[]; through: Material | Material[] }[] | null;
  /** Whether the highlight is currently applied, so a swap only happens on change. */
  showing: boolean;
  /** Result of the last line-of-sight test. */
  hidden: boolean;
  /** Frame budget counter, so sight lines are not retested every frame. */
  checkIn: number;
}

/** How far apart the line-of-sight samples are, in metres. */
const SIGHT_STEP = 2.4;
/** Most samples one sight line may take, whatever the distance. */
const SIGHT_SAMPLES = 48;
/** Frames between sight tests for one player. */
const SIGHT_INTERVAL = 4;
/** Height above the feet the sight line aims for — chest, not toes. */
const CHEST = 1.15;

export class RemoteCrowd {
  /**
   * Vertical speed past which a remote player is treated as airborne. Well above
   * what walking a slope produces, so ordinary terrain does not trip it.
   */
  private static readonly AIRBORNE_SPEED = 3.2;

  readonly group = new Group();

  private readonly tracked = new Map<string, Tracked>();
  private readonly net: NetworkManager;
  private readonly unsub: Array<() => void> = [];
  private readonly scratch = new Vector3();
  /** Sprint speed, used to normalise the measured speed to 0..1. */
  private readonly sprintSpeed: number;

  constructor(net: NetworkManager, sprintSpeed: number) {
    this.net = net;
    this.sprintSpeed = sprintSpeed;
    this.group.name = 'RemotePlayers';

    // Anyone already in the room when this scene opened.
    for (const p of net.remotePlayers.values()) this.add(p);
    this.unsub.push(net.onPlayerJoin((p) => this.add(p)));
    this.unsub.push(net.onPlayerLeave((p) => this.remove(p.id)));
    // A player is visible from the moment their socket is accepted, which can be a
    // round-trip before their chosen character is known, and they can change it
    // mid-session. Swapping in place keeps their motion state and plays the same
    // dissolve everyone else sees, so a character change looks deliberate rather
    // than like the player blinking out and back.
    this.unsub.push(net.onPlayerSkinChange((p) => this.tracked.get(p.id)?.avatar.setSkin(p.skin)));
  }

  private add(p: RemotePlayer): void {
    if (this.tracked.has(p.id)) return;
    // Wearing the skin they chose, not ours.
    const avatar = new Avatar(p.skin);
    this.group.add(avatar.object);
    this.tracked.set(p.id, {
      avatar,
      prev: new Vector3(p.x, p.y, p.z),
      speed01: 0,
      phase: 0,
      primed: false,
      vy: 0,
      overlay: null,
      showing: false,
      hidden: false,
      checkIn: 0,
    });
  }

  /**
   * Marks squad members and draws the hidden ones through the world.
   *
   * Two separate jobs, deliberately: deciding whether a player can be seen, and
   * deciding how to draw them. The first is a sampled walk along the sight line —
   * there is no raycasting anywhere in this project, and a grid of analytic height
   * and collider queries is both cheaper and steadier than one. The second is a
   * material swap on the meshes the rig is already animating, so the highlight is
   * genuinely the player's own character in their own pose rather than a stand-in
   * shape that would have to be kept in step with it.
   *
   * A member in plain sight is left completely alone. That is the point: a highlight
   * on someone you can already see is noise, and it would hide them behind their own
   * outline.
   */
  highlight(
    members: ReadonlySet<string>,
    eye: Vector3,
    blocked: (x: number, y: number, z: number) => boolean,
  ): void {
    for (const [id, t] of this.tracked) {
      const member = members.has(id);
      if (!member) {
        // Left the squad, or never was in it. Put their own materials back.
        if (t.showing) this.applyOverlay(t, false);
        t.hidden = false;
        continue;
      }

      const rp = this.net.remotePlayers.get(id);
      if (!rp) continue;

      // Staggered rather than every frame. A sight line is tens of height samples,
      // and whether a teammate is behind a hill does not change within four frames
      // — but it would cost four times as much to keep asking.
      if (t.checkIn <= 0) {
        t.checkIn = SIGHT_INTERVAL;
        t.hidden = this.occluded(eye, rp.x, rp.y + CHEST, rp.z, blocked);
      } else {
        t.checkIn--;
      }

      if (t.showing !== t.hidden) this.applyOverlay(t, t.hidden);
    }
  }

  /**
   * True when something stands between the eye and a point.
   *
   * Both ends are excluded from the walk. The near end because the camera itself sits
   * a little inside whatever it is against, and the far end because a player standing
   * on a slope has terrain immediately behind their own chest — sampling right up to
   * them would report every teammate on a hillside as hidden.
   */
  private occluded(
    eye: Vector3,
    x: number,
    y: number,
    z: number,
    blocked: (x: number, y: number, z: number) => boolean,
  ): boolean {
    const dx = x - eye.x;
    const dy = y - eye.y;
    const dz = z - eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 3) return false;
    const steps = Math.min(SIGHT_SAMPLES, Math.max(2, Math.round(dist / SIGHT_STEP)));
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      if (blocked(eye.x + dx * f, eye.y + dy * f, eye.z + dz * f)) return true;
    }
    return false;
  }

  /** Swaps a tracked player between their own materials and the see-through set. */
  private applyOverlay(t: Tracked, on: boolean): void {
    if (on && !t.overlay) t.overlay = this.buildOverlay(t.avatar.object);
    if (!t.overlay) return;
    for (const entry of t.overlay) {
      entry.mesh.material = on ? entry.through : entry.normal;
    }
    t.showing = on;
  }

  /**
   * Clones every material on a rig into a version that ignores depth.
   *
   * Rendered late and without depth testing, so it comes through terrain and
   * buildings; tinted with its own emissive so it reads as a marker rather than as
   * somebody standing in front of the mountain they are actually behind. The map is
   * kept, which is the whole point — you recognise the character, not a coloured
   * blob. Slightly transparent so an outline is still legible against bright sky.
   */
  private buildOverlay(root: Object3D): Tracked['overlay'] {
    const out: NonNullable<Tracked['overlay']> = [];
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const dress = (m: Material): Material => {
        const c = m.clone();
        c.depthTest = false;
        c.depthWrite = false;
        c.transparent = true;
        c.opacity = 0.85;
        const std = c as MeshStandardMaterial;
        if (std.isMeshStandardMaterial) {
          std.emissive = new Color(0x2f8f5a);
          std.emissiveIntensity = 0.75;
        }
        return c;
      };
      const normal = mesh.material;
      const through = Array.isArray(normal) ? normal.map(dress) : dress(normal);
      // Drawn after the world, and after the other transparent things in it.
      mesh.renderOrder = 12;
      out.push({ mesh, normal, through });
    });
    return out;
  }

  private remove(id: string): void {
    const t = this.tracked.get(id);
    if (!t) return;
    // Cloned highlight materials are ours; the ones underneath are the rig's.
    this.releaseOverlay(t);
    this.group.remove(t.avatar.object);
    t.avatar.dispose();
    this.tracked.delete(id);
  }

  /** Call once per rendered frame, after `NetworkManager.update()`. */
  update(frameDelta: number): void {
    for (const [id, t] of this.tracked) {
      const rp = this.net.remotePlayers.get(id);
      if (!rp) {
        this.remove(id);
        continue;
      }

      this.scratch.set(rp.x, rp.y, rp.z);
      if (!t.primed) {
        t.prev.copy(this.scratch);
        t.primed = true;
      }

      // Speed from the interpolated path, not from anything the network sent.
      const dt = Math.max(frameDelta, 1e-4);
      const moved = Math.hypot(this.scratch.x - t.prev.x, this.scratch.z - t.prev.z);
      const measured = Math.min(1, moved / dt / this.sprintSpeed);
      // Eased, because interpolation makes the raw per-frame delta noisy.
      t.speed01 += (measured - t.speed01) * Math.min(1, dt * 8);

      // Vertical motion, from the same interpolated path. `grounded` used to be
      // hard-coded true here, so remote players never jumped or fell — they slid
      // up and down slopes and through the air in a walk cycle. Heavily smoothed,
      // because interpolation between 20 Hz snapshots makes the raw frame-to-frame
      // delta far too noisy to threshold directly.
      const rise = (this.scratch.y - t.prev.y) / dt;
      t.vy += (rise - t.vy) * Math.min(1, dt * 6);
      t.prev.copy(this.scratch);

      if (t.speed01 > 0.02) t.phase += t.speed01 * this.sprintSpeed * dt * 1.9;

      t.avatar.update(
        this.scratch,
        rp.yaw,
        {
          speed01: t.speed01,
          grounded: Math.abs(t.vy) < RemoteCrowd.AIRBORNE_SPEED,
          phase: t.phase,
          vy: t.vy,
        },
        frameDelta,
      );
    }
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub.length = 0;
    for (const id of [...this.tracked.keys()]) this.remove(id);
    this.group.removeFromParent();
  }

  /** Frees the cloned highlight materials. The originals belong to the rig. */
  private releaseOverlay(t: Tracked): void {
    if (!t.overlay) return;
    if (t.showing) this.applyOverlay(t, false);
    for (const entry of t.overlay) {
      const m = entry.through;
      if (Array.isArray(m)) for (const one of m) one.dispose();
      else m.dispose();
    }
    t.overlay = null;
  }
}
