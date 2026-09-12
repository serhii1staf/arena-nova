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
      /**
       * Where one instance of a kind actually sits. Pieces are drawn by one
       * `InstancedMesh` per kind, so there is no per-piece object to read a
       * position off — the transform lives in the instance matrix.
       */
      piece(kind, i = 0) {
        const s = w.arena.scene.buildSite;
        for (const c of s.group.children) {
          if (c.isInstancedMesh && c.name === `Build:${kind}` && c.count > i) {
            const m = c.matrixWorld.clone();
            c.getMatrixAt(i, m);
            return {
              x: m.elements[12],
              y: m.elements[13],
              z: m.elements[14],
              ry: Math.atan2(m.elements[8], m.elements[10]),
              count: c.count,
            };
          }
        }
        return null;
      },
      state() {
        const s = w.arena.scene?.buildSite;
        const hud = document.getElementById('buildHud');
        // A missing site means the scene changed under the probe, which is a real
        // finding and should be reported rather than thrown from a property read.
        if (!s) return { scene: w.arena.engine.scenes.currentName, gone: true };
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
  // Deliberately not near the origin: the portal home stands there, and the real
  // frame loop keeps running between these calls — so a probe parked on the portal
  // gets pulled back to the lobby mid-test, and the scene it was talking to is gone.
  await go(240, 240, Math.PI, 0);
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
    // Every piece is modelled with its underside on the floor of its slot, so its
    // origin *is* its base — no per-shape fudge factor.
    const piece = window.probe.piece('wall');
    if (!piece) return null;
    const ground = sc.world.floorHeightAt(piece.x, piece.z);
    return {
      base: +piece.y.toFixed(2),
      ground: +ground.toFixed(2),
      gap: +(piece.y - ground).toFixed(2),
      geoMinY: +s.geometryFor('wall').boundingBox.min.y.toFixed(2),
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
    const slab = window.probe.piece('floor', s.count() - 1) ?? window.probe.piece('floor', 0);
    if (!slab) return { placed: true, found: false };
    const x = slab.x;
    const z = slab.z;
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
    const wedge = window.probe.piece('ramp', 0);
    if (!wedge) return { placed: true, found: false };
    const x = wedge.x;
    const z = wedge.z;
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

  // ---- Every face points outwards -----------------------------------------
  // The previous ramp and roof were wound inside out, so their outer faces were
  // back-faces: culled from the only side you ever look at them from, which is why
  // they appeared transparent and unlit. Checked against the winding itself rather
  // than by eye, for all six pieces.
  const winding = await page.evaluate(() => {
    const s = window.arena.scene.buildSite;
    const kinds = [
      'wall',
      'doorway',
      'window',
      'floor',
      'ramp',
      'stairs',
      'roof',
      'pillar',
      'railing',
      'foundation',
    ];
    const out = {};
    for (const k of kinds) {
      const g = s.geometryFor(k);
      const p = g.getAttribute('position');
      const n = g.getAttribute('normal');
      let tris = 0;
      let inverted = 0;
      for (let i = 0; i + 2 < p.count; i += 3) {
        const ax = p.getX(i);
        const ay = p.getY(i);
        const az = p.getZ(i);
        const ex1 = p.getX(i + 1) - ax;
        const ey1 = p.getY(i + 1) - ay;
        const ez1 = p.getZ(i + 1) - az;
        const ex2 = p.getX(i + 2) - ax;
        const ey2 = p.getY(i + 2) - ay;
        const ez2 = p.getZ(i + 2) - az;
        // Winding normal, against the normal the geometry declares.
        const cx = ey1 * ez2 - ez1 * ey2;
        const cy = ez1 * ex2 - ex1 * ez2;
        const cz = ex1 * ey2 - ey1 * ex2;
        const len = Math.hypot(cx, cy, cz);
        if (len < 1e-9) continue;
        tris++;
        const dot = (cx * n.getX(i) + cy * n.getY(i) + cz * n.getZ(i)) / len;
        if (dot < 0.9) inverted++;
      }
      out[k] = { tris, inverted };
    }
    return out;
  });
  console.log(`winding: ${JSON.stringify(winding)}`);

  // ---- The wall's hitbox is a wall, not a bubble ---------------------------
  // A wall is four metres wide and a fifth of a metre thick. Describing it with a
  // circle wide enough to cover its width stopped the player two and a half metres
  // short of it from every direction, which is what "the hitbox is enormous" meant.
  const hitbox = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    s.select('wall');
    sc.player.spawn(200, 200, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    const wall = window.probe.piece('wall', 0);
    if (!wall) return { placed: true, found: false };
    const { x, y, z } = wall;
    // The wall's own rotation decides which axis it is thin on, so the walk is not
    // assuming an orientation. Its local +Z is the thin one; a quarter turn about Y
    // sends that to (sin ry, 0, cos ry).
    const ry = wall.ry;
    const nx = Math.sin(ry);
    const nz = Math.cos(ry);
    // Along the wall's face, perpendicular to the above.
    const tx = nz;
    const tz = -nx;
    // A plain object with the fields `collide` touches: it only reads and writes
    // x, y and z, so the probe does not need to build a real Vector3.
    const walkInto = (from) => {
      const p = { x: x + nx * from, y: y + 1, z: z + nz * from };
      // Stepped in repeatedly, as the controller does every frame you hold forward.
      const step = 0.12 * Math.sign(from);
      for (let i = 0; i < 60; i++) {
        p.x -= nx * step;
        p.z -= nz * step;
        s.collide(p, 0.4);
      }
      // Distance from the wall's own plane, which is the only distance that matters.
      return +Math.abs((p.x - x) * nx + (p.z - z) * nz).toFixed(2);
    };
    return {
      placed: true,
      found: true,
      turn: +ry.toFixed(2),
      // How close you end up after walking straight at the wall from either side.
      fromFront: walkInto(6),
      fromBack: walkInto(-6),
      // And a body beside the wall, past the end of its four-metre span, must not
      // be touched at all.
      pastTheEnd: (() => {
        const sx = x + tx * 3.2 + nx * 0.05;
        const sz = z + tz * 3.2 + nz * 0.05;
        const p = { x: sx, y: y + 1, z: sz };
        s.collide(p, 0.4);
        return +Math.hypot(p.x - sx, p.z - sz).toFixed(3);
      })(),
    };
  });
  console.log(`wall hitbox: ${JSON.stringify(hitbox)}`);

  // ---- The roof can be stood on -------------------------------------------
  const roofSolid = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    s.select('roof');
    sc.player.spawn(-200, -200, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    const roof = window.probe.piece('roof', 0);
    if (!roof) return { placed: true, found: false };
    const x = roof.x;
    const z = roof.z;
    const ground = sc.world.floorHeightAt(x, z);
    // A gable has a ridge, so it is flat along one axis and a tent across the other.
    // Both are sampled and the tent is whichever one it turns out to be, because the
    // piece may have been rotated.
    const along = (axis) =>
      [-1.9, -1, 0, 1, 1.9].map(
        (d) =>
          +(
            s.heightAt(axis === 'x' ? x + d : x, axis === 'z' ? z + d : z, ground) - ground
          ).toFixed(2),
      );
    const ax = along('x');
    const az = along('z');
    const isTent = (v) => v[2] > v[1] && v[1] > v[0] && v[2] > v[3] && v[3] > v[4];
    const profile = isTent(ax) ? ax : az;
    return { placed: true, found: true, x: ax, z: az, profile, ridge: profile[2] };
  });
  console.log(`roof: ${JSON.stringify(roofSolid)}`);

  // ---- Wood, not tinted stone ---------------------------------------------
  const wood = await page.evaluate(async () => {
    const s = window.arena.scene.buildSite;
    // Any of the instanced meshes: they all share the one timber material.
    const mesh = s.group.children.find((o) => o.isInstancedMesh) ?? null;
    const map = mesh?.material?.map;
    const src = map?.image;
    if (!src) return { hasMap: false };
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let r = 0;
    let gr = 0;
    let b = 0;
    const n = d.length / 4;
    // Variation along a row against variation down a column: grain running one way
    // makes a wood texture measurably smoother along the fibres than across them.
    let dU = 0;
    let dV = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      gr += d[i + 1];
      b += d[i + 2];
    }
    const at = (x, y) => d[(y * c.width + x) * 4];
    for (let y = 4; y < c.height - 4; y += 3) {
      for (let x = 4; x < c.width - 4; x += 3) {
        dU += Math.abs(at(x + 3, y) - at(x, y));
        dV += Math.abs(at(x, y + 3) - at(x, y));
      }
    }
    return {
      hasMap: true,
      size: c.width,
      r: Math.round(r / n),
      g: Math.round(gr / n),
      b: Math.round(b / n),
      alongGrain: +(dU / Math.max(1, dV)).toFixed(2),
      hasNormal: !!mesh.material.normalMap,
      hasRough: !!mesh.material.roughnessMap,
    };
  });
  console.log(`wood: ${JSON.stringify(wood)}`);

  // ---- The name is above the bar, not in the slots -------------------------
  const naming = await page.evaluate(() => {
    const s = window.arena.scene.buildSite;
    s.select('ramp');
    return {
      insideSlots: document.querySelectorAll('.buildSlot .buildName').length,
      label: document.getElementById('buildLabel')?.textContent?.trim() ?? '',
      labelAbove: (() => {
        const l = document.getElementById('buildLabel');
        const b = document.getElementById('buildBar');
        if (!l || !b) return false;
        return l.getBoundingClientRect().bottom <= b.getBoundingClientRect().top + 1;
      })(),
    };
  });
  // The label follows the piece in hand, so it has to change when the piece does.
  await page.keyboard.press('Digit3');
  await page.waitForTimeout(250);
  const labelRamp = await page.evaluate(
    () => document.getElementById('buildLabel')?.textContent?.trim() ?? '',
  );
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(250);
  const labelWall = await page.evaluate(
    () => document.getElementById('buildLabel')?.textContent?.trim() ?? '',
  );
  // Exactly one slot may look chosen. Read at the moment of the screenshot, because
  // "the label says wall but a different square is raised" is precisely the kind of
  // thing a screenshot shows and no earlier assertion would have caught.
  const litNow = await page.evaluate(() => ({
    lit: [...document.querySelectorAll('.buildSlot')].filter((s) => s.classList.contains('on'))
      .length,
    litKind:
      document.querySelector('.buildSlot.on')?.dataset.kind ?? null,
    // Measured, not read off the style. Chromium can leave an identity matrix in
    // the computed transform of an element that has merely *had* a transition, so
    // the string is not evidence of anything; where the box actually is, is.
    tops: [...document.querySelectorAll('.buildSlot')].map((s) =>
      Math.round(s.getBoundingClientRect().top),
    ),
  }));
  console.log(
    `naming: ${JSON.stringify(naming)} ramp="${labelRamp}" wall="${labelWall}" ${JSON.stringify(litNow)}`,
  );
  await page.screenshot({ path: join(here, 'build_bar.png') });

  // ---- Standing under a roof must not lift you onto it ---------------------
  // The complaint was being teleported to the top the moment you stepped under a
  // roof. `floorHeightAt` has no height in it, so the only answer it could give was
  // "the highest surface in this column", and the controller snapped to that.
  const underneath = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    sc.player.spawn(320, 320, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    // A floor two tiers up, so there is a genuine ceiling to walk under.
    s.select('floor');
    const cell = { x: Math.round(sc.player.feetPosition.x / 4) * 4, z: Math.round(sc.player.feetPosition.z / 4) * 4 };
    const ground = sc.world.floorHeightAt(cell.x, cell.z);
    // Placed by hand at a known height, so the test does not depend on aiming.
    s.select('floor');
    let placedHigh = false;
    for (let tries = 0; tries < 6 && !placedHigh; tries++) {
      sc.player.pitch = 0.55; // look up, which is how you build a storey above you
      sc.player.update(0.016);
      sc.render(1, 0.016);
      placedHigh = s.place();
    }
    if (!placedHigh) return { placed: false };
    // Find it, then ask from below and from above.
    const slab = window.probe.piece('floor', 0);
    if (!slab) return { placed: true, found: false };
    const sx = slab.x;
    const sz = slab.z;
    const slabY = slab.y;
    const g = sc.world.floorHeightAt(sx, sz);
    return {
      placed: true,
      found: true,
      ground: +g.toFixed(2),
      slab: +slabY.toFixed(2),
      // Asked from the ground: the answer must be the ground.
      fromBelow: +s.heightAt(sx, sz, g, g).toFixed(2),
      // Asked from just under the slab: still the ground, not the slab.
      fromJustBelow: +s.heightAt(sx, sz, g, slabY - 1.2).toFixed(2),
      // Asked from on top of it: the slab.
      fromAbove: +s.heightAt(sx, sz, g, slabY + 0.4).toFixed(2),
      // And with no height given at all, the old behaviour: the highest thing.
      unbounded: +s.heightAt(sx, sz, g).toFixed(2),
      groundRef: +ground.toFixed(2),
    };
  });
  console.log(`under a ceiling: ${JSON.stringify(underneath)}`);

  // ---- A doorway can be walked through ------------------------------------
  const door = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    s.select('doorway');
    sc.player.spawn(-320, 320, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    const piece = window.probe.piece('doorway', 0);
    if (!piece) return { placed: true, found: false };
    const { x, y, z, ry } = piece;
    // The piece's thin axis, from its own rotation.
    const nx = Math.sin(ry);
    const nz = Math.cos(ry);
    const tx = nz;
    const tz = -nx;
    const walk = (offAlong) => {
      const p = { x: x + tx * offAlong + nx * 5, y: y + 0.2, z: z + tz * offAlong + nz * 5 };
      for (let i = 0; i < 80; i++) {
        p.x -= nx * 0.12;
        p.z -= nz * 0.12;
        s.collide(p, 0.4);
      }
      // Signed distance still to go on the far side: negative means it got through.
      return +((p.x - x) * nx + (p.z - z) * nz).toFixed(2);
    };
    return {
      placed: true,
      found: true,
      // Straight at the opening: must come out the other side.
      throughMiddle: walk(0),
      // Straight at the solid part beside it: must be stopped.
      intoSolid: walk(1.7),
    };
  });
  console.log(`doorway: ${JSON.stringify(door)}`);

  // ---- Walls land on cell edges, not cell centres --------------------------
  // Four walls have to be able to enclose one floor. While they snapped to cell
  // centres that was impossible: they landed in four different squares.
  const edges = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    const G = 4;
    const out = { walls: [], floor: null };
    s.select('floor');
    sc.player.spawn(-320, -320, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    s.place();
    const f = window.probe.piece('floor', 0);
    if (f) out.floor = { x: +f.x.toFixed(2), z: +f.z.toFixed(2) };
    // Four walls, one per side, by stepping the side between placements.
    s.select('wall');
    for (let i = 0; i < 4; i++) {
      sc.player.update(0.016);
      sc.render(1, 0.016);
      s.place();
      s.rotate();
    }
    for (let i = 0; ; i++) {
      const w = window.probe.piece('wall', i);
      if (!w) break;
      out.walls.push({ x: +w.x.toFixed(2), z: +w.z.toFixed(2) });
    }
    // On an edge, exactly one of the two coordinates is offset by half a cell.
    const onEdge = (p) => {
      const ox = Math.abs((((p.x % G) + G) % G) - G / 2) < 0.01;
      const oz = Math.abs((((p.z % G) + G) % G) - G / 2) < 0.01;
      return (ox && !oz) || (oz && !ox);
    };
    return {
      floor: out.floor,
      walls: out.walls,
      allOnEdges: out.walls.length === 4 && out.walls.every(onEdge),
      // And all four must belong to the same cell: half a cell from its centre.
      encloseFloor:
        out.floor !== null &&
        out.walls.length === 4 &&
        out.walls.every(
          (w) => Math.abs(Math.hypot(w.x - out.floor.x, w.z - out.floor.z) - G / 2) < 0.01,
        ),
      distinct: new Set(out.walls.map((w) => `${w.x},${w.z}`)).size === 4,
    };
  });
  console.log(`edge lattice: ${JSON.stringify(edges)}`);

  // ---- Cost does not grow with what is built ------------------------------
  const scaling = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    const childrenEmpty = s.group.children.length;
    s.select('floor');
    // A field of floors, placed straight into the lattice.
    let n = 0;
    for (let i = 0; i < 90; i++) {
      sc.player.spawn(-100 + (i % 10) * 4.2, -600 + Math.floor(i / 10) * 4.2, 0);
      sc.player.pitch = 0;
      sc.player.update(0.016);
      sc.render(1, 0.016);
      if (s.place()) n++;
    }
    sc.render(1, 0.016);
    const info = window.arena.engine.renderer.info.render;
    return {
      placed: n,
      childrenEmpty,
      childrenFull: s.group.children.length,
      // Instanced: one draw for the whole field, whatever its size.
      instanced: s.group.children.filter((c) => c.isInstancedMesh).length,
      drawCalls: info.calls,
    };
  });
  console.log(`scaling: ${JSON.stringify(scaling)}`);

  // ---- The label is centred over the bar ----------------------------------
  const centred = await page.evaluate(() => {
    const l = document.getElementById('buildLabel');
    const b = document.getElementById('buildBar');
    if (!l || !b) return null;
    const lr = l.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    // Where the text actually sits, not just the box: a box centred on the bar with
    // its text pushed to one side still looks off-centre.
    const r = document.createRange();
    r.selectNodeContents(l);
    const tr = r.getBoundingClientRect();
    return {
      boxOffset: +(lr.left + lr.width / 2 - (br.left + br.width / 2)).toFixed(2),
      textOffset: +(tr.left + tr.width / 2 - (br.left + br.width / 2)).toFixed(2),
      text: l.textContent.trim(),
    };
  });
  console.log(`label centring: ${JSON.stringify(centred)}`);

  // ---- Removing exactly one, the one under the crosshair -------------------
  const removed = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    // Two walls, far apart. A wall is four metres tall, so a level gaze genuinely
    // hits it and this exercises the ray rather than the fallback.
    s.select('wall');
    sc.player.spawn(500, 500, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    s.place();
    const first = window.probe.piece('wall', 0);
    sc.player.spawn(560, 500, 0);
    sc.player.update(0.016);
    sc.render(1, 0.016);
    s.place();
    sc.render(1, 0.016);
    const aimedBefore = s.aimedKind();
    const before = s.count();
    const ok = s.removeAimed();
    const after = s.count();
    // Whichever one went, the survivor must be the *other* one — a pick that
    // removed the wrong piece would still satisfy the count.
    const left = window.probe.piece('wall', 0);
    const survivorIsFirst =
      !!left && !!first && Math.hypot(left.x - first.x, left.z - first.z) < 0.01;
    return { ok, before, after, aimedBefore, survivorIsFirst };
  });

  // And the fallback: a floor slab is too low for a level gaze to strike, so the
  // piece sitting in the slot the preview is showing is named instead.
  const removeLow = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    s.select('floor');
    sc.player.spawn(600, 600, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    s.place();
    sc.render(1, 0.016);
    const aimed = s.aimedKind();
    const before = s.count();
    const ok = s.removeAimed();
    return { aimed, ok, before, after: s.count() };
  });
  console.log(`low piece: ${JSON.stringify(removeLow)}`);
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
  const barOpens = opened.active && opened.hudShown && opened.slots === 10 && !before.hudShown;
  const iconsDrawn =
    iconsReady &&
    icons.length === 10 &&
    icons.every((i) => i && i.coverage > 0.03 && i.coverage < 0.99 && i.brightness >= 30);
  const iconsDiffer = new Set(icons.filter(Boolean).map((i) => i.fingerprint)).size >= 9;
  const nativeWorks = nativePlace.to === nativePlace.from + 1;
  const browserWorks = browserPlace.to === browserPlace.from + 1;
  const enterWorks = enterPlace.to === enterPlace.from + 1;
  // On the ground, not a level above it. A wall's underside must sit within a few
  // centimetres of the terrain it was placed on.
  const restsOnGround = !!resting && Math.abs(resting.gap) < 0.35 && Math.abs(resting.geoMinY) < 0.01;
  const digitSelects = picked.selected === 'doorway' && picked.lit === 1;
  const floorWorks =
    floorStands.found === true &&
    floorStands.lift > 0.1 &&
    floorStands.lift < 1 &&
    floorStands.awayUnchanged === true;
  const rampWorks = rampRises.found === true && rampRises.rising === true && rampRises.span > 2.5;
  // Not one inverted triangle anywhere. This is the check that would have caught
  // the see-through ramp and roof.
  const facesOutward =
    Object.values(winding).every((w) => w.tris > 0 && w.inverted === 0) &&
    Object.keys(winding).length === 10;
  // Half a wall's thickness plus the body radius is 0.5 m. Anything near that is a
  // wall; 2.4 m was the bubble.
  const hitboxThin =
    hitbox.found === true &&
    hitbox.fromFront < 0.75 &&
    hitbox.fromBack < 0.75 &&
    hitbox.pastTheEnd < 0.01;
  const roofWalkable =
    roofSolid.found === true &&
    roofSolid.ridge > 1.8 &&
    roofSolid.profile[0] < 0.5 &&
    roofSolid.profile[4] < 0.5 &&
    Math.abs(roofSolid.profile[1] - roofSolid.profile[3]) < 0.2;
  // Warm and directional: brown rather than grey, and smoother along the fibres
  // than across them, which is what makes it read as timber at all.
  const isWood =
    wood.hasMap === true &&
    wood.hasNormal === true &&
    wood.hasRough === true &&
    wood.r > 110 &&
    wood.r > wood.g + 15 &&
    wood.g > wood.b + 15 &&
    wood.alongGrain < 0.9;
  // Under a ceiling the answer is the ground; on top of it, the ceiling. And with
  // no height given, the old unbounded behaviour is preserved for callers that
  // genuinely want the highest surface.
  const ceilingIgnored =
    underneath.found === true &&
    Math.abs(underneath.fromBelow - underneath.ground) < 0.01 &&
    Math.abs(underneath.fromJustBelow - underneath.ground) < 0.01 &&
    underneath.slab - underneath.ground > 1.5 &&
    Math.abs(underneath.fromAbove - (underneath.slab + 0.3)) < 0.05 &&
    underneath.unbounded > underneath.ground + 1;
  // Through the opening and out the far side; stopped by the timber beside it.
  const doorwayOpen = door.found === true && door.throughMiddle < -1 && door.intoSolid > 0.3;
  const edgeLattice =
    edges.allOnEdges === true && edges.encloseFloor === true && edges.distinct === true;
  // Ten instanced meshes plus the preview and the removal marker, and that count
  // does not move when ninety pieces are placed.
  const costFlat =
    scaling.placed >= 80 &&
    scaling.instanced === 10 &&
    scaling.childrenFull === scaling.childrenEmpty &&
    scaling.childrenFull <= 13;
  const labelCentred =
    centred !== null && Math.abs(centred.boxOffset) < 1.5 && Math.abs(centred.textOffset) < 1.5;
  const removesOne =
    removed.ok === true &&
    removed.before === 2 &&
    removed.after === 1 &&
    removed.aimedBefore === 'wall' &&
    removed.survivorIsFirst === true;
  const removesLowPiece =
    removeLow.aimed === 'floor' && removeLow.ok === true && removeLow.after === 0;
  const nameAbove =
    naming.insideSlots === 0 &&
    naming.labelAbove === true &&
    labelRamp !== '' &&
    labelWall !== '' &&
    labelRamp !== labelWall;
  // One chosen slot, one raised slot, and the chosen one is what the label names.
  const tops = litNow.tops ?? [];
  const highest = Math.min(...tops);
  const raisedCount = tops.filter((v) => v <= highest + 1).length;
  const oneSelected =
    litNow.lit === 1 && litNow.litKind === 'wall' && raisedCount === 1 && tops.indexOf(highest) === 0;

  const clearWorks = cleared === 0;
  const barCloses = !closed.active && !closed.hudShown;

  const line = (label, ok, extra = '') =>
    console.log(`${label.padEnd(36)}${ok ? 'ok' : 'FAIL'}${extra ? ` ${extra}` : ''}`);
  line('admin granted:', gotAdmin);
  line('B opens the bar, 10 slots:', barOpens, `${opened.slots} slots`);
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
  line(
    'every face points outward:',
    facesOutward,
    Object.entries(winding)
      .map(([k, w]) => `${k}:${w.inverted}/${w.tris}`)
      .join(' '),
  );
  line('wall hitbox is thin:', hitboxThin, `stops at ${hitbox.fromFront}m / ${hitbox.fromBack}m`);
  line(
    'roof can be stood on:',
    roofWalkable,
    `x=${JSON.stringify(roofSolid.x)} z=${JSON.stringify(roofSolid.z)}`,
  );
  line('timber, grained and warm:', isWood, `rgb(${wood.r},${wood.g},${wood.b}) grain=${wood.alongGrain}`);
  line('name sits above the bar:', nameAbove, `"${labelRamp}" / "${labelWall}"`);
  line(
    'exactly one slot looks chosen:',
    oneSelected,
    `lit=${litNow.lit} kind=${litNow.litKind} raised=${raisedCount} tops=${JSON.stringify(tops)}`,
  );
  line(
    'under a ceiling stays down:',
    ceilingIgnored,
    `ground=${underneath.ground} slab=${underneath.slab} below=${underneath.fromBelow} above=${underneath.fromAbove}`,
  );
  line('doorway is walkable:', doorwayOpen, `middle=${door.throughMiddle} solid=${door.intoSolid}`);
  line('walls sit on cell edges:', edgeLattice, JSON.stringify(edges.walls));
  line(
    'cost flat as it grows:',
    costFlat,
    `${scaling.placed} pieces, ${scaling.instanced} instanced meshes, ${scaling.childrenFull} children`,
  );
  line('label centred on the bar:', labelCentred, `off by ${centred?.textOffset}px`);
  line(
    'X removes exactly the aimed one:',
    removesOne,
    `aimed=${removed.aimedBefore} survivor kept=${removed.survivorIsFirst}`,
  );
  line('and reaches a low slab too:', removesLowPiece, `aimed=${removeLow.aimed}`);
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
    facesOutward &&
    hitboxThin &&
    roofWalkable &&
    isWood &&
    nameAbove &&
    oneSelected &&
    ceilingIgnored &&
    doorwayOpen &&
    edgeLattice &&
    costFlat &&
    labelCentred &&
    removesOne &&
    removesLowPiece &&
    clearWorks &&
    barCloses &&
    errors.length === 0;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
