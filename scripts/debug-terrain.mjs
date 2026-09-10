// Measures the shape of the open world and then looks at it.
//
// Two halves, because neither one alone is worth much:
//
//  1. A numeric census of the *drawn* surface. It imports `WorldGen.ts`
//     directly — the same module the game runs — and samples `surfaceHeightAt`
//     on the 8 m lattice, so the numbers describe the triangles the player
//     actually stands on rather than an idealised curve. Reports the elevation
//     distribution, how much of the map clears the snow line, how much is
//     steeper than the controller can hold, local relief, and the biome census.
//
//  2. Screenshots from several vantage points, so the shape can be judged by
//     eye. Numbers on this project have passed while the world looked wrong
//     (props rendered solid black and every budget was still green), so a
//     terrain probe that only prints statistics proves nothing about whether it
//     reads as mountains.
//
// Usage:
//   node scripts/debug-terrain.mjs [url] [--stats]
//     --stats  census only, no browser (fast, no preview server needed)
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SURFACE_STEP,
  WORLD,
  surfaceBiomeAt,
  surfaceHeightAt,
  surfaceSlopeAt,
  resetSurfaceCache,
} from '../src/world/WorldGen.ts';
import { waterfallSitesInChunk, WATERFALL_CHUNK } from '../src/world/WaterfallSites.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const statsOnly = args.includes('--stats');
const url = args.find((a) => a.startsWith('http')) ?? 'http://localhost:4173';

/**
 * Steepest ground the player can walk down without losing contact.
 * `groundSnapSlope` is 1.6 (see GameConfig.player), i.e. about 58°.
 */
const WALK_LIMIT = 1.6;
/** Sample spacing. A multiple of SURFACE_STEP, so every sample is a lattice point. */
const STEP = 24;
/** Side of the block used for the local-relief measure, in metres. */
const RELIEF_BLOCK = 240;

// ---------------------------------------------------------------------------
// 1. Census
// ---------------------------------------------------------------------------

function census() {
  const half = WORLD.halfSize;
  const heights = [];
  const landHeights = [];
  const biomes = new Map();
  let steep = 0;
  let landSamples = 0;
  let aboveSnow = 0;
  let aboveTree = 0;
  let total = 0;
  let sumAll = 0;
  let sumLand = 0;
  let slopeSum = 0;

  // Local relief per block, which is what actually reads as "dramatic": the
  // spread of heights inside a few hundred metres, not the global range.
  const blocks = new Map();

  for (let z = -half; z <= half; z += STEP) {
    for (let x = -half; x <= half; x += STEP) {
      const h = surfaceHeightAt(x, z);
      total++;
      sumAll += h;
      heights.push(h);

      const bk = `${Math.floor(x / RELIEF_BLOCK)}|${Math.floor(z / RELIEF_BLOCK)}`;
      let b = blocks.get(bk);
      if (!b) blocks.set(bk, (b = { lo: h, hi: h }));
      else {
        if (h < b.lo) b.lo = h;
        if (h > b.hi) b.hi = h;
      }

      if (h <= WORLD.waterLevel) continue;
      landSamples++;
      sumLand += h;
      landHeights.push(h);
      if (h > WORLD.snowLine) aboveSnow++;
      if (h > WORLD.treeLine) aboveTree++;
      const s = surfaceSlopeAt(x, z);
      slopeSum += s;
      if (s > WALK_LIMIT) steep++;
      const b2 = surfaceBiomeAt(x, z);
      biomes.set(b2, (biomes.get(b2) ?? 0) + 1);
    }
  }

  heights.sort((a, b) => a - b);
  landHeights.sort((a, b) => a - b);
  const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);

  const reliefs = [...blocks.values()].map((b) => b.hi - b.lo).sort((a, b) => a - b);

  // Elevation bands over land, so the shape of the hypsometric curve is visible.
  const bands = [
    [WORLD.waterLevel, 30],
    [30, 60],
    [60, 100],
    [100, 150],
    [150, 200],
    [200, 260],
    [260, 320],
    [320, Infinity],
  ].map(([lo, hi]) => ({
    lo,
    hi,
    n: landHeights.filter((h) => h >= lo && h < hi).length,
  }));

  return {
    step: STEP,
    samples: total,
    lattice: SURFACE_STEP,
    thresholds: {
      waterLevel: WORLD.waterLevel,
      treeLine: WORLD.treeLine,
      snowLine: WORLD.snowLine,
      walkLimitGrade: WALK_LIMIT,
    },
    all: {
      min: +heights[0].toFixed(1),
      max: +heights[heights.length - 1].toFixed(1),
      mean: +(sumAll / total).toFixed(1),
      median: +q(heights, 0.5).toFixed(1),
    },
    land: {
      fraction: +(landSamples / total).toFixed(3),
      min: +(landHeights[0] ?? 0).toFixed(1),
      max: +(landHeights[landHeights.length - 1] ?? 0).toFixed(1),
      mean: +(sumLand / Math.max(1, landSamples)).toFixed(1),
      median: +q(landHeights, 0.5).toFixed(1),
      p90: +q(landHeights, 0.9).toFixed(1),
      p99: +q(landHeights, 0.99).toFixed(1),
    },
    aboveSnowLine: +((aboveSnow / Math.max(1, landSamples)) * 100).toFixed(2),
    aboveTreeLine: +((aboveTree / Math.max(1, landSamples)) * 100).toFixed(2),
    steeperThanWalkable: +((steep / Math.max(1, landSamples)) * 100).toFixed(2),
    meanGrade: +(slopeSum / Math.max(1, landSamples)).toFixed(3),
    relief: {
      block: RELIEF_BLOCK,
      mean: +(reliefs.reduce((a, b) => a + b, 0) / Math.max(1, reliefs.length)).toFixed(1),
      median: +q(reliefs, 0.5).toFixed(1),
      p90: +q(reliefs, 0.9).toFixed(1),
      max: +(reliefs[reliefs.length - 1] ?? 0).toFixed(1),
    },
    bands: bands.map((b) => ({
      band: `${b.lo}..${b.hi === Infinity ? '+' : b.hi} m`,
      pct: +((b.n / Math.max(1, landSamples)) * 100).toFixed(2),
    })),
    biomes: [...biomes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => ({ id, pct: +((n / Math.max(1, landSamples)) * 100).toFixed(2) })),
    distinctBiomes: biomes.size,
  };
}

