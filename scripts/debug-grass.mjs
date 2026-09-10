// Verifies the grass: that the authored clump pack loads and reaches the scene,
// that it is the right size and not black, that the near field carries more grass
// than the procedural carpet alone did, and that the whole layer still fits the
// frame budget.
//
// Numbers alone are not enough here, and this is the probe where that bites
// hardest. Grass that renders solid black — the failure a missing vertex-colour
// attribute produces — passes every count, every bounding box and every draw-call
// check there is. So does grass baked at a fiftieth of its intended scale. Both
// are only visible in a frame, so this stands in a meadow, looks down at the
// ground, and measures what came back: how green it is, how much of it is not the
// bare terrain behind it, and how dark the darkest of it gets.
//
// The reference numbers below are the measured state of the procedural-only layer
// before the clumps were wired in (9 chunks at 2.6 m spacing: 67 349 tufts,
// 404 094 triangles). "More grass" is judged against that.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://localhost:4173';

/**
 * What the layer was before the authored clumps: tufts only, 2.6 m spacing, over
 * the nine 256 m vegetation chunks — 589 824 m² of ground, so 0.114 tufts per
 * square metre everywhere.
 */
const BEFORE = { instances: 67349, triangles: 404094, meshes: 18, area: 9 * 256 * 256 };
/** Ground each layer now covers, for the density comparison. */
const CARPET_AREA = 9 * 256 * 256;
const CLUMP_AREA = 9 * 96 * 96;
/** The frame budget the world probe enforces. */
const TRI_BUDGET = 900000;
const DRAW_BUDGET = 420;

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.setDefaultTimeout(300000);
  const errors = [];
  const notes = [];
  // Pointer Lock and the audio device are the headless environment complaining
  // about itself, not the page misbehaving — every probe here filters them.
  const ignorable = /AudioContext|audio device|Pointer Lock/i;
  page.on('pageerror', (e) => {
    if (!ignorable.test(e.message)) errors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (m) => {
    const text = m.text();
    if (text.includes('[grass]')) notes.push(text);
    if (m.type() === 'error' && !ignorable.test(text)) errors.push(text);
  });
  page.on('response', (r) => {
    if (r.url().includes('/models/nature/')) {
      notes.push(`[net ${r.status()}] ${r.url().split('/').pop()}`);
    }
  });

  await page.goto(`${url}/?room=grass-${Math.random().toString(36).slice(2, 8)}`, {
    waitUntil: 'load',
  });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  await page.waitForFunction(
    () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene,
    { timeout: 300000 },
  );

  // Everything below reads the vegetation group, so install the walker once.
  await page.evaluate(() => {
    window.__grass = () => {
      const layers = {};
      let clumpMeshes = 0;
      let authoredMeshes = 0;
      const shapes = [];
      window.arena.scene.world.group.traverse((o) => {
        if (!o.isInstancedMesh) return;
        const [layer, tier] = o.name.split(':');
        if (layer !== 'grass') return;
        const g = o.geometry;
        const per = (g.index ? g.index.count : g.attributes.position.count) / 3;
        const e = (layers[tier ?? 'carpet'] ??= {
          meshes: 0,
          instances: 0,
          triangles: 0,
          perInstance: [],
        });
        e.meshes++;
        e.instances += o.count;
        e.triangles += per * o.count;
        if (!e.perInstance.includes(per)) e.perInstance.push(per);
        if (tier === 'clump') {
          clumpMeshes++;
          if (o.userData.authored) authoredMeshes++;
          if (shapes.length < 8) {
            if (!g.boundingBox) g.computeBoundingBox();
            const bb = g.boundingBox;
            const attrs = Object.keys(g.attributes).sort();
            // Darkest and brightest vertex colour in the geometry. A geometry with
            // no colour attribute renders black; one that has the attribute but
            // filled with zeroes renders black too, and only this can tell.
            const c = g.attributes.color;
            let lo = Infinity;
            let hi = -Infinity;
            for (let i = 0; c && i < c.count; i++) {
              const l = c.getX(i) * 0.3 + c.getY(i) * 0.6 + c.getZ(i) * 0.1;
              lo = Math.min(lo, l);
              hi = Math.max(hi, l);
            }
            shapes.push({
              triangles: per,
              attrs,
              height: +(bb.max.y - bb.min.y).toFixed(3),
              width: +Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z).toFixed(3),
              baseY: +bb.min.y.toFixed(3),
              colourLo: c ? +lo.toFixed(3) : null,
              colourHi: c ? +hi.toFixed(3) : null,
              doubleSided: o.material.side === 2,
              swaying: !!o.material.onBeforeCompile,
            });
          }
        }
      });
      const totals = Object.values(layers).reduce(
        (a, e) => ({
          meshes: a.meshes + e.meshes,
          instances: a.instances + e.instances,
          triangles: a.triangles + e.triangles,
        }),
        { meshes: 0, instances: 0, triangles: 0 },
      );
      return { layers, totals, clumpMeshes, authoredMeshes, shapes };
    };
  });

  // Wait on the state, not the clock: the pack has to arrive, the cells it
  // invalidated have to be rebuilt, and the count has to stop moving.
  let last = -1;
  let steady = 0;
  let seen = null;
  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(1000);
    seen = await page.evaluate(() => window.__grass());
    if (seen.totals.instances === last && seen.authoredMeshes > 0) {
      if (++steady >= 3) break;
    } else {
      steady = 0;
    }
    last = seen.totals.instances;
  }

  // Stand in a meadow and look down at the ground. A frame aimed at the horizon
  // is mostly sky and trees and says nothing about the grass underfoot.
  const placed = await page.evaluate(() => {
    const scene = window.arena.scene;
    const want = ['meadow', 'sakura', 'wetland', 'jungle'];
    // Starts well outside the spawn plaza. Nothing is scattered within 0.8 of the
    // plaza radius, so a probe that stands on that line photographs bare ground
    // and blames the grass for it.
    for (let r = 140; r < 800; r += 16) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const x = Math.cos(ang) * r;
        const z = Math.sin(ang) * r;
        scene.player.spawn(x, z, ang);
        const biome = scene.world.stats().biome;
        if (want.includes(biome)) return { x, z, biome };
      }
    }
    return { x: 0, z: 160, biome: scene.world.stats().biome };
  });
  // Noon, so what the frame shows is the grass and not the light. The clock is
  // pinned by assignment rather than waited out: at the handful of frames a second
  // this runs at, a value that moves is a value that cannot be captured.
  //
  // Camera well back and only slightly down: steep enough to fill the frame with
  // ground rather than sky, shallow enough that the grass is seen along its length
  // instead of from directly above, which is the one angle flat blades disappear
  // from.
  await page.evaluate(() => {
    const s = window.arena.scene;
    s.dayNight.t01 = 0.5;
    s.setCameraZoom(7);
    s.player.pitch = -0.22;
  });
  // The move re-centres both grass grids; wait for them to refill rather than
  // guessing how long that takes.
  let settled = null;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);
    const now = await page.evaluate(() => window.__grass());
    if (settled && now.totals.instances === settled.totals.instances) break;
    settled = now;
  }
  const stats = settled ?? seen;
  const shot = await page.screenshot({ path: join(here, 'grass_ground.png') });

  // Look at the frame that was just captured. Not at the WebGL buffer: the scene
  // is drawn through a post-processing composer and the default framebuffer is not
  // preserved, so reading pixels back out of the canvas returns solid black no
  // matter what is on screen — which would have "detected" the exact bug this
  // check exists for, on a frame that was perfectly fine. The screenshot goes
  // through the browser's compositor and is what a person would see, so it is what
  // gets measured; the browser decodes it back for us.
  const look = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // A band across the middle-lower part of the picture: the ground in front of
    // the player, clear of the sky above and of the HUD along the very bottom.
    const x0 = Math.floor(img.width * 0.1);
    const w = Math.floor(img.width * 0.8);
    const y0 = Math.floor(img.height * 0.45);
    const h = Math.floor(img.height * 0.42);
    const d = ctx.getImageData(x0, y0, w, h).data;
    let green = 0;
    let veryDark = 0;
    const sum = [0, 0, 0];
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const r = d[i * 4];
      const g = d[i * 4 + 1];
      const b = d[i * 4 + 2];
      sum[0] += r;
      sum[1] += g;
      sum[2] += b;
      if (g > r + 8 && g > b + 8) green++;
      // Black grass over lit ground shows up as pixels far darker than anything
      // a daylit meadow produces.
      if (r + g + b < 40) veryDark++;
    }
    return {
      greenFraction: +(green / n).toFixed(3),
      veryDarkFraction: +(veryDark / n).toFixed(3),
      mean: sum.map((v) => Math.round(v / n)),
    };
  }, shot.toString('base64'));

  const frame = await page.evaluate(() => {
    const info = window.arena.engine.renderer.info.render;
    return { draws: info.calls, triangles: info.triangles };
  });

  console.log('=== GRASS PROBE ===');
  for (const n of notes) console.log(' ', n);
  console.log(`standing in: ${placed.biome} at (${Math.round(placed.x)}, ${Math.round(placed.z)})`);
  for (const [tier, e] of Object.entries(stats.layers)) {
    console.log(
      `  ${tier.padEnd(7)} meshes=${String(e.meshes).padStart(3)} instances=${String(e.instances).padStart(6)} triangles=${String(Math.round(e.triangles)).padStart(7)} per-instance=${e.perInstance.join(',')}`,
    );
  }
  console.log(
    `  before   meshes=${String(BEFORE.meshes).padStart(3)} instances=${String(BEFORE.instances).padStart(6)} triangles=${String(BEFORE.triangles).padStart(7)} per-instance=6`,
  );
  console.log(
    `  after    meshes=${String(stats.totals.meshes).padStart(3)} instances=${String(stats.totals.instances).padStart(6)} triangles=${String(Math.round(stats.totals.triangles)).padStart(7)}`,
  );

  // Density where it can be seen, which is the number that matters and the one
  // the totals hide. The tufts that were traded away were two hundred metres out.
  const clumpDensity = (stats.layers.clump?.instances ?? 0) / CLUMP_AREA;
  const carpetDensity = (stats.layers.carpet?.instances ?? 0) / CARPET_AREA;
  const nearDensity = clumpDensity + carpetDensity;
  const beforeDensity = BEFORE.instances / BEFORE.area;
  const nearTriangles =
    ((stats.layers.clump?.triangles ?? 0) / CLUMP_AREA) +
    ((stats.layers.carpet?.triangles ?? 0) / CARPET_AREA);
  const beforeTriangles = BEFORE.triangles / BEFORE.area;
  console.log(
    `  near field: ${nearDensity.toFixed(4)} plants/m² and ${nearTriangles.toFixed(2)} triangles/m², against ${beforeDensity.toFixed(4)} and ${beforeTriangles.toFixed(2)} before`,
  );
  for (const s of stats.shapes.slice(0, 4)) {
    console.log(
      `  clump geometry: ${s.triangles} tris, ${s.height} m tall / ${s.width} m across, base y=${s.baseY}, attrs [${s.attrs.join(' ')}], vertex colour ${s.colourLo}..${s.colourHi}, doubleSided=${s.doubleSided}, wind=${s.swaying}`,
    );
  }
  console.log(
    `  frame: ${frame.draws} draws, ${(frame.triangles / 1000).toFixed(0)}k triangles rendered`,
  );
  console.log(
    `  looked at grass_ground.png: ${(look.greenFraction * 100).toFixed(1)}% green pixels, ${(look.veryDarkFraction * 100).toFixed(1)}% near-black, mean rgb(${look.mean.join(',')})`,
  );

  // ---- Verdict ----------------------------------------------------------
  const clump = stats.layers.clump;

  // The pack reached the scene, not just the network.
  const packInScene = !!clump && stats.authoredMeshes === stats.clumpMeshes && stats.clumpMeshes > 0;
  // Authored geometry, told apart from the six-triangle procedural tuft by its own
  // triangle count. The pack ships a 58-triangle clump and a 108-triangle one.
  const authoredGeometry =
    !!clump && clump.perInstance.every((n) => n > 24) && clump.perInstance.length >= 1;
  // Scale: a clump is grass, not moss and not a tree, and it stands on the ground.
  const rightScale = stats.shapes.every(
    (s) => s.height > 0.25 && s.height < 1.2 && s.width > 0.2 && s.width < 2 && Math.abs(s.baseY) < 0.06,
  );
  // Vertex colours present and green — the check that catches the black-grass trap
  // at the source rather than in the picture.
  const coloured = stats.shapes.every(
    (s) => s.attrs.includes('color') && s.attrs.includes('aSway') && s.colourLo > 0.05,
  );
  const windAndSides = stats.shapes.every((s) => s.doubleSided && s.swaying);
  // More grass than there was.
  //
  // Judged where the player is, not across the whole layer, and this is the one
  // assertion worth explaining. The total instance count is *down*, and has to be:
  // a clump is 58 or 108 triangles against the tuft's 6, so keeping the old count
  // and swapping the geometry in would have been two and a half million triangles
  // against a 900 000 budget. What was given up to pay for the clumps is tufts two
  // to four hundred metres away, each a pixel or two tall. What was bought is more
  // plants per square metre in the near field than there ever were, each of them a
  // modelled bunch of a dozen blades instead of two flat cards — so the triangles
  // per square metre of visible ground go up several times over.
  const denserNearField = nearDensity > beforeDensity;
  const moreGeometry =
    stats.totals.triangles > BEFORE.triangles && nearTriangles > beforeTriangles * 2;
  // Still inside the budget the world probe enforces.
  const withinBudget = frame.triangles < TRI_BUDGET && frame.draws < DRAW_BUDGET;
  // And it actually looks like grass in the frame.
  const looksLikeGrass = look.greenFraction > 0.25 && look.veryDarkFraction < 0.06;

  console.log(`  pack reached the scene:      ${packInScene ? 'ok' : 'FAIL'} (${stats.authoredMeshes}/${stats.clumpMeshes} clump meshes authored)`);
  console.log(`  authored geometry, not tufts:${authoredGeometry ? 'ok' : 'FAIL'} (${clump?.perInstance.join(',')} tris per instance)`);
  console.log(`  scaled like grass:           ${rightScale ? 'ok' : 'FAIL'}`);
  console.log(`  vertex-coloured, not black:  ${coloured ? 'ok' : 'FAIL'}`);
  console.log(`  double-sided and swaying:    ${windAndSides ? 'ok' : 'FAIL'}`);
  console.log(
    `  denser where you can see it: ${denserNearField ? 'ok' : 'FAIL'} (${nearDensity.toFixed(4)} vs ${beforeDensity.toFixed(4)} plants/m²)`,
  );
  console.log(
    `  more grass geometry overall: ${moreGeometry ? 'ok' : 'FAIL'} (${Math.round(stats.totals.triangles)} vs ${BEFORE.triangles} triangles; ${(nearTriangles / beforeTriangles).toFixed(1)}x per m² near the player)`,
  );
  console.log(
    `  ...at the cost of the far field: ${stats.totals.instances} plants against ${BEFORE.instances}, the difference being tufts 200-400 m out`,
  );
  console.log(
    `  within the frame budget:     ${withinBudget ? 'ok' : 'FAIL'} (${(frame.triangles / 1000).toFixed(0)}k/${TRI_BUDGET / 1000}k tris, ${frame.draws}/${DRAW_BUDGET} draws)`,
  );
  console.log(
    `  the frame looks like grass:  ${looksLikeGrass ? 'ok' : 'FAIL'} (${(look.greenFraction * 100).toFixed(1)}% green, ${(look.veryDarkFraction * 100).toFixed(1)}% near-black)`,
  );
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 6)) console.log(' ', e);

  const pass =
    packInScene &&
    authoredGeometry &&
    rightScale &&
    coloured &&
    windAndSides &&
    denserNearField &&
    moreGeometry &&
    withinBudget &&
    looksLikeGrass &&
    errors.length === 0;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
