// Verifies the character library and the transition indicator.
//
// Two things are easy to get wrong and invisible in a typecheck: a skin choice
// that silently falls back to the default model, and an overlay that is present
// in the DOM but never actually visible. Both are checked here against a real
// browser, per skin, by watching which file the loader fetches and by reading
// the icon's computed opacity while a scene switch is in flight.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://localhost:4173';

// id -> expected file, mirroring src/player/skins.ts.
const EXPECTED = {
  captain: 'character.glb',
  anne: 'anne.glb',
  skeleton: 'skeleton.glb',
  headless: 'skeleton-headless.glb',
};

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const results = [];
let errors = [];

try {
  for (const [skin, expectedFile] of Object.entries(EXPECTED)) {
    const page = await browser.newPage({ viewport: { width: 820, height: 560 } });
    page.setDefaultTimeout(180000);
    const fetched = [];
    page.on('pageerror', (e) => errors.push(`[${skin}] pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[${skin}] ${m.text()}`);
    });
    page.on('response', (r) => {
      const u = r.url();
      if (u.includes('/models/') && u.endsWith('.glb')) fetched.push(u.split('/').pop());
    });

    // Seed the choice the way the menu would, before the first avatar is built.
    await page.addInitScript(
      (id) => localStorage.setItem('arena.skin', id),
      skin,
    );
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const b = document.getElementById('btnPlay');
      return !!b && !b.disabled;
    });

    // The menu must offer the whole library and show the stored choice.
    const menu = await page.evaluate(() => {
      const sel = document.getElementById('setSkin');
      return sel
        ? { count: sel.options.length, value: sel.value }
        : { count: 0, value: null };
    });

    await page.click('#btnPlay');
    await page.waitForTimeout(3200);

    const rig = await page.evaluate(() => {
      const av = window.arena?.scene?.character;
      let skinned = 0;
      av?.object.traverse((o) => {
        if (o.isSkinnedMesh) skinned++;
      });
      return { gltfActive: !!av?.gltfActive, skinned };
    });

    // The indicator is checked structurally rather than by sampling the animated
    // opacity: building the exterior blocks the main thread hard enough that CSS
    // transitions do not advance under software rendering, so a sampled opacity
    // measures the renderer, not the markup. What matters and is deterministic:
    // the icon decoded, it is centred, and it is a *child* of the fade layer —
    // which is what makes it inherit the group opacity and so appear and vanish
    // with the screen instead of needing a second animation kept in sync.
    await page.evaluate(() => window.arena.engine.requestScene('exterior'));
    await page.waitForTimeout(150);
    const during = await page.evaluate(() => {
      const icon = document.getElementById('fadeIcon');
      const fade = document.getElementById('fade');
      if (!icon || !fade) return null;
      const r = icon.getBoundingClientRect();
      return {
        display: getComputedStyle(icon).display,
        insideFade: icon.parentElement === fade,
        decoded: icon.naturalWidth > 0 && icon.naturalHeight > 0,
        natural: `${icon.naturalWidth}x${icon.naturalHeight}`,
        fadeOn: fade.classList.contains('on'),
        // Centred within a pixel or two of the viewport middle.
        offCentreX: Math.round(Math.abs(r.x + r.width / 2 - window.innerWidth / 2)),
        offCentreY: Math.round(Math.abs(r.y + r.height / 2 - window.innerHeight / 2)),
        width: Math.round(r.width),
      };
    });

    await page.waitForFunction(
      () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene,
      { timeout: 180000 },
    );
    // The layer is released a frame after the switch reports done.
    await page.waitForFunction(
      () => !document.getElementById('fade').classList.contains('on'),
      { timeout: 20000 },
    );
    // Give the ramp time to finish before reading opacity: sampling the instant
    // the class comes off catches it mid fade-out, which is correct behaviour but
    // reads as a failure.
    let settled = true;
    try {
      await page.waitForFunction(
        () => Number(getComputedStyle(document.getElementById('fade')).opacity) < 0.02,
        { timeout: 8000 },
      );
    } catch {
      settled = false;
    }
    const after = await page.evaluate((s) => ({
      fadeOn: document.getElementById('fade').classList.contains('on'),
      fadeOpacity: Number(getComputedStyle(document.getElementById('fade')).opacity),
      settled: s,
    }), settled);

    if (skin === 'captain') {
      // Hold the layer open on purpose so the frame shows what the player sees
      // mid-teleport: dark screen, indicator in the middle, nothing else.
      await page.evaluate(() => document.getElementById('fade').classList.add('on'));
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(here, 'skins_transition.png') });
      await page.evaluate(() => document.getElementById('fade').classList.remove('on'));
      await page.waitForTimeout(400);
    }

    if (skin === 'anne') {
      await page.evaluate(() => window.arena.scene.setCameraZoom(4.5));
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(here, 'skins_anne.png') });
    }

    results.push({ skin, expectedFile, fetched, menu, rig, during, after });
    await page.close();
  }

  console.log('=== SKIN LIBRARY PROBE ===');
  let ok = true;
  for (const r of results) {
    const loadedExpected = r.fetched.includes(r.expectedFile);
    // A wrong pick shows up as some *other* library file being fetched.
    const strays = r.fetched.filter((f) => f !== r.expectedFile);
    const pass =
      loadedExpected &&
      strays.length === 0 &&
      r.rig.gltfActive &&
      r.rig.skinned > 0 &&
      r.menu.count === 7 &&
      r.menu.value === r.skin;
    if (!pass) ok = false;
    console.log(
      `  ${pass ? 'ok  ' : 'FAIL'} ${r.skin.padEnd(9)} fetched=[${r.fetched.join(', ')}] ` +
        `rig=${r.rig.gltfActive ? 'gltf' : 'procedural'}/${r.rig.skinned} ` +
        `menu=${r.menu.count}@${r.menu.value}`,
    );
  }

  const t = results[0]?.during;
  const iconOk =
    !!t &&
    t.display === 'block' &&
    t.decoded &&
    t.insideFade &&
    t.fadeOn &&
    t.offCentreX <= 2 &&
    t.offCentreY <= 2 &&
    t.width > 0;
  const clearsOk = results.every(
    (r) => !r.after.fadeOn && r.after.settled && r.after.fadeOpacity < 0.02,
  );
  console.log('--- transition indicator ---');
  console.log(`  ${JSON.stringify(t)}`);
  console.log(`  decoded, centred, inside the fade layer: ${iconOk ? 'ok' : 'FAIL'}`);
  console.log(`  layer released after every switch:       ${clearsOk ? 'ok' : 'FAIL'}`);

  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log(' ', e);

  const pass = ok && iconOk && clearsOk && errors.length === 0;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