/** Where the rivers fall, counted over the whole map. */
function waterfallCensus() {
  const cells = Math.ceil(WORLD.halfSize / WATERFALL_CHUNK);
  const falls = [];
  for (let cz = -cells; cz <= cells; cz++) {
    for (let cx = -cells; cx <= cells; cx++) {
      for (const s of waterfallSitesInChunk(cx, cz)) falls.push(s);
    }
  }
  falls.sort((a, b) => b.drop - a.drop);
  const drops = falls.map((f) => f.drop).sort((a, b) => a - b);
  return {
    count: falls.length,
    drop: {
      min: +(drops[0] ?? 0).toFixed(1),
      median: +(drops[Math.floor(drops.length * 0.5)] ?? 0).toFixed(1),
      max: +(drops[drops.length - 1] ?? 0).toFixed(1),
    },
    tallest: falls.slice(0, 6).map((f) => ({
      x: Math.round(f.x),
      z: Math.round(f.z),
      drop: +f.drop.toFixed(1),
      width: +f.width.toFixed(1),
      topY: +f.topY.toFixed(1),
    })),
  };
}

/**
 * Picks vantage points to photograph, derived from the terrain itself rather than
 * hard-coded: a screenshot of a spot chosen by hand stops meaning anything the
 * moment the generator changes.
 *
 * Everything is kept inside the streamed radius (4 chunks ≈ 1.2 km) of the point
 * it is looking at, because terrain further out than that simply does not exist.
 */
