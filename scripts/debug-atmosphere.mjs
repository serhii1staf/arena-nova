// Captures the open world at several times of day and reports what the
// atmosphere layers are actually doing.
//
// Fog density, mist and the vignette are all continuous functions of the sun's
// elevation, so a single screenshot proves nothing. This drives the clock to
// specific times, waits for the eased values to settle, and reads the numbers as
// well as capturing the frame.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://localhost:4173';

// t01: 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
const TIMES = [
  { name: 'noon', t: 0.5 },
  { name: 'sunset', t: 0.76 },
  { name: 'night', t: 0.02 },
];

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.setDefaultTimeout(240000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/AudioContext|audio device/i.test(m.text())) {
      errors.push(m.text());
    }
  });

  await page.goto(`${url}/?room=atmo-${Math.random().toString(36).slice(2, 8)}`, {
    waitUntil: 'load',
  });
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

  // Stand in a wood, where mist and fog are supposed to be at their thickest,
  // and look along the ground rather than at the sky.
  const placed = await page.evaluate(() => {
    const scene = window.arena.scene;
    for (let r = 60; r < 420; r += 12) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const x = Math.cos(ang) * r;
        const z = Math.sin(ang) * r;
        const b = scene.world.stats && window.arena.biomeAt ? null : null;
        void b;
        // Read the biome the same way the world does.
        const biome = scene.world.stats().biome;
        void biome;
        // No direct biomeAt on the scene, so probe by moving and asking.
        scene.player.spawn(x, z, ang);
        const here = scene.world.stats().biome;
        if (here === 'pine' || here === 'jungle' || here === 'wetland') {
          scene.setCameraZoom(4.5);
          return { x, z, biome: here };
        }
      }
    }
    scene.setCameraZoom(4.5);
    return { x: 0, z: 15, biome: scene.world.stats().biome };
  });

  const results = [];
  for (const t of TIMES) {
    await page.evaluate((t01) => {
      window.arena.scene.dayNight.t01 = t01;
    }, t.t);
    // The mist and fog multipliers are eased with a ~2 s time constant, so give
    // them time to arrive rather than sampling the value they are leaving.
    await page.waitForTimeout(6000);
    const state = await page.evaluate(() => {
      const s = window.arena.scene;
      const dn = s.dayNight;
      let mistPoints = 0;
      let mistVisible = false;
      let petalVisible = false;
      s.world.group.traverse((o) => {
        if (o.name === 'GroundMist') {
          mistVisible = o.visible;
          mistPoints = o.geometry.getAttribute('position').count;
        }
        if (o.name === 'Petals') petalVisible = o.visible;
      });
      return {
        t01: +dn.t01.toFixed(3),
        nightFactor: +dn.nightFactor.toFixed(3),
        mistAmount: +dn.mistAmount.toFixed(3),
        fogDensity: +s.scene.fog.density.toFixed(6),
        fogColor: s.scene.fog.color.getHexString(),
        sunIntensity: +s.sun.intensity.toFixed(2),
        moonIntensity: +s.moon.intensity.toFixed(2),
        hemiIntensity: +s.hemi.intensity.toFixed(2),
        starOpacity: +dn.starOpacity.toFixed(3),
        mistVisible,
        mistPoints,
        petalVisible,
        godRaysSource: !!s.godRaysSource,
        biome: s.world.stats().biome,
      };
    });
    await page.screenshot({ path: join(here, `atmo_${t.name}.png`) });
    results.push({ name: t.name, ...state });
  }

  // The mist density where the probe happens to be standing is low by design, so
  // the numbers above cannot show whether the layer actually *looks* like mist.
  // Force it near its ceiling — what a wetland at night produces — and capture.
  const forced = await page.evaluate(() => {
    const dn = window.arena.scene.dayNight;
    Object.defineProperty(dn, 'mistAmount', { get: () => 0.92, set: () => {}, configurable: true });
    return true;
  });
  void forced;
  await page.waitForTimeout(3500);
  await page.screenshot({ path: join(here, 'atmo_mist.png') });
  const mistShot = await page.evaluate(() => {
    let visible = false;
    let opacity = null;
    window.arena.scene.world.group.traverse((o) => {
      if (o.name === 'GroundMist') {
        visible = o.visible;
        opacity = o.material.uniforms.uOpacity.value;
      }
    });
    return { visible, opacity };
  });

  console.log('=== ATMOSPHERE PROBE ===');
  console.log(`standing in: ${placed.biome} at (${Math.round(placed.x)}, ${Math.round(placed.z)})`);
  for (const r of results) {
    console.log(`--- ${r.name} (t01 ${r.t01}) ---`);
    console.log(`  night=${r.nightFactor} mist=${r.mistAmount} visible=${r.mistVisible} (${r.mistPoints} patches)`);
    console.log(`  fog density=${r.fogDensity} colour=#${r.fogColor}`);
    console.log(`  sun=${r.sunIntensity} moon=${r.moonIntensity} hemi=${r.hemiIntensity} stars=${r.starOpacity}`);
  }

  const noon = results.find((r) => r.name === 'noon');
  const night = results.find((r) => r.name === 'night');
  const sunset = results.find((r) => r.name === 'sunset');

  // Night must genuinely be darker and thicker than noon, and the mist must be a
  // night/dusk phenomenon rather than permanently on.
  const darker = night.hemiIntensity < noon.hemiIntensity && night.sunIntensity < 0.2;
  const thicker = night.fogDensity > noon.fogDensity;
  const mistRises = night.mistAmount > noon.mistAmount && night.mistVisible;
  const duskMist = sunset.mistAmount > noon.mistAmount;
  const moonUp = night.moonIntensity > 0.3;
  const stars = night.starOpacity > 0.5;
  const rays = results.every((r) => r.godRaysSource);

  console.log(`night darker than noon:      ${darker ? 'ok' : 'FAIL'}`);
  console.log(`night air thicker than noon: ${thicker ? 'ok' : 'FAIL'}`);
  console.log(`mist rises after dark:       ${mistRises ? 'ok' : 'FAIL'}`);
  console.log(`mist rises at dusk too:      ${duskMist ? 'ok' : 'FAIL'}`);
  console.log(`moon carries the night:      ${moonUp ? 'ok' : 'FAIL'}`);
  console.log(`stars come out:              ${stars ? 'ok' : 'FAIL'}`);
  console.log(`god-rays source present:     ${rays ? 'ok' : 'FAIL'}`);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 6)) console.log(' ', e);

  const pass = darker && thicker && mistRises && duskMist && moonUp && stars && rays && !errors.length;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
