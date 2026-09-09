// Minimal probe: boots into the exterior and prints every console message and
// error verbatim. Used when a scene fails to initialise at all.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4173';
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  page.setDefaultTimeout(120000);
  page.on('pageerror', (e) => console.log(`PAGEERROR: ${e.message}\n${e.stack ?? ''}`));
  page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`));
  page.on('requestfailed', (r) => console.log(`REQFAIL ${r.url()} ${r.failure()?.errorText}`));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  await page.waitForTimeout(2000);
  console.log('--- requesting exterior ---');
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(2000);
    const s = await page.evaluate(() => ({
      name: window.arena.engine.scenes.currentName,
      hasScene: !!window.arena.scene,
    }));
    console.log(`t+${(i + 1) * 2}s  ${JSON.stringify(s)}`);
    if (s.name === 'exterior' && s.hasScene) break;
  }
} finally {
  await browser.close();
}