function vantages() {
  const reach = 1400;
  let peak = null;
  let gorge = null;
  for (let z = -reach; z <= reach; z += STEP) {
    for (let x = -reach; x <= reach; x += STEP) {
      const h = surfaceHeightAt(x, z);
      if (!peak || h > peak.h) peak = { x, z, h };
      const d = Math.hypot(x, z);
      if (d > 500 && d < reach && h > WORLD.waterLevel + 2 && (!gorge || h < gorge.h)) {
        gorge = { x, z, h };
      }
    }
  }

  const shots = [];

  // Standing at spawn, looking at the highest thing in sight.
  shots.push({
    name: 'spawn_outward',
    from: { x: 0, z: 12 },
    look: peak,
    note: 'from the spawn plaza toward the tallest peak within reach',
  });

  // Far enough back that the whole massif fits in frame, roughly 3× its height,
  // and aimed at its shoulder rather than its tip so the flanks are in shot.
  const backOff = Math.max(420, Math.min(950, (peak.h - 40) * 2.6));
  const ang = Math.atan2(peak.z, peak.x) || 0;
  const profileFrom = {
    x: peak.x - Math.cos(ang) * backOff,
    z: peak.z - Math.sin(ang) * backOff,
  };
  shots.push({
    name: 'range_profile',
    from: profileFrom,
    look: { x: peak.x, z: peak.z, h: peak.h * 0.62 },
    note: `the range in profile from ${Math.round(backOff)} m out`,
  });
  // The same view from above the treetops. A camera at eye height in long grass
  // spends half the frame on the grass, which tells you nothing about the shape
  // of the land behind it.
  shots.push({
    name: 'range_aerial',
    from: profileFrom,
    look: { x: peak.x, z: peak.z, h: peak.h * 0.55 },
    lift: 110,
    note: 'the same range from 110 m up, so the whole profile is in frame',
  });

  // On the summit, looking back down the way we came.
  shots.push({
    name: 'summit_down',
    from: { x: peak.x, z: peak.z },
    look: { x: peak.x * 0.35, z: peak.z * 0.35, h: 20 },
    note: 'from the summit, down into the valley',
  });

  // The deepest ground we found, looking up and out of it.
  if (gorge) {
    shots.push({
      name: 'valley_floor',
      from: { x: gorge.x, z: gorge.z },
      look: peak,
      note: 'from the lowest land nearby, looking up',
    });
  }

  // The tallest waterfall, seen from below.
  const falls = [];
  const cells = Math.ceil(1600 / WATERFALL_CHUNK);
  for (let cz = -cells; cz <= cells; cz++) {
    for (let cx = -cells; cx <= cells; cx++) {
      for (const s of waterfallSitesInChunk(cx, cz)) falls.push(s);
    }
  }
  falls.sort((a, b) => b.drop - a.drop);
  const fall = falls[0];
  if (fall) {
    // In front of the fall, looking back at the sheet.
    //
    // Two things about this placement are easy to get wrong and both produce a
    // screenshot with no waterfall in it, which then passes.
    //
    // `heading` is the *downhill* flow direction, so the camera belongs
    // downstream of the plunge pool, at pool + heading. Offsetting from the lip
    // along -heading — the arithmetic that reads correctly — parks the camera on
    // the plateau above the fall, an arm's length from the back of the sheet.
    //
    // And the height cannot be left to the ground. A fall exists because the
    // land drops away, and it goes on dropping downstream: walking back far
    // enough to frame an 88 m fall puts the ground under the camera some 75 m
    // *below* the plunge pool, so the whole fall sits above the top of the
    // frame as a smudge on a distant mountain. So the camera is lifted to the
    // lower third of the sheet, for the same reason `range_aerial` is lifted
    // over the treetops.
    const dist = Math.min(160, Math.max(45, fall.drop * 1.1));
    const from = {
      x: fall.bottomX + Math.sin(fall.heading) * dist,
      z: fall.bottomZ + Math.cos(fall.heading) * dist,
    };
    const eyeTarget = fall.bottomY + fall.drop * 0.4;
    const lift = Math.max(0, eyeTarget - (surfaceHeightAt(from.x, from.z) + 1.7));
    shots.push({
      name: 'waterfall',
      from,
      // Centred on the sheet itself, which hangs between the lip and the pool.
      look: {
        x: (fall.x + fall.bottomX) / 2,
        z: (fall.z + fall.bottomZ) / 2,
        h: fall.bottomY + fall.drop * 0.5,
      },
      lift,
      note: `${fall.drop.toFixed(0)} m fall at (${Math.round(fall.x)}, ${Math.round(fall.z)}), from ${Math.round(dist)} m downstream${lift > 1 ? ` and ${Math.round(lift)} m up` : ''}`,
    });
  }

  return { peak, gorge, shots };
}

console.log('=== TERRAIN CENSUS ===');
const report = census();
console.log(JSON.stringify(report, null, 2));
resetSurfaceCache();
console.log('=== WATERFALLS ===');
const water = waterfallCensus();
console.log(JSON.stringify(water, null, 2));
resetSurfaceCache();
const plan = vantages();
console.log('=== VANTAGE POINTS ===');
for (const s of plan.shots) {
  console.log(
    ` ${s.name.padEnd(14)} from (${Math.round(s.from.x)}, ${Math.round(s.from.z)}) — ${s.note}`,
  );
}
resetSurfaceCache();

// Judgements. These are about shape, not taste: a landscape with 20 m of relief
// per quarter-kilometre is flat whatever it is textured with.
const dramatic = report.relief.p90 > 90;
const tall = report.land.max > 260;
const snowy = report.aboveSnowLine > 0.4 && report.aboveSnowLine < 14;
const bare = report.aboveTreeLine > 1.2;
const walkable = report.steeperThanWalkable < 12;
const varied = report.distinctBiomes >= 6;
const falls = water.count > 0;

