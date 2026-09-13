/**
 * Grass density probe.
 *
 * Deliberately small. The build probe places a hundred pieces and renders hundreds of
 * frames; this loads the world once, walks a few metres so the streamer has to do its job,
 * and then counts. It exists because "the grass looks like scattered weeds" is a claim about
 * *spacing*, and spacing is measurable — the number of things growing per square metre, and
 * the distance from a point on the ground to the nearest one.
 */
import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.ARENA_URL ?? 'https://arena-nova.odi44972.workers.dev';
const room = `grass-${Math.random().toString(36).slice(2, 9)}`;

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const errors = [];
try {
  console.log('=== GRASS PROBE ===');
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 620 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', (e) => {
    // A headless browser refuses pointer lock without a user gesture. Expected, unrelated,
    // and the same thing every other probe here filters out.
    if (/Pointer Lock/i.test(e.message)) return;
    errors.push(`pageerror: ${e.message}`);
  });

  /** Polled from this process, never with an in-page waiter. */
  const until = async (fn, ms, what) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await page.evaluate(fn)) return true;
      await page.waitForTimeout(150);
    }
    throw new Error(what);
  };

  await page.goto(`${url}/?room=${room}`, { waitUntil: 'load' });
  await until(
    () => {
      const b = document.getElementById('btnPlay');
      return !!b && !b.disabled;
    },
    60000,
    'Play never enabled',
  );
  await page.click('#btnPlay');
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  await until(
    () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene?.world,
    90000,
    'exterior never came up',
  );

  // Stand somewhere grassy and let the streamer settle. Walking a little matters: the near
  // grids are keyed off the player's cell, and a world primed at spawn and never moved from
  // does not exercise them.
  // Stand somewhere that actually grows grass, found by asking the world which biome it is
  // rather than by picking coordinates and hoping.
  //
  // The first version of this probe stood at a fixed (1400, 1400), which turned out to be a
  // rock face in the highlands — a biome whose grass density is 0.1 by design. The numbers it
  // produced were real but the screenshot showed bare stone, and a screenshot of bare stone
  // is not evidence about a lawn either way.
  const spot = await page.evaluate(() => {
    const sc = window.arena.scene;
    // Biomes worth measuring ground cover in, richest first.
    const want = ['meadow', 'wetland', 'sakura', 'jungle', 'savanna'];
    let fallback = null;
    for (let r = 200; r <= 2200; r += 200) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const x = Math.cos(ang) * r;
        const z = Math.sin(ang) * r;
        sc.player.spawn(x, z, 0);
        sc.player.update(0.016);
        const biome = sc.world.stats().biome;
        if (!fallback) fallback = { x, z, biome };
        if (want.includes(biome)) return { x, z, biome };
      }
    }
    return fallback;
  });
  console.log(`standing in: ${JSON.stringify(spot)}`);
  await page.evaluate(
    ([x, z]) => {
      const sc = window.arena.scene;
      sc.player.spawn(x, z, 0);
      // Shallow, so the frame is mostly the ground in front of the player — which is what
      // the complaint was about.
      sc.player.pitch = -0.34;
      sc.player.update(0.016);
    },
    [spot.x, spot.z],
  );
  // Wait for the streamer to drain, not for a fixed number of seconds.
  //
  // The coarse 256 m vegetation chunks take far longer to build than the near grids, and a
  // five-second sleep caught the world mid-stream: the far tuft layer read as *absent*, which
  // looks exactly like having deleted it. `world.stats().queued` is the streamers' own
  // backlog, so this asks the world whether it has finished rather than guessing.
  //
  // Waited on the thing actually needed — the far layer being in the scene — rather than on
  // the backlog reaching zero. Under software rendering the streamer keeps a rolling
  // backlog and `queued` never settles at nought, so that version of this wait simply timed
  // out on a world that was fine. Not fatal either: if the far layer never arrives the run
  // reports it as a failed check instead of throwing away the measurements it did take.
  // Waited on the *near* grids filling in, which is what the teleport invalidated.
  //
  // Two earlier versions of this wait were wrong in opposite directions. Waiting for the
  // streamer's backlog to reach zero never finished, because under software rendering it
  // keeps a rolling one. Waiting for the far tuft layer to appear finished instantly, because
  // the search for a grassy spot had already streamed it — and the measurement then caught
  // one carpet cell out of nine and read a fully saturated layer as a sparse one.
  //
  // So: poll the count and stop when it stops growing. That is the only condition that means
  // "the streamer is done with where I am standing" without depending on how fast the machine
  // runs or on which layer happened to already exist.
  const grassCounts = () =>
    page.evaluate(() => {
      const n = { carpet: 0, clump: 0, far: 0 };
      window.arena.scene.scene.traverse((o) => {
        if (!o.isInstancedMesh) return;
        if (o.name === 'grass:carpet') n.carpet += o.count;
        else if (o.name === 'grass:clump') n.clump += o.count;
        else if (o.name === 'grass') n.far += o.count;
      });
      return n;
    });
  let settled = false;
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 140; i++) {
    const n = await grassCounts();
    const total = n.carpet + n.clump + n.far;
    // All three layers have to be present before a plateau means anything. The streamer
    // builds them in order — carpet, then clumps, then the coarse chunks — so a total can sit
    // still for a couple of seconds between layers, and an earlier version of this wait took
    // exactly that pause for the end and measured a world with no clumps in it at all.
    const whole = n.carpet > 0 && n.clump > 0 && n.far > 0;
    if (whole && total === last) {
      if (++stable >= 4) {
        settled = true;
        break;
      }
    } else {
      stable = 0;
    }
    last = total;
    await page.waitForTimeout(500);
  }

  const counts = await page.evaluate(() => {
    const sc = window.arena.scene;
    const p = sc.player.feetPosition;
    // Every instanced mesh the scatter streamer owns, grouped by the label it was given.
    const layers = {};
    let triangles = 0;
    let draws = 0;
    // Nearest blade to a set of points on the ground around the player: the number that
    // actually answers "does this read as a lawn or as weeds".
    const near = [];
    const samples = [];
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      for (const r of [2, 5, 9]) {
        samples.push([p.x + Math.cos(ang) * r, p.z + Math.sin(ang) * r]);
      }
    }
    const best = samples.map(() => Infinity);

    sc.scene.traverse((o) => {
      if (!o.isInstancedMesh || typeof o.name !== 'string') return;
      if (!o.name.startsWith('grass')) return;
      layers[o.name] = (layers[o.name] ?? 0) + o.count;
      draws++;
      const tri = o.geometry.index
        ? o.geometry.index.count / 3
        : o.geometry.attributes.position.count / 3;
      triangles += tri * o.count;
      // Instance positions are in the matrices; read them once per instance.
      const m = new (Object.getPrototypeOf(o.matrixWorld).constructor)();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        const ix = m.elements[12];
        const iz = m.elements[14];
        for (let s = 0; s < samples.length; s++) {
          const dx = ix - samples[s][0];
          const dz = iz - samples[s][1];
          const d = dx * dx + dz * dz;
          if (d < best[s]) best[s] = d;
        }
      }
    });
    for (const b of best) near.push(+Math.sqrt(b).toFixed(2));
    near.sort((x, y) => x - y);
    const median = near[Math.floor(near.length / 2)];
    return {
      at: [Math.round(p.x), Math.round(p.z)],
      layers,
      draws,
      triangles: Math.round(triangles),
      worst: near[near.length - 1],
      median,
      fps: Math.round(window.arena.engine.fps ?? 0),
    };
  });
  console.log(`grass: ${JSON.stringify(counts)}`);

  await page.screenshot({ path: join(here, 'grass.png') });

  const carpet = counts.layers['grass:carpet'] ?? 0;
  const clump = counts.layers['grass:clump'] ?? 0;
  // The far tuft layer's meshes are labelled with the bare layer name, not `grass:grass`.
  const tuft = counts.layers.grass ?? 0;

  const line = (label, ok, extra = '') =>
    console.log(`${label.padEnd(34)}${ok ? 'ok' : 'FAIL'}${extra ? ` ${extra}` : ''}`);

  // The carpet layer exists and is the dense one.
  const carpetPresent = carpet > 4000;
  // Ground cover means no bare patch: from any sampled point within nine metres, something
  // is growing within a stride. Measured at 2.38 m median before this layer was tuned.
  // The median is the claim; the worst case is only a sanity bound. A single sampled point
  // can legitimately sit on a boulder, in water or on a slope past the planting limit, and
  // demanding grass within a stride of *every* point would be asserting that those do not
  // exist. Measured: 0.71 m median, 2.41 m worst, against 2.38 m median before.
  const noBarePatches = counts.median <= 0.9 && counts.worst <= 3.2;
  // And it did not cost the world. Both numbers are anchored to a measurement rather than
  // picked: the grass system drew 193k triangles over 45 calls before the carpet was made
  // dense, and the carpet is one draw per cell over nine cells.
  // Anchored to measurements in the richest biome the world has, not to a guess. Before the
  // carpet: 630k triangles over 45 calls, with four metres of bare ground between plants.
  // After, once the clump spacing was widened to pay for it: about 580k over the same 45.
  const affordable = counts.triangles < 640000 && counts.draws <= 52;
  // Asserted on the measurement, not on whether the wait above happened to succeed. The wait
  // is a speed-up; the counts are the evidence. Tying the verdict to the timer failed a run
  // whose own numbers showed all three layers present with thousands of instances each.
  const layersPresent = clump > 0 && tuft > 0 && carpet > 0;

  line('carpet layer streams:', carpetPresent, `${carpet} tufts`);
  line('no bare ground underfoot:', noBarePatches, `median ${counts.median}m worst ${counts.worst}m`);
  line(
    'all three layers present:',
    layersPresent,
    `tuft=${tuft} clump=${clump} carpet=${carpet} settledInTime=${settled}`,
  );
  line('still inside budget:', affordable, `${counts.triangles} tris, ${counts.draws} draws`);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 6)) console.log(' ', e);

  const pass = carpetPresent && noBarePatches && layersPresent && affordable && errors.length === 0;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
