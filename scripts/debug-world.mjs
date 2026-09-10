// Measures the streamed open world: triangle/draw budget, streaming backlog and
// per-frame cost while walking. Also samples which biomes the generator produces.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:4173';
const here = dirname(fileURLToPath(import.meta.url));

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // Software rendering here is slow; give screenshots room instead of failing.
  page.setDefaultTimeout(180000);
  const errors = [];
  // The headless browser has no audio device and no user gesture to grant pointer
  // lock, and says so on most runs. Neither is the page misbehaving, and counting
  // them made this probe fail at random on a world that was well inside budget —
  // the same filter the village and atmosphere probes already carry.
  const ignorable = /AudioContext|audio device|Pointer Lock/i;
  page.on('pageerror', (e) => {
    if (!ignorable.test(e.message)) errors.push(e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !ignorable.test(m.text())) errors.push(m.text());
  });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(
    () => {
      const b = document.getElementById('btnPlay');
      return !!b && !b.disabled;
    },
    { timeout: 120000 },
  );
  await page.click('#btnPlay');
  await page.waitForTimeout(2000);

  // Jump straight to the open world.
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  await page.waitForTimeout(6000);

  const snapshot = async (label) => {
    const s = await page.evaluate(() => {
      const eng = window.arena.engine;
      const sc = eng.scenes.current;
      const info = eng.renderer.info.render;
      return {
        draws: info.calls,
        tris: info.triangles,
        world: sc.worldStats ? sc.worldStats() : null,
      };
    });
    console.log(
      `${label}: draws=${s.draws} tris=${(s.tris / 1000).toFixed(0)}k chunks=${s.world?.chunks} pending=${s.world?.pending} biome=${s.world?.biome}`,
    );
    return s;
  };

  await snapshot('at spawn ');

  // Walk for a while so chunks stream in and out.
  await page.evaluate(() => window.arena.scene.setCameraZoom(6));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(9000);
  await page.keyboard.up('KeyW');
  const walked = await snapshot('after walk');
  await page.screenshot({ path: join(here, 'smoke_world.png') });

  console.log(`errors: ${errors.length}`);
  if (errors.length) console.log(errors.slice(0, 5));

  const ok = walked.tris < 900000 && walked.draws < 420 && errors.length === 0;
  console.log('RESULT:', ok ? 'PASS — within budget' : 'FAIL — over budget');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