console.log('\n=== SHAPE ===');
console.log(`relief p90 > 90 m/${RELIEF_BLOCK}m:  ${dramatic ? 'ok' : 'FAIL'} (${report.relief.p90} m)`);
console.log(`peaks above 260 m:          ${tall ? 'ok' : 'FAIL'} (${report.land.max} m)`);
console.log(`snow on 0.4..14% of land:   ${snowy ? 'ok' : 'FAIL'} (${report.aboveSnowLine}%)`);
console.log(`bare rock above tree line:  ${bare ? 'ok' : 'FAIL'} (${report.aboveTreeLine}%)`);
console.log(`unwalkable land under 12%:  ${walkable ? 'ok' : 'FAIL'} (${report.steeperThanWalkable}%)`);
console.log(`at least 6 biomes:          ${varied ? 'ok' : 'FAIL'} (${report.distinctBiomes})`);
console.log(`waterfalls exist:           ${falls ? 'ok' : 'FAIL'} (${water.count})`);

let ok = dramatic && tall && snowy && bare && walkable && varied && falls;

if (statsOnly) {
  console.log('\nRESULT:', ok ? 'PASS (census only)' : 'FAIL (census only)');
  process.exitCode = ok ? 0 : 1;
} else {
  // -------------------------------------------------------------------------
  // 2. Look at it
  // -------------------------------------------------------------------------
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(300000);
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/AudioContext|audio device|Pointer Lock/i.test(m.text())) {
        errors.push(m.text());
      }
    });

    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const b = document.getElementById('btnPlay');
      return !!b && !b.disabled;
    });
    await page.click('#btnPlay');
    await page.evaluate(() => window.arena.engine.requestScene('exterior'));
    await page.waitForFunction(
      () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene,
      { timeout: 300000 },
    );

    // Software GL runs at a few frames a second, so every wait here is on state.
    const settle = async () => {
      await page.waitForFunction(
        () => {
          const s = window.arena.scene.worldStats();
          return s.pending === 0;
        },
        { timeout: 300000 },
      );
      // A couple of rendered frames after the queue drains, so the last chunk
      // built is actually in the picture.
      await page.evaluate(
        () =>
          new Promise((r) => {
            let n = 0;
            const tick = () => (++n > 3 ? r() : requestAnimationFrame(tick));
            requestAnimationFrame(tick);
          }),
      );
    };

    /** Frames the camera by hand, which the player controller cannot do. */
    const aim = async (shot) => {
      await page.evaluate((s) => {
        const sc = window.arena.scene;
        const yaw = Math.atan2(s.from.x - s.look.x, s.from.z - s.look.z);
        sc.player.spawn(s.from.x, s.from.z, yaw);
        sc.setCameraZoom(0);
        window.__shot = s;
      }, shot);
      await settle();
      // Take the camera off the controller so it can look up and down: the probe
      // has no way to drive pitch through the input layer, and a level camera
      // cannot see either a summit or the foot of a waterfall.
      await page.evaluate(() => {
        const sc = window.arena.scene;
        const s = window.__shot;
        const cam = sc.camera;
        const p = sc.player;
        if (!window.__freed) {
          window.__freed = true;
          p.render = () => {
            const shot = window.__shot;
            const eye =
              sc.world.floorHeightAt(shot.from.x, shot.from.z) + 1.7 + (shot.lift ?? 0);
            cam.position.set(shot.from.x, eye, shot.from.z);
            cam.lookAt(shot.look.x, shot.look.h, shot.look.z);
          };
        }
      });
      await page.evaluate(
        () =>
          new Promise((r) => {
            let n = 0;
            const tick = () => (++n > 4 ? r() : requestAnimationFrame(tick));
            requestAnimationFrame(tick);
          }),
      );
      const path = join(here, `terrain_${shot.name}.png`);
      await page.screenshot({ path });
      return path;
    };

    console.log('\n=== SCREENSHOTS ===');
    for (const shot of plan.shots) {
      const path = await aim(shot);
      const seen = await page.evaluate(() => {
        const eng = window.arena.engine;
        const info = eng.renderer.info.render;
        const s = window.arena.scene.worldStats();
        return { draws: info.calls, tris: info.triangles, chunks: s.chunks, biome: s.biome };
      });
      console.log(
        ` ${shot.name.padEnd(14)} ${path.split(/[\\/]/).pop()} — draws=${seen.draws} tris=${(seen.tris / 1000).toFixed(0)}k chunks=${seen.chunks} biome=${seen.biome}`,
      );
    }

    console.log(`errors: ${errors.length}`);
    for (const e of errors.slice(0, 6)) console.log(' ', e);
    ok = ok && errors.length === 0;
    console.log('\nRESULT:', ok ? 'PASS' : 'FAIL');
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}
