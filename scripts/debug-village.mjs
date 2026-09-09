// Verifies the abandoned villages: that the authored pack loads, that hamlets
// appear on landmark pads, that they sit on the drawn ground rather than floating,
// that they collapse to a couple of draw calls, and that their walls are solid.
//
// Landmarks stream 5×5 cells around the player and roughly one cell in eight
// carries a village, so a couple appear near any spawn once the build queue has
// drained — no searching needed, just patience.
//
// Collision is checked by probing the collider field directly rather than by
// walking into a wall. A walk test looked convincing and proved nothing: the first
// version started the player inside the sawmill's collider, and being shoved out
// of it was indistinguishable from a wall doing its job.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://localhost:4173';

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.setDefaultTimeout(300000);
  const errors = [];
  const notes = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const text = m.text();
    if (text.includes('[props]')) notes.push(text);
    if (m.type() === 'error' && !/AudioContext|audio device|Pointer Lock/i.test(text)) {
      errors.push(text);
    }
  });
  page.on('response', (r) => {
    if (r.url().includes('/models/props/')) {
      notes.push(`[net ${r.status()}] ${r.url().split('/').pop()}`);
    }
  });

  await page.goto(`${url}/?room=village-${Math.random().toString(36).slice(2, 8)}`, {
    waitUntil: 'load',
  });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  await page.waitForFunction(
    () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene,
    { timeout: 300000 },
  );

  let found = null;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);
    found = await page.evaluate(() => {
      const scene = window.arena.scene;
      let hit = null;
      scene.world.group.traverse((o) => {
        if (!hit && o.name === 'Village') hit = o;
      });
      if (!hit) return null;
      hit.updateMatrixWorld(true);
      const wp = hit.getWorldPosition(hit.position.clone());

      let meshes = 0;
      let tris = 0;
      let sharedFlags = 0;
      let lowest = Infinity;
      const perMesh = [];
      hit.traverse((o) => {
        if (!o.isMesh) return;
        meshes++;
        if (o.userData.shared === true) sharedFlags++;
        const g = o.geometry;
        const count = g.index ? g.index.count : g.attributes.position.count;
        tris += count / 3;
        // Lowest vertex, to check the hamlet stands on the ground rather than
        // through it. Geometry is baked in village-local space and the group only
        // translates, so adding its world y is exact.
        g.computeBoundingBox();
        const bb = g.boundingBox;
        lowest = Math.min(lowest, bb.min.y + wp.y);
        perMesh.push({
          material: o.material?.name ?? '(unnamed)',
          tris: Math.round(count / 3),
          minY: +bb.min.y.toFixed(2),
          maxY: +bb.max.y.toFixed(2),
        });
      });

      return {
        at: { x: +wp.x.toFixed(1), y: +wp.y.toFixed(2), z: +wp.z.toFixed(1) },
        ground: +scene.world.floorHeightAt(wp.x, wp.z).toFixed(2),
        lowest: +lowest.toFixed(2),
        meshes,
        sharedFlags,
        tris: Math.round(tris),
        perMesh,
      };
    });
    if (found) break;
  }

  console.log('=== VILLAGE PROBE ===');
  for (const n of notes) console.log(' ', n);

  if (!found) {
    console.log('no village streamed in — cannot verify');
    console.log('RESULT: FAIL');
    process.exitCode = 1;
  } else {
    // Probe the collider field on a grid. `blocksCamera` reports any registered
    // prop tall enough to cover the sample point, so this reads the registry
    // without needing access to it.
    const solids = await page.evaluate((v) => {
      const scene = window.arena.scene;
      const step = 1.0;
      const reach = 21;
      let blocked = 0;
      let total = 0;
      let minRadius = Infinity;
      let maxRadius = 0;
      for (let dx = -reach; dx <= reach; dx += step) {
        for (let dz = -reach; dz <= reach; dz += step) {
          const x = v.at.x + dx;
          const z = v.at.z + dz;
          const y = scene.world.floorHeightAt(x, z) + 1.4;
          total++;
          if (scene.world.blocksCamera(x, y, z)) {
            blocked++;
            const d = Math.hypot(dx, dz);
            if (d < minRadius) minRadius = d;
            if (d > maxRadius) maxRadius = d;
          }
        }
      }
      return {
        blocked,
        total,
        minRadius: minRadius === Infinity ? null : +minRadius.toFixed(1),
        maxRadius: +maxRadius.toFixed(1),
      };
    }, found);

    // Stand back and look at it.
    await page.evaluate((v) => {
      const scene = window.arena.scene;
      const back = 22;
      const px = v.at.x + back;
      const pz = v.at.z + back;
      // Forward is (-sin yaw, -cos yaw), so looking from the player at the village
      // means yaw = atan2(px - tx, pz - tz). Getting this backwards pointed the
      // camera at empty forest and the frame showed nothing.
      const yaw = Math.atan2(px - v.at.x, pz - v.at.z);
      scene.player.spawn(px, pz, yaw);
      scene.setCameraZoom(6);
    }, found);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(here, 'village.png') });

    console.log(`village at (${found.at.x}, ${found.at.z})`);
    console.log(`  meshes: ${found.meshes}, triangles: ${found.tris}, shared-tagged: ${found.sharedFlags}`);
    console.log(`  group y=${found.at.y} ground=${found.ground} lowest vertex=${found.lowest}`);
    for (const m of found.perMesh) {
      console.log(`    material ${m.material.padEnd(10)} tris=${String(m.tris).padStart(6)} localY ${m.minY} .. ${m.maxY}`);
    }
    console.log(
      `  colliders: ${solids.blocked}/${solids.total} samples blocked, between ${solids.minRadius} m and ${solids.maxRadius} m out`,
    );

    // On a levelled pad the group must sit exactly on the drawn ground, and the
    // props' lowest vertex must not hang below it.
    const onGround = Math.abs(found.at.y - found.ground) < 0.35;
    const notSunk = found.lowest > found.ground - 0.6;
    // Merged into one mesh per material, and that geometry belongs to the chunk —
    // so it must not carry the prototype's shared tag or unloading would leak it.
    const mergedTight = found.meshes > 0 && found.meshes <= 3 && found.sharedFlags === 0;
    // Buildings have to actually be solid, and their colliders have to be near the
    // buildings rather than a single blanket circle over the whole hamlet.
    // `blocksCamera` shrinks each collider to 0.72 of its radius, so this count
    // understates the footprint that `collide` actually pushes against. What
    // matters is that a meaningful number of samples are blocked and that they sit
    // out at the ring where the houses are, not that the count hits some figure.
    const solid = solids.blocked >= 10;
    const notOneBigCircle = solids.maxRadius > 5 && solids.blocked < solids.total * 0.6;

    console.log(`  sits on the drawn ground:  ${onGround ? 'ok' : 'FAIL'}`);
    console.log(`  nothing sunk below it:     ${notSunk ? 'ok' : 'FAIL'}`);
    console.log(
      `  merged into <=3 draws:     ${mergedTight ? 'ok' : 'FAIL'} (${found.meshes} meshes, ${found.sharedFlags} tagged shared)`,
    );
    console.log(`  walls are solid:           ${solid ? 'ok' : 'FAIL'}`);
    console.log(`  footprints, not a blanket: ${notOneBigCircle ? 'ok' : 'FAIL'}`);
    console.log(`errors: ${errors.length}`);
    for (const e of errors.slice(0, 6)) console.log(' ', e);

    const pass =
      onGround && notSunk && mergedTight && solid && notOneBigCircle && errors.length === 0;
    console.log('RESULT:', pass ? 'PASS' : 'FAIL');
    process.exitCode = pass ? 0 : 1;
  }
} finally {
  await browser.close();
}
