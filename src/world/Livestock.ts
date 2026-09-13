import { Group, Vector3 } from 'three';
import { makeVillagerBody, type VillagerBody, type VillagerModel } from './VillagerModels.ts';
import type { VillageInfo, VillageStreamer } from './Village.ts';

/**
 * Livestock
 * ---------
 * The animals that belong to a settlement.
 *
 * This replaces a set of procedural ones — boxes and spheres for a hen, a sheep and a cow — and
 * the replacement is an admission. They were reported as pale, undetailed blobs that hopped
 * and slid through walls, and that was accurate: they had no articulation, so the only thing
 * standing in for legs was a four-centimetre bob, and nothing consulted collision. Rather than
 * keep polishing shapes that were never going to read as animals, they use the authored pack —
 * which contains a rigged, animated cow and dog.
 *
 * The honest cost of that decision: there is no hen and no sheep in the pack, so there are no
 * hens and no sheep. Two species that look and move correctly beat five that do not, and a
 * pale box on legs is worse than an empty field.
 *
 * A fixed cast reassigned to whichever settlement the player is in, exactly as the villagers
 * are, so a world of two hundred villages costs what one does.
 */

/** Beyond this a settlement's animals are not worth simulating. */
const ACTIVE_RANGE = 170;
/**
 * How far above the feet a surface can be and still be a floor rather than a ceiling.
 *
 * Bounds every ground query. Without it the query answers "the highest surface in this column",
 * so an animal that wandered under the eaves of a barn was stood on the barn.
 */
const STEP_UP = 0.65;

interface Head {
  model: VillagerModel;
  /** How many a settlement keeps. */
  count: number;
  /** Metres per second when it bothers. */
  speed: number;
  /** How far from its own patch it strays. */
  range: number;
  /** Which way round the patch sits from the village centre. */
  bearing: number;
}

/**
 * Two cows and a dog.
 *
 * Deliberately few. Each is a skinned mesh with its own `AnimationMixer` — the same cost as a
 * villager — so a paddock of twenty would double the settlement's character budget for
 * scenery. Three animals read as a smallholding; twenty would read as a frame rate.
 */
const HEADS: readonly Head[] = [
  { model: 'Cow', count: 2, speed: 0.42, range: 7, bearing: 0.7 },
  { model: 'Pug', count: 1, speed: 0.85, range: 11, bearing: 2.6 },
];

interface Animal {
  body: VillagerBody | null;
  head: Head;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** The patch it keeps to. */
  hx: number;
  hz: number;
  tx: number | null;
  tz: number;
  wait: number;
  speed: number;
}

export interface LivestockHerd {
  group: Group;
  update(
    dt: number,
    playerPos: Vector3,
    villages: VillageStreamer,
    collide: (p: Vector3) => void,
    /** The world's ground, decks included � not the bare terrain under them. */
    floorAt: (x: number, z: number, fromY?: number) => number,
  ): void;
  count(): number;
  dispose(): void;
}

