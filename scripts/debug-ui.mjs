// Measures the pause-menu layout to find why one element covers another.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4173';
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  }, { timeout: 90000 });
  await page.click('#btnPlay');
  await page.waitForTimeout(2500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  // Open settings without clicking, so measurement isn't blocked by hit-testing.
  await page.evaluate(() => {
    document.getElementById('pause')?.classList.add('open');
    document.getElementById('settings')?.classList.add('open');
  });
  await page.waitForTimeout(400);

  const info = await page.evaluate(() => {
    const ids = ['pause', 'pauseCard', 'btnResume', 'settings', 'updateRow', 'winControls'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) {
        out[id] = null;
        continue;
      }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out[id] = {
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        display: cs.display,
        position: cs.position,
        zIndex: cs.zIndex,
      };
    }
    // What is actually on top at the Resume button's centre?
    for (const id of ['btnResume', 'btnSettings', 'btnUpdate']) {
      const el = document.getElementById(id);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      const topEl = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      out[`topAt_${id}`] = topEl ? `${topEl.tagName}#${topEl.id}` : null;
    }
    return out;
  });
  console.log(JSON.stringify(info, null, 2));
} finally {
  await browser.close();
}
