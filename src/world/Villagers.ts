import { Group, Vector3 } from 'three';
import { makeVillagerBody, type VillagerBody, type VillagerModel } from './VillagerModels.ts';
import type { VillageInfo, VillagePlace, VillageStreamer } from './Village.ts';

/**
 * Villagers
 * ---------
 * People who live in the nearest settlement: they have a home, a workplace, and a day.
 *
 * The population is a **fixed crew**, not one person per house, and it is reassigned rather
 * than respawned — walk to the next village and the same people are given homes and jobs
 * there. That is what makes two hundred settlements cost what one does.
 *
 * Three faults from the first version are fixed here, and they are worth naming because each
 * one was visible within seconds of walking into a village:
 *
 *  * **They walked through walls.** Nothing consulted collision at all. They now push out of
 *    the same prop registry the player does, every step.
 *  * **They walked into houses and stopped.** Their target was the building's *centre*, which
 *    is on the far side of a wall — so each one walked until the collision it did not have
 *    would have stopped it, then stood inside the geometry. They now go to the *doorstep*,
 *    which the layout generator records, and never step inside at all.
 *  * **They were the player's own body.** `Avatar` builds a forty-mesh procedural character
 *    immediately and swaps in a skinned model when the download lands. For a crew that first
 *    body is pure waste. They use the authored villager pack directly and simply do not exist
 *    until it has arrived.
 */

/**
 * How many villagers exist at once, anywhere in the world.
 *
 * Each is a skinned mesh and an `AnimationMixer`, and nothing in this project batches skinned
 * meshes, so each is a draw call and a mixer update. This is about as many as the game already
 * carries in remote players.
 */
const CREW = 6;

/** Beyond this the settlement is not worth peopling. Inside the village view distance. */
const ACTIVE_RANGE = 170;

/** Metres per second. A stroll; villagers are not commuting to a fire. */
const WALK = 1.1;
/** How close counts as arrived. */
const ARRIVE = 1.3;

/** Which model each of the crew wears. Fixed, so nobody changes clothes mid-village. */
const CAST: readonly VillagerModel[] = [
  'Worker_Male',
  'Casual2_Female',
  'Chef_Male',
  'Viking_Male',
  'Worker_Female',
  'OldClassy_Male',
];

type Phase = 'toWork' | 'atWork' | 'toSquare' | 'atSquare' | 'toHome' | 'atHome';

interface Villager {
  body: VillagerBody | null;
  home: VillagePlace | null;
  work: VillagePlace | null;
  phase: Phase;
  /** Seconds left to stand still. */
  dwell: number;
  at: Vector3;
  target: Vector3 | null;
  yaw: number;
  /** Metres per second actually achieved last frame, after collision. */
  speed: number;
  jitter: number;
}

export interface VillagerCrew {
  group: Group;
  /**
   * `night` is 0 by day and 1 at night. `collide` is the world's own pushout, so villagers
   * are stopped by exactly what stops the player.
   */
  update(
    dt: number,
    playerPos: Vector3,
    night: number,
    villages: VillageStreamer,
    collide: (p: Vector3) => void,
    /**
     * The world's own ground height, which includes what the village has paved.
     *
     * Not `surfaceGroundHeightAt`: that is the bare terrain, and a village's decks sit half a
     * metre above it � so villagers walked at terrain level and were buried to the shins in
     * their own square, which is the levitating-and-sinking report.
     */
    floorAt: (x: number, z: number) => number,
  ): void;
  active(): number;
  dispose(): void;
}

