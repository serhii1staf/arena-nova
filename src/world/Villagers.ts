import { Group, Vector3 } from 'three';
import { Avatar } from '../player/Avatar.ts';
import { SKINS } from '../player/skins.ts';
import { surfaceGroundHeightAt } from './WorldGen.ts';
import type { VillageInfo, VillagePlace, VillageStreamer } from './Village.ts';

/**
 * Villagers
 * ---------
 * People who live in the nearest settlement: they have a home, a workplace, and a day.
 *
 * The population is a **fixed crew**, not one character per house, and that is the whole
 * design. A villager is an `Avatar`, which resolves to a skinned GLB clone with its own
 * `AnimationMixer` — the same body a remote player gets — and nothing in this project batches
 * skinned meshes. So each one is a draw call and a mixer update, and the honest budget is
 * "about as many as the game already supports players". Six.
 *
 * The crew is reassigned rather than respawned. Walk to another village and the same six
 * people are given homes and jobs there; walk away from all of them and they are parked
 * out of sight and stop costing anything but a hidden object. This is why a world of two
 * hundred settlements costs the same as one.
 *
 * What they do is deliberately simple and deliberately legible: leave home in the morning,
 * stand at work through the day, walk to the square in the evening, go home at night. Not a
 * needs simulation — a schedule, which is the part you can actually see.
 */

/** How many villagers exist at once, anywhere in the world. */
const CREW = 6;

/**
 * Beyond this the settlement is not worth peopling.
 *
 * Comfortably past the distance at which a walking figure is a couple of pixels, and inside
 * the village streamer's own view distance so the crew can never be assigned to a settlement
 * whose houses have been unloaded.
 */
const ACTIVE_RANGE = 190;

/** Metres per second. A stroll; villagers are not commuting to a fire. */
const WALK = 1.15;
/** How close counts as arrived. */
const ARRIVE = 1.6;

type Phase = 'toWork' | 'atWork' | 'toSquare' | 'atSquare' | 'toHome' | 'atHome';

interface Villager {
  avatar: Avatar;
  /** Where this one lives and works in the current settlement. */
  home: VillagePlace | null;
  work: VillagePlace | null;
  phase: Phase;
  /** Seconds left to stand still. */
  dwell: number;
  /** Current position, kept here rather than read back off the avatar. */
  at: Vector3;
  /** Where they are heading, or null when standing. */
  target: Vector3 | null;
  yaw: number;
  /** Smoothed 0..1 for the walk animation, so it eases in rather than snapping. */
  speed01: number;
  /** Stride phase, advanced by distance travelled so the feet match the ground. */
  stride: number;
  /** A little scatter so six people do not move as one body. */
  jitter: number;
}

export interface VillagerCrew {
  group: Group;
  /** `night` is 0 by day and 1 at night — the schedule's only input besides the clock. */
  update(dt: number, playerPos: Vector3, night: number, villages: VillageStreamer): void;
  /** How many are currently peopling a settlement. Diagnostics. */
  active(): number;
  dispose(): void;
}

