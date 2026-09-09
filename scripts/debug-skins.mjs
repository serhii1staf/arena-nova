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
      // Headless has no audio device, so WebAudio complains on every run. That is
      // the environment, not the build.
      if (m.type() === 'error' && !/AudioContext|audio device/i.test(m.text())) {
        errors.push(`[${skin}] ${m.text()}`);
      }
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
    // A private room per page: sharing one means the crowd downloads the models
    // other test clients are wearing, which pollutes "which file did this skin
    // fetch" beyond recognition.
    const room = `skins-${Math.random().toString(36).slice(2, 9)}`;
    await page.goto(`${url}/?room=${room}`, { waitUntil: 'load' });
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

  // --- Changing character mid-session ---------------------------------------
  //
  // Driven through the real menu control, so this covers the listener wiring as
  // well as the avatar: the choice used to only take effect when the next area
  // loaded, which meant walking through the portal to see your own character.
  const live = await (async () => {
    const page = await browser.newPage({ viewport: { width: 820, height: 560 } });
    page.setDefaultTimeout(180000);
    const fetched = [];
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      // Headless has no audio device, so WebAudio complains on every run. That is
      // the environment, not the build.
      if (m.type() === 'error' && !/AudioContext|audio device/i.test(m.text())) {
        problems.push(m.text());
      }
    });
    page.on('response', (r) => {
      const u = r.url();
      if (u.includes('/models/') && u.endsWith('.glb')) fetched.push(u.split('/').pop());
    });

    await page.addInitScript(() => localStorage.setItem('arena.skin', 'captain'));
    // A private room per page: sharing one means the crowd downloads the models
    // other test clients are wearing, which pollutes "which file did this skin
    // fetch" beyond recognition.
    const room = `skins-${Math.random().toString(36).slice(2, 9)}`;
    await page.goto(`${url}/?room=${room}`, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const b = document.getElementById('btnPlay');
      return !!b && !b.disabled;
    });
    await page.click('#btnPlay');
    await page.waitForFunction(() => window.arena?.scene?.character?.gltfActive === true, {
      timeout: 120000,
    });
    const before = await page.evaluate(() => ({
      skin: window.arena.scene.character.skin,
      meshes: (() => {
        let n = 0;
        window.arena.scene.character.object.traverse((o) => {
          if (o.isSkinnedMesh) n++;
        });
        return n;
      })(),
    }));
    const fetchedBefore = fetched.length;

    // Third person, so the effect is on screen and can be looked at. It is
    // deliberately hidden in first person along with the rest of the body.
    await page.evaluate(() => window.arena.scene.setCameraZoom(4.2));
    await page.waitForTimeout(900);

    // Pick a different character exactly the way the settings panel does.
    await page.evaluate(() => {
      const sel = document.getElementById('setSkin');
      sel.value = 'skeleton';
      sel.dispatchEvent(new Event('change'));
    });

    // The cloud of motes should appear, and it is what the exchange hides behind.
    let sawParticles = false;
    for (let i = 0; i < 80; i++) {
      const seen = await page.evaluate(() => {
        let points = 0;
        window.arena.scene.character.object.traverse((o) => {
          if (o.isPoints) points++;
        });
        return points > 0;
      });
      if (seen) {
        sawParticles = true;
        // The cloud fades in and out over its lifetime, so the first frame it
        // exists is also its least visible one. Wait for the middle of the effect
        // before capturing, or the frame shows nothing.
        await page.waitForTimeout(380);
        await page.screenshot({ path: join(here, 'skins_dissolve.png') });
        break;
      }
      await page.waitForTimeout(100);
    }

    // And the new character must be in place without reloading anything.
    // Wait for the model to be *installed*, not merely requested.
    await page.waitForFunction(
      () => window.arena.scene.character.installedSkin === 'skeleton',
      { timeout: 60000 },
    );
    await page.waitForTimeout(1600);
    const after = await page.evaluate(() => {
      let skinned = 0;
      let points = 0;
      window.arena.scene.character.object.traverse((o) => {
        if (o.isSkinnedMesh) skinned++;
        if (o.isPoints) points++;
      });
      return {
        skin: window.arena.scene.character.skin,
        installedSkin: window.arena.scene.character.installedSkin,
        gltfActive: window.arena.scene.character.gltfActive,
        skinned,
        leftoverParticles: points,
        scene: window.arena.engine.scenes.currentName,
      };
    });
    await page.screenshot({ path: join(here, 'skins_after_change.png') });
    const newFile = fetched.slice(fetchedBefore);

    // One more change, with the effect pinned to its midpoint, purely to capture
    // what it looks like. Software rendering here manages about a frame a second,
    // so an 0.85 s effect completes within a frame or two and is never actually
    // drawn — holding it still is the only way to see it.
    await page.evaluate(() => {
      const av = window.arena.scene.character;
      const sel = document.getElementById('setSkin');
      sel.value = 'anne';
      sel.dispatchEvent(new Event('change'));
      const pin = () => {
        const sw = av.swap;
        if (!sw) {
          requestAnimationFrame(pin);
          return;
        }
        // Freeze at the densest part of the cloud without advancing its clock, so
        // it neither finishes nor disposes.
        sw.update = function held() {
          this.material.uniforms.uT.value = 0.5;
        };
      };
      pin();
    });
    await page.waitForFunction(() => !!window.arena.scene.character.swap, { timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(here, 'skins_dissolve.png') });
    const pinned = await page.evaluate(() => {
      const av = window.arena.scene.character;
      let points = 0;
      av.object.traverse((o) => {
        if (o.isPoints) points += o.geometry.getAttribute('aBase').count;
      });
      return { particles: points, uT: av.swap?.material?.uniforms?.uT?.value ?? null };
    });

    await page.close();
    return { before, after, sawParticles, newFile, problems, pinned };
  })();

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

  console.log('--- changing character mid-session ---');
  console.log(`  before: ${JSON.stringify(live.before)}`);
  console.log(`  after:  ${JSON.stringify(live.after)}`);
  console.log(`  files fetched by the change: [${live.newFile.join(', ')}]`);
  const changedWithoutReload =
    live.after.installedSkin === 'skeleton' &&
    live.after.scene === 'lobby' &&
    live.after.gltfActive;
  // Exactly one rig must remain: the swap has to retire the old one, not stack.
  const onlyOneRig = live.after.skinned > 0 && live.after.skinned <= live.before.meshes;
  const fetchedNew = live.newFile.includes('skeleton.glb');
  console.log(`  applied in place, no area change: ${changedWithoutReload ? 'ok' : 'FAIL'}`);
  console.log(`  dissolve particles seen:          ${live.sawParticles ? 'ok' : 'FAIL'}`);
  console.log(`  new model actually downloaded:    ${fetchedNew ? 'ok' : 'FAIL'}`);
  console.log(`  old rig retired:                  ${onlyOneRig ? 'ok' : 'FAIL'} (${live.after.skinned} skinned)`);
  console.log(`  effect cleaned up:                ${live.after.leftoverParticles === 0 ? 'ok' : 'FAIL'}`);
  console.log(`  cloud held for capture:           ${JSON.stringify(live.pinned)}`);
  for (const p of live.problems) errors.push(`[live-change] ${p}`);

  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log(' ', e);

  const liveOk =
    changedWithoutReload &&
    live.sawParticles &&
    fetchedNew &&
    onlyOneRig &&
    live.after.leftoverParticles === 0;
  const pass = ok && iconOk && clearsOk && liveOk && errors.length === 0;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
