// Measures ground contact while running downhill.
//
// Descending a slope used to flip `isGrounded` at fixed-step rate, because the
// surface fell away faster than the body could fall in one step. That flicker is
// what produced the juddering, one-legged hop: the rig cross-blended the walk and
// fall clips continuously, and the stride phase only advances while grounded.
//
// Two things this has to get right to mean anything:
//  - Sample in the *physics* step, not per rendered frame. The flicker is a
//    fixed-step phenomenon and software rendering here runs at a fraction of that
//    rate, so per-frame sampling aliases it away entirely.
//  - Run on an actual slope. The spawn plaza is deliberately flat, so the probe
//    searches the terrain for a steep patch and starts the player there.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://localhost:4173';

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 860, height: 560 } });
  page.setDefaultTimeout(240000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  await page.waitForFunction(
    () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene,
    { timeout: 240000 },
  );
  await page.waitForTimeout(2500);

  // Find a genuinely steep spot and stand on it, facing straight down the slope.
  const aim = await page.evaluate(() => {
    const scene = window.arena.scene;
    const h = (x, z) => scene.world.floorHeightAt(x, z);
    let best = null;
    for (let x = -160; x <= 160; x += 7) {
      for (let z = -160; z <= 160; z += 7) {
        // Skip the flattened plaza around the portal.
        if (Math.hypot(x, z) < 40) continue;
        const here = h(x, z);
        const gx = (h(x + 5, z) - h(x - 5, z)) / 10;
        const gz = (h(x, z + 5) - h(x, z - 5)) / 10;
        const grade = Math.hypot(gx, gz);
        // Steep, but not a cliff the player would simply fall off.
        if (grade < 0.18 || grade > 0.85) continue;
        if (!best || grade > best.grade) best = { x, z, here, gx, gz, grade };
      }
    }
    if (!best) return null;
    // Downhill is the negative gradient; yaw is defined so that forward is
    // (-sin yaw, 0, -cos yaw), so solve for that direction.
    const yaw = Math.atan2(best.gx, best.gz);
    scene.player.spawn(best.x, best.z, yaw);
    // Third person, so the rig is actually driven and its clip can be read.
    scene.setCameraZoom(4.5);
    return { x: best.x, z: best.z, grade: +best.grade.toFixed(3), startY: +best.here.toFixed(2) };
  });
  if (!aim) {
    console.log('no suitable slope found — cannot measure');
    process.exitCode = 1;
  } else {
    await page.waitForTimeout(1200);

    // Sample inside the fixed step by wrapping the controller's update.
    await page.evaluate(() => {
      const p = window.arena.scene.player;
      window.__samples = [];
      const original = p.update.bind(p);
      window.__restore = () => {
        p.update = original;
      };
      p.update = (dt) => {
        original(dt);
        window.__samples.push({
          g: p.isGrounded ? 1 : 0,
          y: p.feetPosition.y,
          vy: +p.verticalSpeed.toFixed(2),
          sp: +p.speed01.toFixed(2),
        });
      };
    });

    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(6000);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');
    await page.waitForTimeout(200);

    const trace = await page.evaluate(() => {
      window.__restore?.();
      const s = window.__samples;
      let flips = 0;
      let airborne = 0;
      for (let i = 0; i < s.length; i++) {
        if (i > 0 && s[i].g !== s[i - 1].g) flips++;
        if (!s[i].g) airborne++;
      }
      const clip = window.arena.scene.character?.active?.currentState ?? null;
      return {
        steps: s.length,
        flips,
        airborneSteps: airborne,
        descended: s.length ? +(s[0].y - s[s.length - 1].y).toFixed(2) : 0,
        avgSpeed01: s.length ? +(s.reduce((a, v) => a + v.sp, 0) / s.length).toFixed(2) : 0,
        minVy: s.length ? Math.min(...s.map((v) => v.vy)) : 0,
        clipWhileRunning: clip,
      };
    });
    await page.screenshot({ path: join(here, 'locomotion.png') });

    console.log('=== LOCOMOTION PROBE ===');
    console.log(`slope: grade ${aim.grade} at (${aim.x}, ${aim.z}), start y=${aim.startY}`);
    console.log(JSON.stringify(trace, null, 2));

    const descended = trace.descended > 1.5;
    const ran = trace.avgSpeed01 > 0.4;
    // The old behaviour flipped contact on most steps. Allow a couple of genuine
    // breaks over bumps across the whole run.
    const flipRate = trace.steps ? trace.flips / trace.steps : 1;
    const steady = flipRate < 0.02;
    const planted = trace.steps ? trace.airborneSteps / trace.steps < 0.05 : false;
    const running = trace.clipWhileRunning === 'run' || trace.clipWhileRunning === 'walk';

    console.log(`descended > 1.5 m:        ${descended ? 'ok' : 'FAIL'} (${trace.descended} m)`);
    console.log(`actually running:         ${ran ? 'ok' : 'FAIL'} (avg ${trace.avgSpeed01})`);
    console.log(
      `contact flips < 2% steps: ${steady ? 'ok' : 'FAIL'} (${(flipRate * 100).toFixed(1)}%, ${trace.flips}/${trace.steps})`,
    );
    console.log(
      `airborne < 5% of steps:  ${planted ? 'ok' : 'FAIL'} (${((trace.airborneSteps / Math.max(1, trace.steps)) * 100).toFixed(1)}%)`,
    );
    console.log(`clip is a ground gait:   ${running ? 'ok' : 'FAIL'} (${trace.clipWhileRunning})`);
    console.log(`errors: ${errors.length}`);
    for (const e of errors.slice(0, 6)) console.log(' ', e);

    const pass = descended && ran && steady && planted && running && errors.length === 0;
    console.log('RESULT:', pass ? 'PASS' : 'FAIL');
    process.exitCode = pass ? 0 : 1;
  }
} finally {
  await browser.close();
}
