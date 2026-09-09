// Temporary probe: steps the day/night cycle through its phases and captures a
// frame of each, plus the resulting light/fog values, so the palette can be
// eyeballed without waiting out a ten-minute in-game day.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = 'http://localhost:4173';

const PHASES = [
  ['dawn', 0.24],
  ['morning', 0.34],
  ['noon', 0.5],
  ['dusk', 0.76],
  ['night', 0.95],
];

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
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.arena.scene.setCameraZoom(5));
  // Move well clear of the spawn monolith, which otherwise fills every frame —
  // and the sun happens to sit behind it from the spawn point.
  await page.evaluate(() => window.arena.scene.player.spawn(760, -540, 0));
  await page.waitForTimeout(7000);

  console.log('=== SKY PROBE ===');
  for (const [name, t] of PHASES) {
    await page.evaluate((v) => {
      const sc = window.arena.scene;
      sc.dayNight.t01 = v;
      // Face the sun, so a sunset is actually in frame. The camera basis is
      // forward = (-sin yaw, 0, -cos yaw), hence the negated arguments.
      sc.dayNight.update(0, sc.player.renderPosition);
      const d = sc.dayNight.sunDir;
      sc.player.yaw = Math.atan2(-d.x, -d.z);
      sc.player.pitch = 0.2;
    }, t);
    // Let the eased fog and the tinted sky settle.
    await page.waitForTimeout(3500);

    const s = await page.evaluate(() => {
      const sc = window.arena.scene;
      const dn = sc.dayNight;
      const f = sc.scene.fog;
      const round = (v) => +v.toFixed(3);
      const rgb = (c) => [round(c.r), round(c.g), round(c.b)];
      const fireflies = sc.scene.getObjectByName('Exterior')?.children.find((o) => o.isPoints && o.material?.uniforms?.uAmount);
      return {
        t01: round(dn.t01),
        night: round(dn.nightFactor),
        sunY: round(dn.sunDir.y),
        sunIntensity: round(sc.sun.intensity),
        moonIntensity: round(sc.moon.intensity),
        hemiIntensity: round(sc.hemi.intensity),
        fogColour: rgb(f.color),
        fogDensity: +f.density.toFixed(6),
        skyTint: rgb(sc.world.skyMaterial.color),
        firefliesVisible: fireflies ? fireflies.visible : null,
        stars: round(dn.starOpacity),
      };
    });
    console.log(`${name.padEnd(8)} ${JSON.stringify(s)}`);
    await page.screenshot({ path: join(here, `sky_${name}.png`) });
  }

  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log(' ', e);
  process.exitCode = errors.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}