export function createLivestock(): LivestockHerd {
  const group = new Group();
  group.name = 'Livestock';

  const animals: Animal[] = [];
  for (const head of HEADS) {
    for (let i = 0; i < head.count; i++) {
      animals.push({
        body: null,
        head,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        hx: 0,
        hz: 0,
        tx: null,
        tz: 0,
        wait: 0,
        speed: 0,
      });
    }
  }

  let torndown = false;
  for (const an of animals) {
    void makeVillagerBody(an.head.model).then((body) => {
      if (torndown || !body) return;
      group.add(body.object);
      an.body = body;
      // Visible if a settlement is already assigned. Created hidden and never shown again is
      // why the animals could not be found at all — see the villagers for the same race.
      body.object.visible = current !== null;
      body.object.position.set(an.x, an.y, an.z);
    });
  }

  let current: VillageInfo | null = null;
  const scratch = new Vector3();
  /** Rebound each frame from what `update` is handed; see the villagers for why. */
  let ground: (x: number, z: number, fromY?: number) => number = () => 0;

  /** Puts the animals in a settlement, each species in its own patch. */
  const assign = (info: VillageInfo | null): void => {
    current = info;
    let lastHead: Head | null = null;
    let inHead = 0;
    for (const an of animals) {
      if (an.head !== lastHead) {
        lastHead = an.head;
        inHead = 0;
      }
      if (!info) {
        if (an.body) an.body.object.visible = false;
        continue;
      }
      // Patches sit outside the built-up middle but well inside the levelled pad.
      const rad = Math.min(info.radius * 0.55, 26);
      const px = info.x + Math.cos(an.head.bearing) * rad;
      const pz = info.z + Math.sin(an.head.bearing) * rad;
      const spread = (inHead / Math.max(1, an.head.count)) * Math.PI * 2;
      an.hx = px;
      an.hz = pz;
      an.x = px + Math.cos(spread) * an.head.range * 0.4;
      an.z = pz + Math.sin(spread) * an.head.range * 0.4;
      // Bounded by the paddock's own level: an unbounded query in a village finds roofs, and
      // livestock were being stood on them exactly as the villagers were.
      an.y = ground(an.x, an.z, info.y + STEP_UP);
      an.yaw = spread;
      an.tx = null;
      an.wait = 1 + inHead;
      if (an.body) an.body.object.visible = true;
      inHead++;
    }
  };

  const update = (
    dt: number,
    playerPos: Vector3,
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

    for (const an of animals) {
      if (!an.body) continue;
      let moved = 0;
      if (an.tx === null) {
        an.wait -= dt;
        if (an.wait <= 0) {
          // Somewhere else within its own patch. Chosen relative to the patch centre rather
          // than to the animal, because a pure random walk drifts out of the field over time.
          const a = Math.random() * Math.PI * 2;
          const r = Math.random() * an.head.range;
          an.tx = an.hx + Math.cos(a) * r;
          an.tz = an.hz + Math.sin(a) * r;
        }
      } else {
        const dx = an.tx - an.x;
        const dz = an.tz - an.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.3) {
          an.tx = null;
          an.wait = 2 + Math.random() * 6;
        } else {
          const wantStep = Math.min(d, an.head.speed * dt);
          const fromX = an.x;
          const fromZ = an.z;
          an.x += (dx / d) * wantStep;
          an.z += (dz / d) * wantStep;
          // Stopped by the same things that stop the player. Without this they walked through
          // fences and house walls, which is half of what was wrong with the last set.
          scratch.set(an.x, an.y, an.z);
          collide(scratch);
          an.x = scratch.x;
          an.z = scratch.z;
          an.y = ground(an.x, an.z, an.y + STEP_UP);
          moved = Math.hypot(an.x - fromX, an.z - fromZ);
          if (moved > 1e-4) {
            const wantYaw = Math.atan2(-(an.x - fromX), -(an.z - fromZ));
            let turn = wantYaw - an.yaw;
            while (turn > Math.PI) turn -= Math.PI * 2;
            while (turn < -Math.PI) turn += Math.PI * 2;
            an.yaw += turn * Math.min(1, dt * 3);
          }
          // Give up rather than grind into whatever is in the way.
          if (moved < wantStep * 0.25) {
            an.tx = null;
            an.wait = 2;
          }
        }
      }
      an.speed = dt > 0 ? moved / dt : 0;
      an.body.object.position.set(an.x, an.y, an.z);
      an.body.object.rotation.y = an.yaw;
      an.body.animate(an.speed > 0.08, Math.max(an.speed, 0.5), dt);
    }
  };

  const dispose = (): void => {
    torndown = true;
    for (const an of animals) an.body?.dispose();
    animals.length = 0;
    current = null;
  };

  return {
    group,
    update,
    count: () => (current ? animals.filter((a) => a.body).length : 0),
    dispose,
  };
}
