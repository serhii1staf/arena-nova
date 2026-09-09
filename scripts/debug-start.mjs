// Verifies the start screen: a spinner while the world builds, then the title
// lifts, the prompt drops, the button gains a name field, and the name entered is
// still there on the next visit.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://localhost:4173';

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const errors = [];

/** Positions and states of the start-screen pieces. */
const snapshot = (page) =>
  page.evaluate(() => {
    const rect = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        y: Math.round(r.y),
        w: Math.round(r.width),
        display: cs.display,
        opacity: +Number(cs.opacity).toFixed(2),
      };
    };
    const btn = document.getElementById('btnPlay');
    const spinner = document.getElementById('playSpinner');
    return {
      ready: document.getElementById('start')?.classList.contains('ready') ?? false,
      brand: rect('brand-probe') ?? (() => {
        const el = document.querySelector('#start .brand');
        const r = el.getBoundingClientRect();
        return { y: Math.round(r.y), w: Math.round(r.width) };
      })(),
      hint: rect('startHint'),
      field: rect('nameField'),
      input: rect('nameInput'),
      button: { ...rect('btnPlay'), disabled: !!btn?.disabled, label: btn?.textContent?.trim() },
      spinnerAnimated: spinner
        ? getComputedStyle(spinner).animationName !== 'none'
        : false,
      inputValue: document.getElementById('nameInput')?.value ?? null,
    };
  });

try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/AudioContext|audio device|Pointer Lock/i.test(m.text())) {
      errors.push(m.text());
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Catch the loading state before the world finishes building.
  const loading = await snapshot(page);
  await page.screenshot({ path: join(here, 'start_loading.png') });

  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  // Let the transitions finish before measuring where anything ended up.
  await page.waitForTimeout(1400);
  const ready = await snapshot(page);
  await page.screenshot({ path: join(here, 'start_ready.png') });

  // Type a name and play.
  await page.fill('#nameInput', '  Kairozun  ');
  await page.click('#btnPlay');
  await page.waitForTimeout(1200);
  const afterPlay = await page.evaluate(() => ({
    startHidden: document.getElementById('start')?.classList.contains('hidden') ?? false,
    stored: localStorage.getItem('arena.name'),
    netName: window.arena?.scene?.net?.remotePlayers ? 'net-ready' : 'no-net',
  }));

  // Reopen in the same context: the name must come back.
  const page2 = await ctx.newPage();
  page2.setDefaultTimeout(240000);
  await page2.goto(url, { waitUntil: 'domcontentloaded' });
  await page2.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page2.waitForTimeout(900);
  const revisit = await page2.evaluate(() => document.getElementById('nameInput')?.value ?? '');

  console.log('=== START SCREEN PROBE ===');
  console.log(`loading: ${JSON.stringify(loading.button)} spinner=${loading.spinnerAnimated}`);
  console.log(`ready:   ${JSON.stringify(ready.button)} spinner=${ready.spinnerAnimated}`);
  console.log(`  brand y ${loading.brand.y} -> ${ready.brand.y}`);
  console.log(`  hint  ${JSON.stringify(loading.hint)} -> ${JSON.stringify(ready.hint)}`);
  console.log(`  name field ${JSON.stringify(loading.field)} -> ${JSON.stringify(ready.field)}`);
  console.log(`after play: ${JSON.stringify(afterPlay)}`);
  console.log(`name on revisit: ${JSON.stringify(revisit)}`);

  const spinnerWhileLoading = loading.spinnerAnimated && loading.button.disabled;
  const fieldHiddenWhileLoading = loading.field?.display === 'none';
  const fieldShownWhenReady = ready.field?.display === 'flex' && ready.input.w > 100;
  // The title lifts and the prompt drops. Both are transforms, so the measured
  // top edge is what proves the animation actually ran rather than the class
  // merely being present.
  const brandLifted = ready.brand.y < loading.brand.y - 20;
  const hintDropped = ready.hint.y > loading.hint.y + 20 && ready.hint.opacity < 0.2;
  const played = afterPlay.startHidden;
  // Trimmed on the way in, so the stored value must not carry the spaces typed.
  const nameStored = afterPlay.stored === 'Kairozun';
  const namePersisted = revisit === 'Kairozun';

  console.log(`spinner spins while loading:   ${spinnerWhileLoading ? 'ok' : 'FAIL'}`);
  console.log(`name field hidden until ready: ${fieldHiddenWhileLoading ? 'ok' : 'FAIL'}`);
  console.log(`name field appears when ready: ${fieldShownWhenReady ? 'ok' : 'FAIL'}`);
  console.log(`title lifts:                   ${brandLifted ? 'ok' : 'FAIL'}`);
  console.log(`prompt drops away:             ${hintDropped ? 'ok' : 'FAIL'}`);
  console.log(`play enters the game:          ${played ? 'ok' : 'FAIL'}`);
  console.log(`name saved, trimmed:           ${nameStored ? 'ok' : 'FAIL'} (${afterPlay.stored})`);
  console.log(`name persists on revisit:      ${namePersisted ? 'ok' : 'FAIL'} (${revisit})`);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 6)) console.log(' ', e);

  const pass =
    spinnerWhileLoading &&
    fieldHiddenWhileLoading &&
    fieldShownWhenReady &&
    brandLifted &&
    hintDropped &&
    played &&
    nameStored &&
    namePersisted &&
    errors.length === 0;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