export function createVillagers(): VillagerCrew {
  const group = new Group();
  group.name = 'Villagers';

  const crew: Villager[] = [];
  // Skins spread across the library so a settlement is not six identical people. The local
  // player's own saved skin is deliberately not consulted: a villager is pinned to a skin at
  // construction, or every villager would change clothes when the player did.
  const ids = SKINS.map((s) => s.id);
  for (let i = 0; i < CREW; i++) {
    const avatar = new Avatar(ids[i % ids.length]);
    avatar.object.visible = false;
    group.add(avatar.object);
    crew.push({
      avatar,
      home: null,
      work: null,
      phase: 'atHome',
      dwell: 0,
      at: new Vector3(),
      target: null,
      yaw: 0,
      speed01: 0,
      stride: 0,
      jitter: i * 0.37,
    });
  }

  /** The settlement the crew is currently living in. */
  let current: VillageInfo | null = null;
  const scratch = new Vector3();

  /**
   * Hands the crew to a settlement.
   *
   * Everyone gets a home and a job by index, wrapping — so a village with two houses has
   * three people to a house rather than four villagers standing in a field. They are placed
   * at their homes immediately rather than walked in from the edge of the world.
   */
  const assign = (info: VillageInfo | null): void => {
    current = info;
    for (let i = 0; i < crew.length; i++) {
      const v = crew[i]!;
      if (!info) {
        v.home = null;
        v.work = null;
        v.avatar.object.visible = false;
        continue;
      }
      v.home = info.homes.length > 0 ? info.homes[i % info.homes.length]! : info.centre;
      v.work = info.works.length > 0 ? info.works[i % info.works.length]! : info.centre;
      // Spread them round their own front door so they do not start inside one another.
      const a = (i / crew.length) * Math.PI * 2;
      v.at.set(v.home.x + Math.cos(a) * 1.4, v.home.y, v.home.z + Math.sin(a) * 1.4);
      v.at.y = surfaceGroundHeightAt(v.at.x, v.at.z);
      v.phase = 'atHome';
      v.dwell = 1 + i * 0.4;
      v.target = null;
      v.speed01 = 0;
      v.avatar.object.visible = true;
    }
  };

  /** Somewhere to stand near a place, so six people do not stack on one point. */
  const near = (place: VillagePlace, v: Villager, spread: number): Vector3 => {
    const a = v.jitter * Math.PI * 2;
    scratch.set(place.x + Math.cos(a) * spread, place.y, place.z + Math.sin(a) * spread);
    scratch.y = surfaceGroundHeightAt(scratch.x, scratch.z);
    return scratch;
  };

  /** Advances one villager's schedule. Returns the target, or null to stand still. */
  const step = (v: Villager, night: number): void => {
    if (!v.home || !v.work || !current) return;
    if (v.dwell > 0) {
      v.dwell -= 1;
      return;
    }
    switch (v.phase) {
      case 'atHome':
        // Out to work in the morning; stay in at night.
        if (night < 0.35) {
          v.phase = 'toWork';
          v.target = near(v.work, v, 2.2).clone();
        } else {
          v.dwell = 2;
        }
        break;
      case 'toWork':
        v.phase = 'atWork';
        // A working day, in seconds of dwell. Long enough that a passer-by sees somebody at
        // work rather than somebody permanently in transit.
        v.dwell = 14 + v.jitter * 8;
        break;
      case 'atWork':
        if (night > 0.3) {
          v.phase = 'toSquare';
          v.target = near(current.centre, v, 2.6).clone();
        } else {
          // Potter about the workplace rather than standing rigid.
          v.phase = 'toWork';
          v.target = near(v.work, v, 1.2 + (v.jitter % 1) * 2).clone();
        }
        break;
      case 'toSquare':
        v.phase = 'atSquare';
        v.dwell = 8 + v.jitter * 6;
        break;
      case 'atSquare':
        v.phase = 'toHome';
        v.target = near(v.home, v, 1.6).clone();
        break;
      case 'toHome':
        v.phase = 'atHome';
        v.dwell = 10;
        break;
    }
  };

  const update = (dt: number, playerPos: Vector3, night: number, villages: VillageStreamer): void => {
    const info = villages.nearest(playerPos);
    const inRange =
      info !== null &&
      (info.x - playerPos.x) ** 2 + (info.z - playerPos.z) ** 2 < ACTIVE_RANGE * ACTIVE_RANGE;
    const want = inRange ? info : null;
    // Reassigned only when the settlement actually changes, so walking about inside one does
    // not reset everybody to their doorstep every frame.
    if ((want?.key ?? null) !== (current?.key ?? null)) assign(want);
    if (!current) return;

    for (const v of crew) {
      step(v, night);
      let moving = 0;
      if (v.target) {
        const dx = v.target.x - v.at.x;
        const dz = v.target.z - v.at.z;
        const dist = Math.hypot(dx, dz);
        if (dist < ARRIVE) {
          v.target = null;
        } else {
          const stepLen = Math.min(dist, WALK * dt);
          v.at.x += (dx / dist) * stepLen;
          v.at.z += (dz / dist) * stepLen;
          // The pad is level, but read the drawn surface anyway: a villager on the blend ring
          // outside the flat disc would otherwise walk through the slope.
          v.at.y = surfaceGroundHeightAt(v.at.x, v.at.z);
          // Models face -Z, the same convention the player and the wildlife use.
          const wantYaw = Math.atan2(-dx, -dz);
          let d = wantYaw - v.yaw;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          v.yaw += d * Math.min(1, dt * 6);
          v.stride += stepLen;
          moving = 1;
        }
      }
      // Eased, so the walk cycle fades in and out instead of popping between poses.
      v.speed01 += (moving - v.speed01) * Math.min(1, dt * 5);
      v.avatar.update(
        v.at,
        v.yaw,
        { speed01: v.speed01 * 0.45, grounded: true, phase: v.stride, vy: 0 },
        dt,
      );
    }
  };

  const dispose = (): void => {
    for (const v of crew) v.avatar.dispose();
    crew.length = 0;
    current = null;
  };

  return {
    group,
    update,
    active: () => (current ? crew.length : 0),
    dispose,
  };
}