export function createVillagers(): VillagerCrew {
  const group = new Group();
  group.name = 'Villagers';

  const crew: Villager[] = CAST.map((_, i) => ({
    body: null,
    home: null,
    work: null,
    phase: 'atHome',
    dwell: 0,
    at: new Vector3(),
    target: null,
    yaw: 0,
    speed: 0,
    jitter: (i * 0.37) % 1,
  }));

  // Bodies arrive asynchronously and the crew simply has none until they do. Requested once,
  // at construction, so the first village the player reaches already has people in it.
  let torndown = false;
  for (let i = 0; i < CREW; i++) {
    void makeVillagerBody(CAST[i % CAST.length]!).then((body) => {
      if (torndown || !body) return;
      body.object.visible = false;
      group.add(body.object);
      crew[i]!.body = body;
    });
  }

  let current: VillageInfo | null = null;
  const step = new Vector3();
  /**
   * The world's ground height, rebound each frame from what `update` is handed.
   *
   * Held rather than threaded through every helper: `assign` and `doorstep` both need it and
   * neither is called from anywhere but `update`, so a binding is simpler than five extra
   * parameters and cannot fall out of step with the frame.
   */
  let ground: (x: number, z: number) => number = () => 0;

  /** Hands the crew to a settlement, standing each one at their own front door. */
  const assign = (info: VillageInfo | null): void => {
    current = info;
    for (let i = 0; i < crew.length; i++) {
      const v = crew[i]!;
      if (!info) {
        v.home = null;
        v.work = null;
        if (v.body) v.body.object.visible = false;
        continue;
      }
      v.home = info.homes.length > 0 ? info.homes[i % info.homes.length]! : info.centre;
      v.work = info.works.length > 0 ? info.works[i % info.works.length]! : info.centre;
      v.at.set(v.home.doorX, v.home.y, v.home.doorZ);
      v.at.y = ground(v.at.x, v.at.z);
      v.phase = 'atHome';
      v.dwell = 1 + i * 0.6;
      v.target = null;
      v.speed = 0;
      if (v.body) v.body.object.visible = true;
    }
  };

  /**
   * The doorstep of a place, with a little scatter so six people do not stand on one point.
   *
   * Always the door, never the middle. A building's middle is behind a wall, and a villager
   * sent there walks into the wall and stops — which is exactly what the first version did.
   */
  const doorstep = (place: VillagePlace, v: Villager, spread: number): Vector3 => {
    const a = v.jitter * Math.PI * 2;
    step.set(place.doorX + Math.cos(a) * spread, place.y, place.doorZ + Math.sin(a) * spread);
    step.y = ground(step.x, step.z);
    return step;
  };

  /** Advances one villager's schedule. Dwell is counted in seconds. */
  const schedule = (v: Villager, dt: number, night: number): void => {
    if (!v.home || !v.work || !current) return;
    if (v.dwell > 0) {
      v.dwell -= dt;
      return;
    }
    switch (v.phase) {
      case 'atHome':
        if (night < 0.35) {
          v.phase = 'toWork';
          v.target = doorstep(v.work, v, 1.8).clone();
        } else {
          v.dwell = 3;
        }
        break;
      case 'toWork':
        v.phase = 'atWork';
        v.dwell = 12 + v.jitter * 10;
        break;
      case 'atWork':
        if (night > 0.3) {
          v.phase = 'toSquare';
          v.target = doorstep(current.centre, v, 3).clone();
        } else {
          // Potter about the workplace rather than standing rigid all day.
          v.phase = 'toWork';
          v.target = doorstep(v.work, v, 1.2 + v.jitter * 2.4).clone();
        }
        break;
      case 'toSquare':
        v.phase = 'atSquare';
        v.dwell = 9 + v.jitter * 7;
        break;
      case 'atSquare':
        v.phase = 'toHome';
        v.target = doorstep(v.home, v, 1.4).clone();
        break;
      case 'toHome':
        v.phase = 'atHome';
        v.dwell = 12;
        break;
    }
  };

  const update = (
    dt: number,
    playerPos: Vector3,
    night: number,
    villages: VillageStreamer,
    collide: (p: Vector3) => void,
    floorAt: (x: number, z: number) => number,
  ): void => {
    const info = villages.nearest(playerPos);
    const inRange =
      info !== null &&
      (info.x - playerPos.x) ** 2 + (info.z - playerPos.z) ** 2 < ACTIVE_RANGE * ACTIVE_RANGE;
    const want = inRange ? info : null;
    ground = floorAt;
    if ((want?.key ?? null) !== (current?.key ?? null)) assign(want);
    if (!current) return;

    for (const v of crew) {
      if (!v.body) continue;
      schedule(v, dt, night);

      let moved = 0;
      if (v.target) {
        const dx = v.target.x - v.at.x;
        const dz = v.target.z - v.at.z;
        const dist = Math.hypot(dx, dz);
        if (dist < ARRIVE) {
          v.target = null;
        } else {
          const wantStep = Math.min(dist, WALK * dt);
          const fromX = v.at.x;
          const fromZ = v.at.z;
          v.at.x += (dx / dist) * wantStep;
          v.at.z += (dz / dist) * wantStep;
          // The world's own pushout, so a villager is stopped by exactly what stops the
          // player — walls, doors, fences and furniture, all through the shared registry.
          collide(v.at);
          v.at.y = ground(v.at.x, v.at.z);
          // How far they *actually* got. A villager pressed against a wall makes no progress,
          // and the animation has to know that or it walks on the spot forever.
          const gotX = v.at.x - fromX;
          const gotZ = v.at.z - fromZ;
          moved = Math.hypot(gotX, gotZ);
          if (moved > 1e-4) {
            const wantYaw = Math.atan2(-gotX, -gotZ);
            let turn = wantYaw - v.yaw;
            while (turn > Math.PI) turn -= Math.PI * 2;
            while (turn < -Math.PI) turn += Math.PI * 2;
            v.yaw += turn * Math.min(1, dt * 5);
          }
          // Blocked: give up on this errand rather than grinding into the obstacle. This is
          // what stops a villager standing in a wall for the rest of the day.
          if (moved < wantStep * 0.25) {
            v.target = null;
            v.dwell = 1.5;
          }
        }
      }

      v.speed = dt > 0 ? moved / dt : 0;
      v.body.object.position.copy(v.at);
      v.body.object.rotation.y = v.yaw;
      v.body.animate(v.speed > 0.15, v.speed, dt);
    }
  };

  const dispose = (): void => {
    torndown = true;
    for (const v of crew) v.body?.dispose();
    crew.length = 0;
    current = null;
  };

  return {
    group,
    update,
    active: () => (current ? crew.filter((v) => v.body).length : 0),
    dispose,
  };
}
