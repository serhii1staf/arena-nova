import { Group, Vector3 } from 'three';
import { makeVillagerBody, type VillagerBody, type VillagerModel } from './VillagerModels.ts';
import { VILLAGE_POPULATION } from './Village.ts';
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
const CREW = VILLAGE_POPULATION;

/** Beyond this the settlement is not worth peopling. Inside the village view distance. */
const ACTIVE_RANGE = 170;

/** Metres per second. A stroll; villagers are not commuting to a fire. */
const WALK = 1.1;
/** How close counts as arrived. */
const ARRIVE = 1.3;
/**
 * How close counts as reaching an intermediate waypoint.
 *
 * Tighter than `ARRIVE`, because the waypoints that matter are doorways: cutting the corner on
 * one leaves the next leg starting from beside the opening instead of square in front of it, and
 * then the villager walks into the wall next to its own door.
 */
const WAYPOINT = 0.55;
/**
 * How far above the feet a surface can be and still be a floor rather than a ceiling.
 *
 * The same value the player uses. Kept here as its own constant rather than imported from the
 * build system, because what it means for a villager is the bound on a height query, not a
 * step-up allowance.
 */
const STEP_UP = 0.65;

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
  /**
   * Remaining legs of the current route, in order.
   *
   * A route rather than a destination is what gets them through doorways: the last leg into a
   * building is aimed from directly outside the door to directly inside it, so the approach is
   * perpendicular to the wall and the one-cell opening is entered square on.
   */
  path: Vector3[];
  yaw: number;
  /** Metres per second actually achieved last frame, after collision. */
  speed: number;
  jitter: number;
  /**
   * Which way round an obstacle this one goes, +1 or −1.
   *
   * Held rather than chosen per frame, because a villager that picks a side afresh every frame
   * oscillates on the spot in front of a corner instead of getting round it.
   */
  avoidSide: number;
  /** Seconds spent making no progress. Used to give up on a genuinely unreachable errand. */
  stuck: number;
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
     * metre above it, so villagers walked at terrain level and were buried to the shins in
     * their own square, which is the levitating-and-sinking report.
     *
     * `fromY` is the bound that says "a surface far above me is a ceiling, not a floor", and
     * leaving it off is why villagers were flung onto the roof at their own front door. The
     * world has taken it since 0.36 and the player has passed it since 0.38; this signature
     * simply never did, so every villager query answered "the highest surface in this column",
     * which one step inside a doorway is the roof.
     */
    floorAt: (x: number, z: number, fromY?: number) => number,
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
    path: [],
    yaw: 0,
    speed: 0,
    jitter: (i * 0.37) % 1,
    avoidSide: i % 2 === 0 ? 1 : -1,
    stuck: 0,
  }));

  // Bodies arrive asynchronously and the crew simply has none until they do. Requested once,
  // at construction, so the first village the player reaches already has people in it.
  let torndown = false;
  for (let i = 0; i < CREW; i++) {
    void makeVillagerBody(CAST[i % CAST.length]!).then((body) => {
      if (torndown || !body) return;
      group.add(body.object);
      const v = crew[i]!;
      v.body = body;
      /**
       * Visible if there is already a settlement to be in.
       *
       * This is the bug that made villagers stand about as invisible statues and the livestock
       * disappear entirely. Bodies arrive over the network, `assign` runs the moment the player
       * comes within range of a village, and the two race — so when a body landed *after* the
       * assignment, it was created hidden and nothing ever showed it again. Its schedule ran,
       * it walked its rounds, and none of it could be seen.
       */
      body.object.visible = current !== null;
      body.object.position.copy(v.at);
      body.object.rotation.y = v.yaw;
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
  let ground: (x: number, z: number, fromY?: number) => number = () => 0;

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
      /**
       * One villager per house until the houses run out, then two, and so on.
       *
       * `i % homes.length` looks like it does this and does not: with six villagers and four
       * homes it gives 0,1,2,3,0,1 — which is the same distribution, but it also gave *every*
       * villager the same workplace whenever there was one workplace, so they all converged on
       * it and stood in a heap. Spreading the work assignment by a different stride keeps them
       * apart.
       */
      v.home = info.homes.length > 0 ? info.homes[i % info.homes.length]! : info.centre;
      v.work =
        info.works.length > 0
          ? info.works[(i * 3 + 1) % info.works.length]!
          : info.homes.length > 0
            ? info.homes[(i + 1) % info.homes.length]!
            : info.centre;
      v.at.set(v.home.doorX, v.home.y, v.home.doorZ);
      // Bounded from the pad's own level: they are being stood on their doorstep, outdoors, and
      // an unbounded query there can find the eaves overhead.
      v.at.y = ground(v.at.x, v.at.z, v.home.y + STEP_UP);
      v.phase = 'atHome';
      v.dwell = 1 + i * 0.6;
      v.target = null;
      v.path.length = 0;
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
    step.y = ground(step.x, step.z, place.y + STEP_UP);
    return step;
  };

  /**
   * Sets a route rather than a single destination.
   *
   * Waypoints are consumed in order, and this is what lets a villager actually get through a
   * door. A doorway is a hole one cell wide in a wall four metres long; steering straight at
   * something on the far side of it only passes through when the approach happens to line up,
   * and any other angle ends with a villager grinding along the wall beside the opening. Which
   * is what "they stand at the door and just can't go in" was.
   *
   * A route of "outside the door, then just inside it" makes the last leg perpendicular to the
   * wall by construction, so the doorway is entered square on.
   */
  const route = (v: Villager, points: Vector3[]): void => {
    v.path.length = 0;
    for (const p of points) v.path.push(p.clone());
    v.target = v.path.shift() ?? null;
    v.stuck = 0;
  };

  /** A point on the ground at a place, bounded so a roof is never mistaken for a floor. */
  const spot = (x: number, z: number, fromY: number): Vector3 =>
    step.set(x, ground(x, z, fromY + STEP_UP), z);

  /**
   * The way into a building: stand at the door, then step through it.
   *
   * The scatter is applied to the *outside* waypoint only. Inside is a doorway, and six people
   * aiming at six slightly different points in a one-cell gap is how you get a jam in it.
   */
  const routeIndoors = (v: Villager, place: VillagePlace, spread: number): void => {
    const outside = doorstep(place, v, spread).clone();
    const inside = spot(place.insideX, place.insideZ, place.y).clone();
    route(v, [outside, inside]);
  };

  /**
   * The way upstairs: in through the door, over to the foot of the stairs, then up them.
   *
   * There is no climbing here and none is needed. The staircase piece presents a continuous
   * ramp, and the ground query returns its surface, so walking horizontally across that cell
   * carries a villager up it — the same way it carries the player. What was missing was any
   * reason to walk over that cell at all, so they never went up. Three waypoints supply one.
   */
  const routeUpstairs = (v: Villager, place: VillagePlace): boolean => {
    const { stairFootX, stairFootZ, stairTopX, stairTopZ, upperY } = place;
    if (
      stairFootX === null ||
      stairFootZ === null ||
      stairTopX === null ||
      stairTopZ === null ||
      upperY === null
    ) {
      return false;
    }
    const outside = doorstep(place, v, 1.4).clone();
    const inside = spot(place.insideX, place.insideZ, place.y).clone();
    // The foot of the flight, on the ground, then the head of it at the upper deck. The two ends
    // come from the village, which knows which way the flight runs.
    const foot = spot(stairFootX, stairFootZ, place.y).clone();
    const top = new Vector3(stairTopX, upperY, stairTopZ);
    // And off the stairs into the room, or they stand on the top step against the wall. Stepped
    // towards the building's middle, which from a corner cell is always inward.
    const inward = new Vector3(place.x - stairTopX, 0, place.z - stairTopZ);
    if (inward.lengthSq() < 1e-4) inward.set(-1, 0, 0);
    inward.normalize().multiplyScalar(3.4);
    const landing = new Vector3(stairTopX + inward.x, upperY, stairTopZ + inward.z);
    route(v, [outside, inside, foot, top, landing]);
    return true;
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
          // Out of the house and off to work. Leaving is a route too: from inside, the way out
          // is back through the same doorway, and aiming straight at a workplace across the
          // village from an armchair means aiming at the inside of your own wall.
          v.phase = 'toWork';
          route(v, [
            spot(v.home.insideX, v.home.insideZ, v.home.y).clone(),
            doorstep(v.home, v, 1.6).clone(),
            doorstep(v.work, v, 1.8).clone(),
          ]);
        } else {
          v.dwell = 3;
        }
        break;
      case 'toWork':
        // Work happens indoors. A forge with nobody in it and a smith standing in the road
        // outside it was the whole of "they just stand there".
        v.phase = 'atWork';
        routeIndoors(v, v.work, 1.6);
        v.dwell = 12 + v.jitter * 10;
        break;
      case 'atWork':
        if (night > 0.3) {
          v.phase = 'toSquare';
          route(v, [
            spot(v.work.insideX, v.work.insideZ, v.work.y).clone(),
            doorstep(v.work, v, 1.6).clone(),
            doorstep(current.centre, v, 3).clone(),
          ]);
        } else {
          // Potter about the workplace rather than standing rigid all day, and go up if there
          // is an upstairs to go up to.
          v.phase = 'toWork';
          if (v.jitter > 0.55 && routeUpstairs(v, v.work)) break;
          routeIndoors(v, v.work, 1.2 + v.jitter * 2.4);
        }
        break;
      case 'toSquare':
        v.phase = 'atSquare';
        v.dwell = 9 + v.jitter * 7;
        break;
      case 'atSquare':
        // Home for the night, and *into* the house — up to a bed where the house has one
        // upstairs, otherwise in through the door and no further.
        v.phase = 'toHome';
        if (!routeUpstairs(v, v.home)) routeIndoors(v, v.home, 1.4);
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
    floorAt: (x: number, z: number, fromY?: number) => number,
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
        // Arrived at this waypoint: take the next leg of the route, if there is one. A doorway
        // waypoint has to be reached closely or the "inside" leg starts from beside the opening
        // rather than in front of it, so the tolerance is tighter than the old single-target one.
        if (dist < (v.path.length > 0 ? WAYPOINT : ARRIVE)) {
          v.target = v.path.shift() ?? null;
          v.stuck = 0;
        } else {
          const wantStep = Math.min(dist, WALK * dt);
          const fromX = v.at.x;
          const fromZ = v.at.z;
          const ux = dx / dist;
          const uz = dz / dist;

          /**
           * Walk round obstacles instead of giving up in front of them.
           *
           * This is the "villagers are brainless, they just stand there staring at a wall"
           * report, and the cause was the old blocked-handler: the first frame a villager
           * brushed anything — a fence post, a planter, the corner of a house on the way to its
           * own door — the errand was abandoned. The scheduler then handed back a target in the
           * same direction, so it walked into the same corner again, forever. From outside that
           * looks exactly like standing still facing a wall.
           *
           * Instead: try straight on, then progressively deflected headings to one side and the
           * other, and take the first that actually makes progress. That is enough to slide
           * along a wall and round a corner, which is most of what looks like navigation. The
           * side is remembered so it commits to going one way round rather than dithering in
           * the middle, and the errand is only abandoned after being stuck for a real couple of
           * seconds rather than a single frame.
           *
           * Honest about what this is not: there is still no path planning. A villager whose
           * door is round the far side of the building will feel its way there along the wall
           * rather than setting off in the right direction, and a genuine dead end still ends
           * in giving up. It is local steering, not a route.
           */
          const side = v.avoidSide;
          const DEFLECT = [0, side * 0.55, -side * 0.55, side * 1.15, -side * 1.15, side * 1.9];
          for (const a of DEFLECT) {
            const c = Math.cos(a);
            const s = Math.sin(a);
            v.at.x = fromX + (ux * c - uz * s) * wantStep;
            v.at.z = fromZ + (ux * s + uz * c) * wantStep;
            // The world's own pushout, so a villager is stopped by exactly what stops the
            // player — walls, doors, fences and furniture.
            collide(v.at);
            moved = Math.hypot(v.at.x - fromX, v.at.z - fromZ);
            if (moved > wantStep * 0.5) break;
            v.at.x = fromX;
            v.at.z = fromZ;
            moved = 0;
          }
          /**
           * Bounded, and this is the fix for villagers being flung onto the roof at their own
           * front door.
           *
           * Unbounded, this query means "the highest surface in this column", and one step
           * inside a doorway that is the roof. So a villager reaching its door was lifted four
           * metres, walked off the eaves, fell back down and tried again — which is exactly what
           * was described. The bound says a surface more than a step above the feet is a
           * ceiling. The world has accepted it since 0.36; villagers were never passing it.
           *
           * Measured from the *previous* height rather than the target's, so climbing a
           * staircase works: each frame the feet rise by at most a step, and the next frame's
           * bound rises with them.
           */
          const wasY = v.at.y;
          v.at.y = ground(v.at.x, v.at.z, wasY);

          const gotX = v.at.x - fromX;
          const gotZ = v.at.z - fromZ;
          if (moved > 1e-4) {
            const wantYaw = Math.atan2(-gotX, -gotZ);
            let turn = wantYaw - v.yaw;
            while (turn > Math.PI) turn -= Math.PI * 2;
            while (turn < -Math.PI) turn += Math.PI * 2;
            v.yaw += turn * Math.min(1, dt * 5);
            v.stuck = Math.max(0, v.stuck - dt);
          } else {
            // Nothing worked from here. Count it, swap the side being tried, and only abandon
            // the errand once it has been hopeless for a couple of seconds.
            v.stuck += dt;
            if (v.stuck > 0.6) v.avoidSide = -v.avoidSide;
            if (v.stuck > 2.4) {
              v.target = null;
              // The rest of the route goes with it: the legs after a doorway assume you got
              // through the doorway, and walking them from outside means walking at a wall.
              v.path.length = 0;
              v.dwell = 1.2;
              v.stuck = 0;
            }
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
