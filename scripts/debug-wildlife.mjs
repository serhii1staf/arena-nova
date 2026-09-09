// Temporary probe: checks that animals spawn, wander, and actually run away when
// the player closes in — and that the whole herd stays within a few draw calls.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = 'http://localhost:4173';

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  await page.waitForTimeout(4000);
  // Somewhere in the meadows, where deer and rabbits live.
  await page.evaluate(() => window.arena.scene.player.spawn(760, -540, 0));
  await page.evaluate(() => window.arena.scene.setCameraZoom(6));

  console.log('=== WILDLIFE PROBE ===');

  /**
   * Waits for `seconds` of *simulated* time. The engine clamps frameDelta to
   * 0.1 s to avoid a death spiral, so under software rendering (a few fps here)
   * the simulation advances far slower than the wall clock. Waiting on wall time
   * would measure the renderer, not the animals.
   */
  const advance = async (seconds) => {
    const start = await page.evaluate(() => window.arena.scene.time);
    for (let i = 0; i < 400; i++) {
      await page.waitForTimeout(250);
      const now = await page.evaluate(() => window.arena.scene.time);
      if (now - start >= seconds) return now - start;
    }
    return -1;
  };

  // Give the pool time to fill: spawning is deliberately spread over frames.
  let populated = 0;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2500);
    populated = await page.evaluate(() => window.arena.scene.worldStats().animals);
    if (populated >= 4) break;
  }
  console.log(`animals alive: ${populated}`);

  const draws = await page.evaluate(() => {
    const wl = window.arena.scene.scene.getObjectByName('Wildlife');
    return wl.children.map((m) => ({ count: m.count, tris: m.geometry.index
      ? m.geometry.index.count / 3
      : m.geometry.attributes.position.count / 3 }));
  });
  console.log('instanced meshes:', JSON.stringify(draws));

  // Did anything actually move on its own?
  const before = await page.evaluate(() => {
    const wl = window.arena.scene.scene.getObjectByName('Wildlife');
    const out = [];
    const m4 = [];
    for (const mesh of wl.children) {
      const a = mesh.instanceMatrix.array;
      for (let i = 0; i < mesh.count; i++) {
        out.push([a[i * 16 + 12], a[i * 16 + 14]]);
      }
    }
    void m4;
    return out;
  });
  await advance(5);
  const after = await page.evaluate(() => {
    const wl = window.arena.scene.scene.getObjectByName('Wildlife');
    const out = [];
    for (const mesh of wl.children) {
      const a = mesh.instanceMatrix.array;
      for (let i = 0; i < mesh.count; i++) {
        out.push([a[i * 16 + 12], a[i * 16 + 14]]);
      }
    }
    return out;
  });
  let moved = 0;
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i++) {
    if (Math.hypot(after[i][0] - before[i][0], after[i][1] - before[i][1]) > 0.3) moved++;
  }
  console.log(`moved on their own: ${moved} of ${n}`);

  // ---- Flee test ---------------------------------------------------------
  // Measured as "how close is the nearest animal", not by following one instance:
  // instance slots are repacked every frame as animals spawn and recycle, so an
  // index captured now can point at a different animal a second later.
  const nearest = () =>
    page.evaluate(() => {
      const sc = window.arena.scene;
      const wl = sc.scene.getObjectByName('Wildlife');
      const px = sc.player.renderPosition.x;
      const pz = sc.player.renderPosition.z;
      let best = Infinity;
      let pick = null;
      for (const mesh of wl.children) {
        const a = mesh.instanceMatrix.array;
        for (let i = 0; i < mesh.count; i++) {
          const x = a[i * 16 + 12];
          const z = a[i * 16 + 14];
          const d = Math.hypot(x - px, z - pz);
          if (d < best) {
            best = d;
            pick = [x, z];
          }
        }
      }
      return { d: best === Infinity ? null : +best.toFixed(2), pos: pick };
    });

  const target = await nearest();
  // Stand almost on top of it.
  if (target.pos) {
    await page.evaluate(
      ([x, z]) => window.arena.scene.player.spawn(x + 3, z + 3, 0),
      target.pos,
    );
  }
  const atArrival = await nearest();
  const simulated = await advance(4);
  const afterFlee = await nearest();
  console.log(
    `flee test: nearest on arrival ${atArrival.d} m -> after ${simulated.toFixed(1)} s of game time ${afterFlee.d} m`,
  );

  await page.screenshot({ path: join(here, 'wildlife.png') });
  void join;
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 6)) console.log(' ', e);

  const ok =
    populated >= 4 &&
    moved > 0 &&
    atArrival.d !== null &&
    afterFlee.d !== null &&
    // It has to put real distance between itself and the player, not just drift.
    afterFlee.d > atArrival.d + 12 &&
    errors.length === 0;
  console.log('RESULT:', ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
