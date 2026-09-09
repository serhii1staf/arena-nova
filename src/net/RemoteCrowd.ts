import { Group, Vector3 } from 'three';
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
}

export class RemoteCrowd {
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
    // round-trip before their chosen character is known. Rebuild rather than
    // leave them wearing the fallback for the rest of the session.
    this.unsub.push(
      net.onPlayerSkinChange((p) => {
        const t = this.tracked.get(p.id);
        if (!t) return;
        this.remove(p.id);
        this.add(p);
        // Carry the motion state across so the swap does not reset their stride.
        const next = this.tracked.get(p.id);
        if (next) {
          next.prev.copy(t.prev);
          next.speed01 = t.speed01;
          next.phase = t.phase;
          next.primed = t.primed;
        }
      }),
    );
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
    });
  }

  private remove(id: string): void {
    const t = this.tracked.get(id);
    if (!t) return;
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
      t.prev.copy(this.scratch);

      if (t.speed01 > 0.02) t.phase += t.speed01 * this.sprintSpeed * dt * 1.9;

      t.avatar.update(
        this.scratch,
        rp.yaw,
        { speed01: t.speed01, grounded: true, phase: t.phase },
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
}
