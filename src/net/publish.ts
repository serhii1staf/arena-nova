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

/**
 * How often a player who is doing nothing at all still reports in.
 *
 * Something has to be sent occasionally even when standing still: latency rides on
 * the input message, and the server refreshes what it knows about a socket when one
 * arrives. Two seconds is far more often than either needs.
 */
const KEEPALIVE_INTERVAL = 2;

/**
 * Smallest movement worth a message: a centimetre, and about a tenth of a degree.
 *
 * Below this there is nothing for a remote viewer to see. Positions are
 * interpolated over an 80 ms window between 20 Hz samples, so a centimetre of
 * drift cannot survive the smoothing even in principle — sending it spends a
 * request to transmit a rounding error.
 */
const MOVE_EPSILON = 0.01;
const YAW_EPSILON = 0.002;

export class LocalPublisher {
  private accum = SEND_INTERVAL; // publish on the first step, not 50 ms in
  private sinceKeepalive = 0;
  private sent = { x: 0, y: 0, z: 0, yaw: 0 };
  private everSent = false;

  /**
   * Call once per fixed step. Sends at up to 20 Hz while the player is moving, and
   * once every couple of seconds while they are not.
   *
   * The rate limit is not the point of the idle check — the request count is. Each
   * message to the room is a billable request, so a flat 20 Hz costs 1,200 an hour
   * per minute of play, per player, whether anything happened or not. On the free
   * plan's daily allowance that works out to roughly eighty player-minutes for the
   * entire game, which is what actually took the server down: it returned 1027 to
   * everybody and the symptom was "no connection" in the player list. A player
   * standing still generates no information, and now costs almost nothing to say so.
   *
   * Moving players are unaffected. The full 20 Hz is still sent the moment anything
   * changes, so nobody's motion is any coarser than it was.
   */
  step(net: NetworkManager, player: PublishablePlayer, dt: number): void {
    this.accum += dt;
    this.sinceKeepalive += dt;
    if (this.accum < SEND_INTERVAL) return;
    this.accum = 0;

    const f = player.feetPosition;
    const yaw = player.viewYaw;
    const moved =
      !this.everSent ||
      Math.abs(f.x - this.sent.x) > MOVE_EPSILON ||
      Math.abs(f.y - this.sent.y) > MOVE_EPSILON ||
      Math.abs(f.z - this.sent.z) > MOVE_EPSILON ||
      Math.abs(yaw - this.sent.yaw) > YAW_EPSILON;

    if (!moved && this.sinceKeepalive < KEEPALIVE_INTERVAL) return;

    this.sinceKeepalive = 0;
    this.everSent = true;
    this.sent.x = f.x;
    this.sent.y = f.y;
    this.sent.z = f.z;
    this.sent.yaw = yaw;
    net.sendInput(f.x, f.y, f.z, yaw);
  }
}
