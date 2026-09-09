// Checks the shipped character: that the GLB loads, that its clips map onto the
// locomotion states, and captures a third-person frame so the model can be seen.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://localhost:4173';

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  page.setDefaultTimeout(180000);
  const errors = [];
  const logs = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    else if (m.text().includes('[character]')) logs.push(m.text());
  });
  page.on('response', (r) => {
    if (r.url().includes('/models/')) logs.push(`[net ${r.status()}] ${r.url().split('/').pop()}`);
  });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  // The exterior warms up every shader before it hands over, so wait for the
  // scene to actually exist rather than guessing a duration.
  // Wait on the scene *name*, not on the object: the manager nulls `current`
  // while the new scene initialises, so checking for a non-null scene matches the
  // outgoing lobby and returns immediately.
  await page.waitForFunction(
    () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene,
    { timeout: 180000 },
  );
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.arena.scene.setCameraZoom(4.5));

  // Walk, so the run/walk clip is the one on screen.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(5000);

  const probe = await page.evaluate(() => {
    const av = window.arena.scene.character;
    const active = av?.active;
    let skinned = 0;
    let meshes = 0;
    let tris = 0;
    av?.object.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      if (o.isSkinnedMesh) skinned++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    });
    return {
      gltfActive: !!av?.gltfActive,
      meshes,
      skinned,
      tris: Math.round(tris),
      clipMap: active?.clipMap ?? null,
      currentState: active?.currentState ?? null,
    };
  });
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(here, 'avatar.png') });

  console.log('=== AVATAR PROBE ===');
  console.log(JSON.stringify(probe, null, 2));
  for (const l of logs) console.log(' ', l);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 6)) console.log(' ', e);

  const ok =
    probe.gltfActive &&
    probe.skinned > 0 &&
    probe.clipMap?.idle &&
    probe.clipMap?.walk &&
    probe.clipMap?.run &&
    errors.length === 0;
  console.log('RESULT:', ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
