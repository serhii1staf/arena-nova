import type { NetworkManager } from './NetworkManager.ts';

/**
 * Publishing the local player to the room.
 *
 * This exists as one shared piece rather than a few lines copied into each scene
 * because the two copies had already drifted apart, and every difference between
 * them showed up as a separate visible bug for everyone *else* in the room:
 *
 *  - The lobby sent `camera.position` instead of the player's feet. In third
 *    person the camera orbits, so turning on the spot swung it sideways around
 *    the body — remote viewers saw the avatar slide left and right instead of
 *    rotating, and zooming out pushed the avatar backwards and upwards, which
 *    read as the player drifting away and floating.
 *  - It sent `camera.rotation.y`. The camera's quaternion is composed as a YXZ
 *    Euler, while `Object3D.rotation` re-derives an XYZ one, so that value only
 *    equals the intended yaw while the pitch is exactly level. Looking up or
 *    down twisted the reported facing, and steep pitch flipped it outright — so
 *    standing face to face, each player saw the other's back.
 *  - It subtracted eye height from the camera's y, which only cancels out in
 *    first person; in third person the camera rises with pitch, so the avatar's
 *    feet were reported above the ground.
 *
 * Feet position and body yaw are the only two things that are true regardless of
 * where the camera happens to be, so those are what goes on the wire.
 */

/** The slice of the player controller this needs. Keeps the coupling narrow. */
export interface PublishablePlayer {
  readonly feetPosition: { x: number; y: number; z: number };
  readonly viewYaw: number;
}

/** Matches the server's broadcast rate; sending faster would only be discarded. */
const SEND_INTERVAL = 0.05;

export class LocalPublisher {
  private accum = SEND_INTERVAL; // publish on the first step, not 50 ms in

  /** Call once per fixed step. Sends at ~20 Hz. */
  step(net: NetworkManager, player: PublishablePlayer, dt: number): void {
    this.accum += dt;
    if (this.accum < SEND_INTERVAL) return;
    this.accum = 0;
    const f = player.feetPosition;
    net.sendInput(f.x, f.y, f.z, player.viewYaw);
  }
}
