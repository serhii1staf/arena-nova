// Verifies the admin building system end to end, against the live deployment.
//
// This probe exists because the feature shipped broken twice, and both faults were
// invisible to a type check. The first: placement was gated on
// `document.pointerLockElement`, which the desktop shell never sets because it
// confines the cursor itself — so left click did nothing in the installed app while
// working in a browser. The second: the vertical snap rounded instead of floored, so
// a level gaze put the first piece of every structure two metres in the air.
//
// So the checks below are deliberately about behaviour, not presence:
//   - both capture paths place a piece, including the native one that was dead;
//   - a piece placed while looking level rests on the ground, not above it;
//   - the icons contain a drawn shape rather than an empty or black square;
//   - a floor can be stood on and a ramp actually rises across its cell.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'https://arena-nova.odi44972.workers.dev';
const room = `build-${Math.random().toString(36).slice(2, 9)}`;
const ADMIN_PASS = process.env.ARENA_ADMIN_PASSWORD ?? '';
const errors = [];

if (!ADMIN_PASS) {
  console.log('ARENA_ADMIN_PASSWORD is unset — the bar is admin-gated, so nothing to test.');
  process.exit(1);
}

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});

try {
  console.log('=== BUILD SYSTEM PROBE ===');
  console.log(`room: ${room}`);

  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  page.on('pageerror', (e) => {
    if (/Pointer Lock/i.test(e.message)) return;
    errors.push(`pageerror: ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/AudioContext|audio device|Pointer Lock/i.test(m.text())) {
      errors.push(m.text());
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem('arena.name', 'Kairozun');
    localStorage.setItem('arena.skin', 'captain');
    localStorage.setItem('arena.owner', 'e'.repeat(8) + '1122334455667788aabbccddeeff0011');
  });
  await page.goto(`${url}/?room=${room}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  // Typed into the field rather than seeded into storage. Pressing Play saves
  // whatever the password box holds, so a seeded value is wiped by the empty box
  // before the socket ever opens — which is how a probe can silently test nothing.
  await page.fill('#passInput', ADMIN_PASS);
  await page.click('#btnPlay');

  // The hotbar only exists outdoors: the build site belongs to the exterior scene.
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  await page.waitForFunction(
    () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene?.buildSite,
    null,
    { timeout: 300000 },
  );
  // Admin rights arrive from the server after the socket opens, and the bar is gated
  // on them, so nothing below can be attempted until they land.
  const gotAdmin = await page
    .waitForFunction(() => window.arena.scene.net.isAdmin === true, null, { timeout: 120000 })
    .then(() => true)
    .catch(() => false);
  console.log(`admin granted: ${gotAdmin}`);

  await page.evaluate(() => {
    const w = window;
    w.probe = {
      site: () => w.arena.scene.buildSite,
      /** Puts the player somewhere flat-ish and points the view. */
      go(x, z, yaw, pitch) {
        const sc = w.arena.scene;
        sc.player.spawn(x, z, yaw);
        sc.player.pitch = pitch;
        sc.player.update(0.016);
        sc.render(1, 0.016);
        sc.render(1, 0.016);
      },
      frame() {
        const sc = w.arena.scene;
        sc.player.update(0.016);
        sc.render(1, 0.016);
      },
      state() {
        const s = w.arena.scene.buildSite;
        const hud = document.getElementById('buildHud');
        return {
          active: s.active,
          selected: s.selected,
          count: s.count(),
          hudShown: !!hud && !hud.hidden,
          slots: document.querySelectorAll('.buildSlot').length,
          lit: document.querySelectorAll('.buildSlot.on').length,
        };
      },
    };
  });

  const state = () => page.evaluate(() => window.probe.state());
  const go = (x, z, yaw, pitch = 0) =>
    page.evaluate(([a, b, c, d]) => window.probe.go(a, b, c, d), [x, z, yaw, pitch]);

  const before = await state();

  // ---- Open the bar --------------------------------------------------------
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(500);
  const opened = await state();
  console.log(`after B: ${JSON.stringify(opened)}`);

  // ---- Icons ---------------------------------------------------------------
  // Read the actual pixels of each slot's background. An icon that failed to render
  // leaves an empty square, which satisfies every count and attribute check.
  const iconsReady = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.buildIcon')].every((el) =>
          /^url\("data:image\/png/.test(getComputedStyle(el).backgroundImage),
        ),
      null,
      { timeout: 120000 },
    )
    .then(() => true)
    .catch(() => false);

  const icons = await page.evaluate(async () => {
    const out = [];
    for (const el of document.querySelectorAll('.buildIcon')) {
      const m = /^url\("(data:image\/png[^"]+)"\)$/.exec(getComputedStyle(el).backgroundImage);
      if (!m) {
        out.push(null);
        continue;
      }
      const img = new Image();
      img.src = m[1];
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      let lum = 0;
      let fingerprint = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 24) {
          opaque++;
          lum += (d[i] + d[i + 1] + d[i + 2]) / 3;
        }
        fingerprint = (fingerprint * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) % 1e9;
      }
      out.push({
        coverage: +(opaque / Math.max(1, c.width * c.height)).toFixed(3),
        brightness: opaque ? Math.round(lum / opaque) : 0,
        fingerprint,
      });
    }
    return out;
  });
  await page.screenshot({ path: join(here, 'build_bar.png') });

  // ---- Placement, native capture path --------------------------------------
  // This is the regression that made the feature dead in the installed app. The
  // desktop shell confines the cursor itself and never enters Pointer Lock, so
  // `input.locked` is the only true signal — and the click can land on any element,
  // not just the canvas. Both conditions are reproduced exactly.
  await go(0, 0, Math.PI, 0);
  const nativePlace = await page.evaluate(() => {
    const w = window;
    w.arena.engine.input.locked = true;
    const n0 = w.probe.site().count();
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, bubbles: true, composed: true }),
    );
    return { from: n0, to: w.probe.site().count() };
  });
  console.log(`native-capture click: ${JSON.stringify(nativePlace)}`);

  // Where did it land? Looking level, the piece must rest on the ground in front of
  // the player rather than hang a level above it.
  const resting = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    // The preview is the one mesh with a transparent material; everything else in
    // the group has been placed.
    let piece = null;
    s.group.traverse((o) => {
      if (!piece && o.isMesh && o.material?.transparent !== true) piece = o;
    });
    if (!piece) return null;
    const ground = sc.world.floorHeightAt(piece.position.x, piece.position.z);
    return {
      base: +(piece.position.y - 2).toFixed(2), // a wall's origin is half a cell up
      ground: +ground.toFixed(2),
      gap: +(piece.position.y - 2 - ground).toFixed(2),
    };
  });
  console.log(`first wall: ${JSON.stringify(resting)}`);

  // ---- Placement, browser path ---------------------------------------------
  // Capture off, a real click on the canvas. This is how it behaves in a browser
  // where Pointer Lock was refused, and it must work there too.
  await page.evaluate(() => {
    window.arena.engine.input.locked = false;
  });
  await go(40, 40, 0, 0);
  const n0 = (await state()).count;
  await page.mouse.click(450, 300);
  await page.waitForTimeout(300);
  const browserPlace = { from: n0, to: (await state()).count };
  console.log(`canvas click (no capture): ${JSON.stringify(browserPlace)}`);

  // ---- Enter also places ---------------------------------------------------
  await go(-40, 40, 0, 0);
  const n1 = (await state()).count;
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const enterPlace = { from: n1, to: (await state()).count };
  console.log(`enter key: ${JSON.stringify(enterPlace)}`);

  // ---- Selecting by number, and rotating -----------------------------------
  await page.keyboard.press('Digit2');
  await page.waitForTimeout(250);
  const picked = await state();
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(200);

  // ---- A floor can be stood on --------------------------------------------
  // Placed, then queried through the same call the player controller uses. The
  // collider registry cannot express a slab, so this goes through `heightAt`.
  const floorStands = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.select('floor');
    sc.player.spawn(120, 120, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    let slab = null;
    s.group.traverse((o) => {
      if (o.isMesh && o.geometry?.type === 'BoxGeometry' && o.material?.transparent !== true) {
        if (Math.abs(o.position.x) > 100) slab = o;
      }
    });
    if (!slab) return { placed: true, found: false };
    const x = slab.position.x;
    const z = slab.position.z;
    const ground = sc.world.floorHeightAt(x, z);
    const withPiece = s.heightAt(x, z, ground);
    // Well outside the slab, the answer must be untouched.
    const away = s.heightAt(x + 60, z + 60, ground);
    return {
      placed: true,
      found: true,
      ground: +ground.toFixed(2),
      onTop: +withPiece.toFixed(2),
      lift: +(withPiece - ground).toFixed(2),
      awayUnchanged: Math.abs(away - ground) < 1e-6,
    };
  });
  console.log(`floor stands: ${JSON.stringify(floorStands)}`);

  // ---- A ramp rises across its cell ---------------------------------------
  const rampRises = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.select('ramp');
    sc.player.spawn(-160, 160, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    let wedge = null;
    s.group.traverse((o) => {
      if (o.isMesh && o.material?.transparent !== true && o.geometry?.type === 'BufferGeometry') {
        if (o.position.x < -100) wedge = o;
      }
    });
    if (!wedge) return { placed: true, found: false };
    const x = wedge.position.x;
    const z = wedge.position.z;
    const ground = sc.world.floorHeightAt(x, z);
    // Sampled along both axes, because the piece may have been rotated and the
    // slope only rises along one of them. Whichever axis it is must show a genuine
    // monotone climb across the cell — not a flat block and not a single step.
    const along = (axis) =>
      [-1.8, -0.9, 0, 0.9, 1.8].map((d) =>
        +(s.heightAt(axis === 'x' ? x + d : x, axis === 'z' ? z + d : z, ground) - ground).toFixed(
          2,
        ),
      );
    const pick = (v) => {
      const up = v.every((n, i) => i === 0 || n >= v[i - 1]);
      const down = v.every((n, i) => i === 0 || n <= v[i - 1]);
      return {
        v,
        ok: (up || down) && Math.abs(v[v.length - 1] - v[0]) > 2.5 && new Set(v).size >= 4,
      };
    };
    const ax = pick(along('x'));
    const az = pick(along('z'));
    const best = ax.ok ? ax : az;
    return {
      placed: true,
      found: true,
      x: ax.v,
      z: az.v,
      samples: best.v,
      rising: best.ok,
      span: +Math.abs(best.v[best.v.length - 1] - best.v[0]).toFixed(2),
    };
  });
  console.log(`ramp rises: ${JSON.stringify(rampRises)}`);

  // ---- Removing and clearing ----------------------------------------------
  const removed = await page.evaluate(() => {
    const s = window.arena.scene.buildSite;
    const before = s.count();
    const ok = s.removeAimed();
    return { ok, before, after: s.count() };
  });
  const cleared = await page.evaluate(() => {
    const s = window.arena.scene.buildSite;
    s.clear();
    return s.count();
  });
  console.log(`remove: ${JSON.stringify(removed)}  clear -> ${cleared}`);

  // ---- Closing the bar -----------------------------------------------------
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(400);
  const closed = await state();

  // ---- Report --------------------------------------------------------------
  const barOpens = opened.active && opened.hudShown && opened.slots === 6 && !before.hudShown;
  const iconsDrawn =
    iconsReady &&
    icons.length === 6 &&
    icons.every((i) => i && i.coverage > 0.05 && i.coverage < 0.99 && i.brightness >= 30);
  const iconsDiffer = new Set(icons.filter(Boolean).map((i) => i.fingerprint)).size >= 5;
  const nativeWorks = nativePlace.to === nativePlace.from + 1;
  const browserWorks = browserPlace.to === browserPlace.from + 1;
  const enterWorks = enterPlace.to === enterPlace.from + 1;
  // On the ground, not a level above it. A wall's underside must sit within a few
  // centimetres of the terrain it was placed on.
  const restsOnGround = !!resting && Math.abs(resting.gap) < 0.75;
  const digitSelects = picked.selected === 'floor' && picked.lit === 1;
  const floorWorks =
    floorStands.found === true &&
    floorStands.lift > 0.1 &&
    floorStands.lift < 1 &&
    floorStands.awayUnchanged === true;
  const rampWorks = rampRises.found === true && rampRises.rising === true && rampRises.span > 2.5;
  const removeWorks = removed.ok === true && removed.after === removed.before - 1;
  const clearWorks = cleared === 0;
  const barCloses = !closed.active && !closed.hudShown;

  const line = (label, ok, extra = '') =>
    console.log(`${label.padEnd(36)}${ok ? 'ok' : 'FAIL'}${extra ? ` ${extra}` : ''}`);
  line('admin granted:', gotAdmin);
  line('B opens the bar, 6 slots:', barOpens);
  line('icons drawn, not blank/black:', iconsDrawn, JSON.stringify(icons.map((i) => i?.coverage)));
  line('icons differ per piece:', iconsDiffer);
  line('click places (native capture):', nativeWorks, JSON.stringify(nativePlace));
  line('click places (canvas, browser):', browserWorks, JSON.stringify(browserPlace));
  line('Enter places:', enterWorks, JSON.stringify(enterPlace));
  line('piece rests on the ground:', restsOnGround, `gap=${resting?.gap}m`);
  line('number key selects:', digitSelects, picked.selected);
  line('floor can be stood on:', floorWorks, `lift=${floorStands.lift}m`);
  line(
    'ramp rises across its cell:',
    rampWorks,
    `x=${JSON.stringify(rampRises.x)} z=${JSON.stringify(rampRises.z)}`,
  );
  line('X removes one piece:', removeWorks);
  line('clear empties the site:', clearWorks);
  line('B closes the bar:', barCloses);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log(' ', e);

  const pass =
    gotAdmin &&
    barOpens &&
    iconsDrawn &&
    iconsDiffer &&
    nativeWorks &&
    browserWorks &&
    enterWorks &&
    restsOnGround &&
    digitSelects &&
    floorWorks &&
    rampWorks &&
    removeWorks &&
    clearWorks &&
    barCloses &&
    errors.length === 0;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
