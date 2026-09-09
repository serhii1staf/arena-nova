// Verifies what one player's body actually looks like to another.
//
// Three reported bugs shared one cause: the lobby published the *camera* rather
// than the player. Each is checked separately here, from the receiving client's
// point of view, because that is the only place the symptom was visible.
//
//  - Turning on the spot moved the orbiting camera sideways around the body, so
//    remote viewers saw the avatar slide left and right instead of rotating.
//  - The yaw sent was `camera.rotation.y`, an XYZ re-derivation of a YXZ-composed
//    quaternion, which only matches the intended yaw at level pitch — so looking
//    up or down twisted the reported facing and steep pitch flipped it, and two
//    players facing each other each saw the other's back.
//  - The y sent was camera height minus eye height, which only cancels in first
//    person, so pitching or zooming lifted the avatar off the ground.
//
// Both scenes are checked, since the lobby was the one that had drifted.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4173';
const room = `facing-${Math.random().toString(36).slice(2, 8)}`;
const errors = [];

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});

async function spawnClient(label) {
  const ctx = await browser.newContext({ viewport: { width: 700, height: 460 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`);
  });
  await page.goto(`${url}/?room=${room}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  // A frame counter, so the probe can wait for the client to actually be
  // rendering. Interpolation only advances inside the frame loop, so a client
  // that is online but still building its scene reports stale values.
  await page.evaluate(() => {
    window.__frames = 0;
    const tick = () => {
      window.__frames++;
      requestAnimationFrame(tick);
    };
    tick();
  });
  return page;
}

/** Waits until the page has rendered 
 frames since it started counting. */
async function waitForFrames(page, n) {
  await page.waitForFunction((want) => window.__frames >= want, n, { timeout: 240000 });
}

/** What B currently believes about A. */
const observed = (page, id) =>
  page.evaluate((otherId) => {
    const p = window.arena.scene.net.remotePlayers.get(otherId);
    if (!p) return null;
    return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(3) };
  }, id);

/** A's own truth, for comparison. */
const truth = (page) =>
  page.evaluate(() => {
    const pl = window.arena.scene.player;
    const f = pl.feetPosition;
    return {
      x: +f.x.toFixed(2),
      y: +f.y.toFixed(2),
      z: +f.z.toFixed(2),
      yaw: +pl.viewYaw.toFixed(3),
    };
  });

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const angleDiff = (a, b) => Math.abs(wrap(a - b));

/**
 * Polls until B's view of A stops changing.
 *
 * A fixed pause is not usable here. Two browser contexts both rendering the world
 * in software manage roughly a frame a second between them, and the values under
 * test are only advanced inside the frame loop — publishing on one side and
 * interpolation on the other. With a fixed wait every reading came back exactly
 * one measurement stale, which looks like a product bug and is not one.
 */
async function settle(page, id, timeoutMs = 30000) {
  const started = Date.now();
  let previous = null;
  let stableFor = 0;
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(500);
    const now = await observed(page, id);
    if (!now) continue;
    if (
      previous &&
      Math.hypot(now.x - previous.x, now.y - previous.y, now.z - previous.z) < 0.02 &&
      angleDiff(now.yaw, previous.yaw) < 0.01
    ) {
      stableFor++;
      // Two consecutive identical reads: the pipeline has drained.
      if (stableFor >= 2) return now;
    } else {
      stableFor = 0;
    }
    previous = now;
  }
  return previous;
}

try {
  console.log('=== FACING / POSITION PROBE ===');
  console.log(`room: ${room}`);
  const a = await spawnClient('A');
  const b = await spawnClient('B');

  let ida = null;
  let idb = null;
  for (let i = 0; i < 25; i++) {
    await a.waitForTimeout(1000);
    ida = await a.evaluate(() => window.arena.scene.net.localId);
    idb = await b.evaluate(() => window.arena.scene.net.localId);
    const seen = ida && idb ? await observed(b, ida) : null;
    if (seen) break;
  }
  if (!ida || !idb) throw new Error('clients never came online');

  // Both clients must be rendering before anything is measured.
  await waitForFrames(a, 20);
  await waitForFrames(b, 20);

  const results = [];

  async function check(name, sceneName) {
    // 1. Rotate A on the spot, with a pitch applied, and confirm B sees the body
    //    turn without the body moving.
    const before = await observed(b, ida);
    await a.evaluate(() => {
      const p = window.arena.scene.player;
      p.yaw = 0;
      p.pitch = 0;
      p.viewYaw = 0;
    });
    const at0 = await settle(b, ida);

    await a.evaluate(() => {
      const p = window.arena.scene.player;
      // A deliberate look-down, which is what used to corrupt the reported yaw.
      p.pitch = -0.9;
      p.yaw = Math.PI * 0.5;
      p.viewYaw = Math.PI * 0.5;
    });
    const at90 = await settle(b, ida);
    const truth90 = await truth(a);

    // 2. Zoom A's camera all the way out and confirm nothing about A moves.
    await a.evaluate(() => window.arena.scene.setCameraZoom(6.5));
    const zoomed = await settle(b, ida);
    await a.evaluate(() => window.arena.scene.setCameraZoom(0));
    const unzoomed = await settle(b, ida);

    const rotationSeen = angleDiff(at90.yaw, at0.yaw);
    const yawMatchesTruth = angleDiff(at90.yaw, truth90.yaw);
    const driftWhileRotating = Math.hypot(at90.x - at0.x, at90.z - at0.z);
    const driftWhileZooming = Math.hypot(zoomed.x - at90.x, zoomed.z - at90.z);
    const liftWhileZooming = Math.abs(zoomed.y - at90.y);

    results.push({
      name,
      sceneName,
      before,
      at0,
      at90,
      truth90,
      zoomed,
      unzoomed,
      rotationSeen: +rotationSeen.toFixed(3),
      yawMatchesTruth: +yawMatchesTruth.toFixed(3),
      driftWhileRotating: +driftWhileRotating.toFixed(2),
      driftWhileZooming: +driftWhileZooming.toFixed(2),
      liftWhileZooming: +liftWhileZooming.toFixed(2),
    });
  }

  await check('lobby', 'lobby');

  // Both step into the open world and repeat.
  for (const p of [a, b]) {
    await p.evaluate(() => window.arena.engine.requestScene('exterior'));
  }
  for (const p of [a, b]) {
    await p.waitForFunction(
      () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene,
      { timeout: 240000 },
    );
  }
  await a.waitForTimeout(2500);
  await check('exterior', 'exterior');

  let pass = true;
  for (const r of results) {
    // Rotating 90° must show up as ~90° of rotation and essentially no движение.
    const rotated = Math.abs(r.rotationSeen - Math.PI / 2) < 0.15;
    const agrees = r.yawMatchesTruth < 0.12;
    const still = r.driftWhileRotating < 0.35;
    const zoomInert = r.driftWhileZooming < 0.35 && r.liftWhileZooming < 0.35;
    const ok = rotated && agrees && still && zoomInert;
    if (!ok) pass = false;
    console.log(`--- ${r.name} ---`);
    console.log(`  A truth at 90°:      ${JSON.stringify(r.truth90)}`);
    console.log(`  B sees A at 0°:      ${JSON.stringify(r.at0)}`);
    console.log(`  B sees A at 90°:     ${JSON.stringify(r.at90)}`);
    console.log(`  B sees A zoomed out: ${JSON.stringify(r.zoomed)}`);
    console.log(`  rotation observed ≈ 90°:      ${rotated ? 'ok' : 'FAIL'} (${r.rotationSeen} rad)`);
    console.log(`  yaw agrees with sender:       ${agrees ? 'ok' : 'FAIL'} (off by ${r.yawMatchesTruth} rad)`);
    console.log(`  body stays put while turning: ${still ? 'ok' : 'FAIL'} (moved ${r.driftWhileRotating} m)`);
    console.log(
      `  zoom does not move the body:  ${zoomInert ? 'ok' : 'FAIL'} (moved ${r.driftWhileZooming} m, lifted ${r.liftWhileZooming} m)`,
    );
  }

  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log(' ', e);
  if (errors.length) pass = false;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
