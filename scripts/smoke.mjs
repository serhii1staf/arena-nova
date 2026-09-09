// Headless runtime smoke test.
// Loads the built game in a software-WebGL Chromium, captures console/errors,
// verifies the render loop is drawing, then grabs a first-person shot and a
// third-person shot (walking) so the character + camera can be eyeballed.
//
// Usage: node scripts/smoke.mjs [url]
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:4173';
const here = dirname(fileURLToPath(import.meta.url));

const errors = [];
const warnings = [];

const browser = await chromium.launch({
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // Software GL can be very slow; give screenshots room rather than failing.
  page.setDefaultTimeout(120000);
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error') errors.push(msg.text());
    else if (t === 'warning') warnings.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto(url, { waitUntil: 'load', timeout: 30000 });

  // Start screen: wait for the Play button to become enabled, then press it.
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  }, { timeout: 90000 });
  await page.screenshot({ path: join(here, 'smoke_start.png') });
  await page.click('#btnPlay');
  await page.waitForTimeout(4000);

  const report = await page.evaluate(() => {
    const engine = window.arena?.engine;
    return {
      hasEngine: !!engine,
      started: window.arena?.ui?.hasStarted ?? false,
      startHidden: document.getElementById('start')?.classList.contains('hidden') ?? false,
      drawCalls: engine?.renderer?.info?.render?.calls ?? -1,
      triangles: engine?.renderer?.info?.render?.triangles ?? -1,
      fps: engine ? Math.round(engine.quality.fps) : -1,
      scene: engine?.scenes?.currentName ?? '',
    };
  });

  await page.screenshot({ path: join(here, 'smoke.png') });

  // Escape should open the blurred pause menu; pressing it again resumes.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  report.pauseOpensOnEscape = await page.evaluate(
    () => document.getElementById('pause')?.classList.contains('open') ?? false,
  );
  await page.click('#btnSettings');
  await page.waitForTimeout(500);

  // Switch the UI to Russian and confirm the labels actually change.
  await page.selectOption('#setLang', 'ru');
  await page.waitForTimeout(400);
  report.localisedToRussian = await page.evaluate(() => {
    const resume = document.getElementById('btnResume')?.textContent?.trim() ?? '';
    const title = document.querySelector('#pauseCard h2')?.textContent?.trim() ?? '';
    return resume === 'Продолжить' && title === 'Пауза';
  });
  await page.screenshot({ path: join(here, 'smoke_menu_ru.png') });

  // Back to English for the remaining screenshots.
  await page.selectOption('#setLang', 'en');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(here, 'smoke_menu.png') });
  await page.click('#btnResume');
  await page.waitForTimeout(500);

  // Third person + walk forward, then screenshot.
  await page.evaluate(() => window.arena?.scene?.setCameraZoom?.(5));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1400);
  await page.screenshot({ path: join(here, 'smoke_tp.png') });
  await page.keyboard.up('KeyW');

  // Screenshot the portal in the lobby (turn around and look back at it).
  await page.evaluate(() => window.arena?.scene?.setCameraZoom?.(0));
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(900);
  await page.keyboard.up('KeyS');
  await page.screenshot({ path: join(here, 'smoke_portal.png') });

  // Walk into the portal → should teleport to the open world. Software GL in CI
  // can run at a few FPS, so hold the key and poll rather than guess a duration.
  await page.keyboard.down('KeyS');
  const deadline = Date.now() + 60000;
  let sceneNow = 'lobby';
  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    sceneNow = await page.evaluate(() => window.arena?.engine?.scenes?.currentName ?? '');
    if (sceneNow === 'exterior') break;
  }
  await page.keyboard.up('KeyS');
  await page.waitForTimeout(1500);
  report.sceneAfterPortal = sceneNow;

  // Third person in the open world.
  await page.evaluate(() => window.arena?.scene?.setCameraZoom?.(6));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1600);
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: join(here, 'smoke_ext.png') });

  // Jump in third person so the airborne arm/leg pose can be inspected.
  await page.evaluate(() => window.arena?.scene?.setCameraZoom?.(5));
  await page.keyboard.press('Space');
  await page.waitForTimeout(320);
  await page.screenshot({ path: join(here, 'smoke_jump.png') });

  // Confirm the dragon exists and grab a second, later frame of the sky.
  report.hasDragon = await page.evaluate(() => {
    const sc = window.arena?.engine?.scenes?.current?.scene;
    let found = false;
    sc?.traverse?.((o) => {
      if (o.name === 'Dragon') found = true;
    });
    return found;
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(here, 'smoke_sky.png') });
  report.exteriorErrorsSoFar = errors.length;

  const ok =
    report.hasEngine &&
    report.started &&
    report.startHidden &&
    report.drawCalls > 0 &&
    report.triangles > 1000 &&
    report.pauseOpensOnEscape &&
    report.localisedToRussian &&
    errors.length === 0;

  console.log('\n=== SMOKE REPORT ===');
  console.log(JSON.stringify(report, null, 2));
  console.log('screenshots:', join(here, 'smoke.png'), '+', join(here, 'smoke_tp.png'));
  if (warnings.length) console.log(`warnings: ${warnings.length} (first: ${warnings[0] ?? ''})`);
  if (errors.length) {
    console.log('\n--- ERRORS ---');
    for (const e of errors.slice(0, 20)) console.log(e);
  }
  console.log('\nRESULT:', ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
