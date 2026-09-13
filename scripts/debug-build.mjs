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
      'wallHalf',
      'gable',
      'doorway',
      'doorArch',
      'doorLeaf',
      'windowOpen',
      'windowGlass',
      'windowVent',
      'railing',
      'beam',
      'floor',
      'foundation',
      'ramp',
      'stairs',
      'roofGable',
      'roofHip',
      'roofShed',
      'roofFlat',
      'pillar',
      'bed',
      'table',
      'stool',
      'cabinet',
      'barrel',
      'shelf',
      'torch',
      'campfire',
      'brazier',
      'lantern',
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
    s.select('roofGable');
    sc.player.spawn(-200, -200, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    const roof = window.probe.piece('roofGable', 0);
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

  // ---- The wheel changes the piece and leaves the camera alone --------------
  // Both were happening: the camera zoom listens for `wheel` on the canvas, so a
  // bubble-phase listener on the window meant one turn of the wheel switched the
  // piece *and* pulled the view back.
  // Pulled out to a third-person distance first. Starting at zero would prove
  // nothing: the zoom clamps at zero, so a broken build would still read 0 -> 0.
  const before2 = await page.evaluate(() => {
    window.arena.scene.player.setZoom(3);
    return {
      zoom: window.arena.scene.player.camDistTarget,
      selected: window.arena.scene.buildSite.selected,
    };
  });
  const wheelTest = before2.zoom;
  await page.mouse.move(450, 300);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(300);
  const afterWheel = await page.evaluate(() => ({
    zoom: window.arena.scene.player.camDistTarget,
    selected: window.arena.scene.buildSite.selected,
  }));
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(250);
  const backAgain = await page.evaluate(() => window.arena.scene.buildSite.selected);
  console.log(
    `wheel: zoom ${wheelTest} -> ${afterWheel.zoom}, piece -> ${afterWheel.selected}, back -> ${backAgain}`,
  );

  // ---- Glazing -------------------------------------------------------------
  // A window with a pane needs a second instanced mesh, sharing the transforms of
  // the timber one, with a translucent material. An opening has no such mesh.
  const glazing = await page.evaluate(() => {
    const s = window.arena.scene.buildSite;
    const find = (name) => s.group.children.find((c) => c.name === name) ?? null;
    const pane = find('Glass:windowGlass');
    const vent = find('Glass:windowVent');
    return {
      glassMeshes: s.group.children.filter((c) => c.name.startsWith('Glass:')).map((c) => c.name),
      paneTransparent: pane?.material?.transparent === true,
      paneOpacity: pane?.material?.opacity ?? null,
      paneSmooth: (pane?.material?.roughness ?? 1) < 0.2,
      paneCastsNoShadow: pane?.castShadow === false,
      ventGlazed: !!vent,
      // The plain opening is deliberately unglazed.
      openingHasNoPane: !find('Glass:windowOpen'),
      // Panes follow the frame: same instance count, same transform.
      sharesTransforms: (() => {
        const timber = find('Build:windowGlass');
        if (!timber || !pane) return false;
        return timber.count === pane.count;
      })(),
    };
  });
  console.log(`glazing: ${JSON.stringify(glazing)}`);

  // ---- The gable fills the triangle a pitched roof leaves ------------------
  const gable = await page.evaluate(() => {
    const s = window.arena.scene.buildSite;
    const g = s.geometryFor('gable');
    const p = g.getAttribute('position');
    // Width of the piece at several heights: a triangle narrows as it rises.
    const bands = [0.2, 1.2, 2.2, 2.8];
    const widths = bands.map((y) => {
      let max = 0;
      for (let i = 0; i < p.count; i++) {
        if (Math.abs(p.getY(i) - y) < 0.25) max = Math.max(max, Math.abs(p.getX(i)));
      }
      return +max.toFixed(2);
    });
    return {
      widths,
      apex: +g.boundingBox.max.y.toFixed(2),
      base: +g.boundingBox.min.y.toFixed(2),
      // And it belongs on an edge, so it lands on the wall below it.
      narrows: widths.every((w, i) => i === 0 || w <= widths[i - 1] + 0.01),
    };
  });
  console.log(`gable: ${JSON.stringify(gable)}`);

  // ---- Groups ---------------------------------------------------------------
  const groups = await page.evaluate(() => ({
    tabs: document.querySelectorAll('.buildCat').length,
    cat: window.arena.scene.buildSite.category,
  }));
  await page.keyboard.press('BracketRight');
  await page.waitForTimeout(300);
  const afterTab = await page.evaluate(() => ({
    cat: window.arena.scene.buildSite.category,
    selected: window.arena.scene.buildSite.selected,
    slots: document.querySelectorAll('.buildSlot').length,
    litTabs: document.querySelectorAll('.buildCat.on').length,
  }));
  await page.keyboard.press('BracketLeft');
  await page.waitForTimeout(300);
  const backToWalls = await page.evaluate(() => window.arena.scene.buildSite.category);
  console.log(`groups: ${groups} tabs, next -> ${JSON.stringify(afterTab)}, back -> ${backToWalls}`);

  // ---- The name is above the bar, not in the slots -------------------------
  const naming = await page.evaluate(() => {
    const s = window.arena.scene.buildSite;
    s.select('gable');
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
  const labelThird = await page.evaluate(
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
    litKind: document.querySelector('.buildSlot.on')?.dataset.kind ?? null,
    selected: window.arena.scene.buildSite.selected,
    groupSize: [10, 6, 4, 10][window.arena.scene.buildSite.category],
    // The lit tab has to be the group the piece in hand belongs to. It was showing
    // the previous group: the tab of a roof was still active while a wall was in
    // hand and the wall row was on the bar.
    litTab: document.querySelector('.buildCat.on')?.dataset.cat ?? null,
    wantTab: String(window.arena.scene.buildSite.category),
    // Measured, not read off the style. Chromium can leave an identity matrix in
    // the computed transform of an element that has merely *had* a transition, so
    // the string is not evidence of anything; where the box actually is, is.
    tops: [...document.querySelectorAll('.buildSlot')].map((s) =>
      Math.round(s.getBoundingClientRect().top),
    ),
    // The chosen slot has to *look* different, not merely carry a class. Border and
    // fill are paint of the element itself, so unlike a transform they cannot lag
    // behind the class that sets them.
    styled: [...document.querySelectorAll('.buildSlot')].map((s) => {
      const cs = getComputedStyle(s);
      return { k: s.dataset.kind, on: s.classList.contains('on'), border: cs.borderTopColor };
    }),
  }));
  console.log(
    `naming: ${JSON.stringify(naming)} third="${labelThird}" wall="${labelWall}" ${JSON.stringify(litNow)}`,
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

  // ---- You can get on top of a railing and a wall --------------------------
  // Before, only shapes with an analytic surface had a top, so a wall was something
  // you got pushed sideways by and never landed on: jumping at a fence threw you
  // left and right along its face. The top now comes from the same slabs the
  // collision uses, and the pushout yields within a step of it.
  const onTop = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    s.select('railing');
    sc.player.spawn(700, 700, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    const r = window.probe.piece('railing', 0);
    if (!r) return { placed: true, found: false };
    const ground = sc.world.floorHeightAt(r.x, r.z);
    return {
      placed: true,
      found: true,
      // Standing on the ground beside it, the railing is not the floor.
      fromGround: +(s.heightAt(r.x, r.z, ground, ground) - ground).toFixed(2),
      // Risen to near its top, it is.
      fromLevel: +(s.heightAt(r.x, r.z, ground, ground + 0.9) - ground).toFixed(2),
      // And the pushout lets go once you are within a step of the top, which is what
      // allows the landing to happen at all.
      pushedAtTop: (() => {
        const p = { x: r.x, y: ground + 0.9, z: r.z };
        s.collide(p, 0.4);
        return +Math.hypot(p.x - r.x, p.z - r.z).toFixed(2);
      })(),
      // Down at knee height it is still solid.
      pushedLow: (() => {
        const p = { x: r.x, y: ground, z: r.z };
        s.collide(p, 0.4);
        return +Math.hypot(p.x - r.x, p.z - r.z).toFixed(2);
      })(),
    };
  });
  console.log(`on top: ${JSON.stringify(onTop)}`);

  // ---- A roof can be walked under, and stood on ----------------------------
  // The opposite of what this checked before, deliberately. Filling a roof in from the
  // ground up did stop you walking into its eaves, and it also turned a roof stood on
  // the ground into a solid wedge you could not shelter under. There is no ceiling
  // collision in this game, so a shelter you cannot get inside is the worse of the two
  // failures. It keeps its surface, so it is still something you climb and stand on.
  const roofSide = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    s.select('roofGable');
    sc.player.spawn(-700, 700, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    const r = window.probe.piece('roofGable', 0);
    if (!r) return { placed: true, found: false };
    const ground = sc.world.floorHeightAt(r.x, r.z);
    // Sampled across the whole slope on both axes, because the roof may be turned. On
    // the axis it slopes along there must be somewhere clear (under the ridge), and
    // somewhere solid (where the slope crosses chest height) — a roof that is clear
    // everywhere can be walked through, and one that is solid everywhere cannot be
    // sheltered under.
    // Standing on the floor of the roof's own slot, which is what being under it means.
    // The terrain height at the sample point is not the same thing on a slope, and the
    // shell's heights are measured from the piece's level.
    const level = r.y;
    const scan = (axis) =>
      [0, 0.5, 1.0, 1.4, 1.8].map((d) => {
        const p = axis === 'x' ? { x: r.x + d, y: level, z: r.z } : { x: r.x, y: level, z: r.z + d };
        const from = { x: p.x, z: p.z };
        s.collide(p, 0.4);
        return +Math.hypot(p.x - from.x, p.z - from.z).toFixed(2);
      });
    const x = scan('x');
    const z = scan('z');
    return {
      placed: true,
      found: true,
      x,
      z,
      // Under the ridge, where the roof is highest, nothing may push.
      underRidge: Math.min(x[0], z[0]),
      // And somewhere on the slope, something must.
      blocksSomewhere: Math.max(...x, ...z),
      // The ridge is still a surface, so the roof has not become a ghost.
      ridgeSurface: +(s.heightAt(r.x, r.z, level, level + 2.4) - level).toFixed(2),
    };
  });
  console.log(`roof from the side: ${JSON.stringify(roofSide)}`);

  // ---- Doors open and shut -------------------------------------------------
  const door2 = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    s.select('doorLeaf');
    sc.player.spawn(-700, -700, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    const d = window.probe.piece('doorLeaf', 0);
    if (!d) return { placed: true, found: false };
    const nx = Math.sin(d.ry);
    const nz = Math.cos(d.ry);
    const walkThrough = () => {
      const p = { x: d.x + nx * 5, y: d.y + 0.2, z: d.z + nz * 5 };
      for (let i = 0; i < 80; i++) {
        p.x -= nx * 0.12;
        p.z -= nz * 0.12;
        s.collide(p, 0.4);
      }
      return +((p.x - d.x) * nx + (p.z - d.z) * nz).toFixed(2);
    };
    const shut = walkThrough();
    // Stand in front of it and look at it, which is how a door offers itself.
    // Yaw 0 faces -Z here, and the forward vector for yaw t is (-sin t, 0, -cos t),
    // so looking back along the door's own normal is atan2(nx, nz).
    sc.player.spawn(d.x + nx * 1.6, d.z + nz * 1.6, Math.atan2(nx, nz));
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    const promptShut = s.reachableKind();
    const openedFlag = s.interact();
    const opened = walkThrough();
    const promptOpen = s.reachableOpen();
    s.interact();
    const shutAgain = walkThrough();
    // The leaf has its own transform, which has to have moved.
    const leafMesh = s.group.children.find((c) => c.name === 'Leaf:doorLeaf') ?? null;
    return {
      placed: true,
      found: true,
      promptShut,
      openedFlag,
      promptOpen,
      shut,
      opened,
      shutAgain,
      hasLeafLayer: !!leafMesh,
      leafCount: leafMesh?.count ?? 0,
    };
  });
  console.log(`door: ${JSON.stringify(door2)}`);

  // ---- Alt frees the cursor and gives it back ------------------------------
  const cursor = await page.evaluate(() => ({
    freed: window.arena.engine.input.isCursorFreed,
  }));
  await page.keyboard.press('AltLeft');
  await page.waitForTimeout(250);
  const freed = await page.evaluate(() => ({
    freed: window.arena.engine.input.isCursorFreed,
    locked: window.arena.engine.input.locked,
  }));
  await page.keyboard.press('AltLeft');
  await page.waitForTimeout(250);
  const regrabbed = await page.evaluate(() => window.arena.engine.input.isCursorFreed);
  console.log(`cursor: ${JSON.stringify(cursor)} -> ${JSON.stringify(freed)} -> ${regrabbed}`);

  // ---- A shelf hangs on the wall, not inside it ----------------------------
  // Both go on the same lattice, and that is the point: a wall stands on the cell edge
  // and a fixture has to stand against it. Centred on the edge, half a shelf is buried
  // in the wall, which is what it looked like.
  const mounted = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    sc.player.spawn(900, 900, 0);
    sc.player.pitch = 0;
    // A wall first, then a shelf aimed at the same place.
    s.select('wall');
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    const w = window.probe.piece('wall', 0);
    s.select('shelf');
    sc.render(1, 0.016);
    if (!s.place()) return { placed: true, shelf: false };
    const f = window.probe.piece('shelf', 0);
    if (!w || !f) return { placed: true, shelf: false };
    // The wall's thin axis is its local +Z; the fixture must sit off the wall along it.
    const nx = Math.sin(w.ry);
    const nz = Math.cos(w.ry);
    const offset = +Math.abs((f.x - w.x) * nx + (f.z - w.z) * nz).toFixed(3);
    // And it must face away from the wall, into the room: its own +Z, turned by its own
    // rotation, has to point the same way as the offset did.
    const fx = Math.sin(f.ry);
    const fz = Math.cos(f.ry);
    const outward = ((f.x - w.x) * fx + (f.z - w.z) * fz) / Math.max(0.001, offset);
    return {
      placed: true,
      shelf: true,
      offset,
      facesIn: +outward.toFixed(2),
      // Along the wall it stays on the same line, so it is not floating off to a corner.
      alongWall: +Math.abs((f.x - w.x) * nz - (f.z - w.z) * nx).toFixed(3),
    };
  });
  console.log(`mounted: ${JSON.stringify(mounted)}`);

  // ---- A piece put down on a floor sits on it, not in it -------------------
  // The preview used to take its height from the terrain, so anything placed on a built
  // floor was positioned at the ground under that floor and sank through it. The same one
  // change is what lets a lantern be stood on a table.
  const onTopOf = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    sc.player.spawn(1300, 1300, 0);
    sc.player.pitch = 0;
    s.select('floor');
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    const f = window.probe.piece('floor', 0);
    if (!f) return { placed: true, found: false };
    // Now a bed, aimed at the same square.
    s.select('bed');
    sc.render(1, 0.016);
    if (!s.place()) return { placed: true, found: false, bed: false };
    const b = window.probe.piece('bed', 0);
    if (!b) return { placed: true, found: false, bed: false };
    return {
      placed: true,
      found: true,
      bed: true,
      floorY: +f.y.toFixed(2),
      // The floor's walking surface is 0.3 above its own base, so a bed standing on it
      // must have its base there rather than at the floor's base.
      bedY: +b.y.toFixed(2),
      lift: +(b.y - f.y).toFixed(2),
    };
  });
  console.log(`on a floor: ${JSON.stringify(onTopOf)}`);

  // ---- A fixture goes where the crosshair is, on your side of the wall -----
  const aimedMount = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    sc.player.spawn(1500, 1500, 0);
    sc.player.pitch = 0;
    s.select('wall');
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    const w = window.probe.piece('wall', 0);
    if (!w) return { placed: true, found: false };
    const nx = Math.sin(w.ry);
    const nz = Math.cos(w.ry);
    // Along the wall, perpendicular to its thin axis.
    const tx = nz;
    const tz = -nx;

    // Two torches, aimed at two different points along the same wall from the same side.
    s.select('torch');
    const put = (offset) => {
      // Stand back from the wall and look at a point offset along it.
      const px = w.x - nx * 3 + tx * offset;
      const pz = w.z - nz * 3 + tz * offset;
      const yaw = Math.atan2(-(w.x + tx * offset - px), -(w.z + tz * offset - pz));
      sc.player.spawn(px, pz, yaw);
      sc.player.pitch = 0;
      sc.player.update(0.016);
      sc.render(1, 0.016);
      sc.render(1, 0.016);
      return s.place();
    };
    const first = put(-1.2);
    const second = put(1.2);
    const a = window.probe.piece('torch', 0);
    const b = window.probe.piece('torch', 1);
    if (!a || !b) return { placed: true, found: false, first, second, count: a ? 1 : 0 };
    // Both on the near side of the wall, and a real distance apart along it.
    const sideOf = (p) => Math.sign((p.x - w.x) * nx + (p.z - w.z) * nz);
    return {
      placed: true,
      found: true,
      first,
      second,
      apart: +Math.abs((a.x - b.x) * tx + (a.z - b.z) * tz).toFixed(2),
      sameSide: sideOf(a) === sideOf(b),
      // The player stood on the negative side of the wall's own normal.
      nearSide: sideOf(a) === -1 && sideOf(b) === -1,
      offset: +Math.abs((a.x - w.x) * nx + (a.z - w.z) * nz).toFixed(2),
    };
  });
  console.log(`aimed mount: ${JSON.stringify(aimedMount)}`);

  // ---- Stairs are walked up, not jumped up ---------------------------------
  // I filled the volume under the treads and broke climbing: the pushout runs before the
  // floor snap, so a band taller than a step stopped you at the height you were rather
  // than the height the next tread would put you at. Walked here as the controller does —
  // step forward, resolve collision, then take the floor — so the check is the real
  // sequence and not a single query.
  const climb = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    s.select('stairs');
    sc.player.spawn(1700, 1700, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    const st = window.probe.piece('stairs', 0);
    if (!st) return { placed: true, found: false };
    // Local +Z is up the flight; walk in from the low edge.
    const ux = Math.sin(st.ry);
    const uz = Math.cos(st.ry);
    const ground = st.y;
    const p = { x: st.x - ux * 3, y: ground, z: st.z - uz * 3 };
    const heights = [];
    // Far enough to cross the whole cell and no further: past the top edge the flight
    // has ended and the floor is the ground again, which would read as a failed climb.
    for (let i = 0; i < 54; i++) {
      p.x += ux * 0.09;
      p.z += uz * 0.09;
      s.collide(p, 0.4);
      // The floor, from where the body is — the same call the controller makes.
      p.y = Math.max(p.y - 0.4, s.heightAt(p.x, p.z, ground, p.y));
      if (i % 12 === 0) heights.push(+(p.y - ground).toFixed(2));
    }
    // Under the high end there must be room, so a flight can be built beneath.
    const under = { x: st.x + ux * 1.4, y: ground, z: st.z + uz * 1.4 };
    const from = { x: under.x, z: under.z };
    s.collide(under, 0.4);
    // And walking into the low treads from the side at ground level must be stopped —
    // 0.7 m up the flight, where the shell is above the feet and below the head.
    const side = { x: st.x - ux * 0.7 + uz * 0.6, y: ground, z: st.z - uz * 0.7 - ux * 0.6 };
    const sideFrom = { x: side.x, z: side.z };
    s.collide(side, 0.4);
    return {
      placed: true,
      found: true,
      heights,
      climbed: +(p.y - ground).toFixed(2),
      underClear: +Math.hypot(under.x - from.x, under.z - from.z).toFixed(2),
      sideBlocked: +Math.hypot(side.x - sideFrom.x, side.z - sideFrom.z).toFixed(2),
    };
  });
  console.log(`climb: ${JSON.stringify(climb)}`);

  // ---- A cabinet stands against a wall, not in it ---------------------------
  const cupboard = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    sc.player.spawn(1900, 1900, 0);
    sc.player.pitch = 0;
    s.select('wall');
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    const w = window.probe.piece('wall', 0);
    s.select('cabinet');
    sc.render(1, 0.016);
    if (!s.place()) return { placed: true, found: false };
    const c = window.probe.piece('cabinet', 0);
    if (!w || !c) return { placed: true, found: false };
    const nx = Math.sin(w.ry);
    const nz = Math.cos(w.ry);
    return {
      placed: true,
      found: true,
      // Clear of the wall by its own depth plus the wall's half-thickness, so its back is
      // against the wall rather than through it.
      offset: +Math.abs((c.x - w.x) * nx + (c.z - w.z) * nz).toFixed(2),
      // Standing on the ground under *itself*, not hanging at fixture height. Measured
      // against its own column: the wall's base is a third of a metre away across
      // sloping terrain, so comparing the two origins reads a slope as a fault.
      lift: +(c.y - sc.world.floorHeightAt(c.x, c.z)).toFixed(2),
      // And squarely along the wall rather than skewed to it.
      alongWall: +Math.abs(Math.sin(c.ry - w.ry)).toFixed(2),
    };
  });
  console.log(`cabinet: ${JSON.stringify(cupboard)}`);

  // ---- Fires light the place up --------------------------------------------
  const firelight = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    const lights = s.group.children.filter((c) => c.isPointLight);
    // Counted by intensity, not by visibility, and that is not a detail. The pool is
    // permanently visible on purpose: hiding a light changes how many the renderer sees,
    // and that number is baked into every material's compiled program — which is what made
    // the first torch freeze the game for five seconds. Brightness is the switch now.
    const burning = () => lights.filter((l) => l.intensity > 0);
    const before = burning().length;
    s.select('campfire');
    sc.player.spawn(2100, 2100, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false, pool: lights.length };
    const f = window.probe.piece('campfire', 0);
    s.lightUp(sc.player.feetPosition);
    // Read now, not later. These are live light objects, and the next call dims them — an
    // earlier version of this probe kept the references and reported the brightness it
    // measured *after* walking the player away, which is zero by design.
    const lit = burning();
    const litCount = lit.length;
    const litPower = lit[0]?.intensity ?? 0;
    const litAt = f ? +Math.hypot(lit[0].position.x - f.x, lit[0].position.z - f.z).toFixed(2) : null;
    // Walk far away: the pool must let go, so it never costs anything for fires nobody is
    // standing near.
    s.lightUp({ x: 2100 + 400, y: 0, z: 2100 + 400 });
    const farLit = burning().length;
    return {
      placed: true,
      pool: lights.length,
      before,
      lit: litCount,
      atFire: litAt,
      intensity: litPower,
      shadowless: lights.every((l) => l.castShadow === false),
      // Never hidden, at any point: that is the invariant that keeps placing a fire free.
      counted: lights.every((l) => l.visible === true),
      farLit,
    };
  });
  console.log(`firelight: ${JSON.stringify(firelight)}`);

  // ---- Lighting a fire must not rebuild every shader in the scene ----------
  // Reported as the game freezing for five seconds when a torch or a campfire goes down,
  // and it was mine: the pool was dimmed with `visible`, the renderer counts only visible
  // lights, and that count is part of every material's program key — so the first fire
  // took the scene from zero point lights to one and recompiled the lot, mid-frame.
  // `renderer.info.programs` is the compiled-program cache, so its length is a direct
  // measurement of whether that happened.
  const noRecompile = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    const gl = window.arena.engine.renderer;
    s.clear();
    sc.player.spawn(2300, 2300, 0);
    sc.player.pitch = 0;
    sc.player.update(0.016);
    // Settle first: a fresh position streams terrain, and terrain has shaders of its own.
    for (let i = 0; i < 8; i++) sc.render(1, 0.016);
    const before = gl.info.programs.length;
    const lights = s.group.children.filter((c) => c.isPointLight);
    s.select('campfire');
    sc.render(1, 0.016);
    const ok = s.place();
    s.lightUp(sc.player.feetPosition);
    for (let i = 0; i < 4; i++) sc.render(1, 0.016);
    const after = gl.info.programs.length;
    // Then a torch as well, which is a different kind on a different mesh.
    s.select('torch');
    sc.render(1, 0.016);
    s.place();
    s.lightUp(sc.player.feetPosition);
    for (let i = 0; i < 4; i++) sc.render(1, 0.016);
    return {
      ok,
      before,
      after,
      afterTorch: gl.info.programs.length,
      // The count the renderer sees must never change, which is what holds the above true.
      alwaysCounted: lights.every((l) => l.visible === true),
      // And the pool must still actually light things.
      lit: lights.filter((l) => l.intensity > 0).length,
    };
  });
  console.log(`shader churn: ${JSON.stringify(noRecompile)}`);

  // ---- A shelf goes above a cupboard, below it, and beside it --------------
  // Reported as: mount a cabinet on a wall and there is nowhere left to put a shelf.
  // Height used to be quantised to two-metre tiers and measured from the floor query,
  // which the cabinet itself became — so above worked and below and beside did not.
  const stacking = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    s.clear();
    sc.player.spawn(2500, 2500, 0);
    sc.player.pitch = 0;
    s.select('wall');
    sc.player.update(0.016);
    sc.render(1, 0.016);
    if (!s.place()) return { placed: false };
    const w = window.probe.piece('wall', 0);
    s.select('cabinet');
    sc.render(1, 0.016);
    s.place();
    const cab = window.probe.piece('cabinet', 0);

    // Now aim the crosshair at three heights on that same wall and hang a shelf at each.
    // Pitch is what a player changes to do this, so pitch is what the probe changes.
    const shelves = [];
    for (const pitch of [-0.16, 0.24, 0.52]) {
      sc.player.pitch = pitch;
      sc.player.update(0.016);
      s.select('shelf');
      sc.render(1, 0.016);
      const ok = s.place();
      shelves.push({ pitch, ok });
    }
    const ys = [];
    for (let i = 0; i < 3; i++) {
      const sh = window.probe.piece('shelf', i);
      if (sh) ys.push(+(sh.y - w.y).toFixed(2));
    }
    ys.sort((a, b) => a - b);
    return {
      placed: true,
      cabinetTop: cab ? +(cab.y - w.y + 1.8).toFixed(2) : null,
      accepted: shelves.filter((x) => x.ok).length,
      ys,
      // Distinct heights, and at least one of them below the top of the cupboard.
      distinct: new Set(ys).size,
      below: ys.filter((y) => y + 1.22 < (cab ? cab.y - w.y + 1.8 : 0)).length,
    };
  });
  console.log(`shelf stacking: ${JSON.stringify(stacking)}`);

  // ---- Furnishings read darker than the structure --------------------------
  const stain = await page.evaluate(() => {
    const s = window.arena.scene.buildSite;
    const pick = (kind) => {
      const m = s.group.children.find((c) => c.isInstancedMesh && c.name === `Build:${kind}`);
      return m ? m.material.color.getHex() : null;
    };
    const lum = (hex) =>
      hex === null
        ? null
        : +(
            (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) /
            255
          ).toFixed(3);
    return {
      wall: lum(pick('wall')),
      floor: lum(pick('floor')),
      table: lum(pick('table')),
      cabinet: lum(pick('cabinet')),
      shelf: lum(pick('shelf')),
      // Two timber materials across all thirty kinds — structure and furnishings — rather
      // than one per kind. Counted over the timber layers only; glazing and flames have
      // materials of their own and always did.
      materials: new Set(
        s.group.children
          .filter((c) => c.isInstancedMesh && c.name.startsWith('Build:'))
          .map((c) => c.material.uuid),
      ).size,
    };
  });
  console.log(`stain: ${JSON.stringify(stain)}`);

  // ---- Furniture holds you up along its whole length -----------------------
  // A bed is over two metres long and a table nearly two wide, so either can be
  // bucketed in one grid column and reach well into the next. The floor query used to
  // look in one column only, so the part that reached across had nothing underfoot —
  // which is how a bed could be solid in the middle and walked through at the ends.
  const furniture = await page.evaluate(() => {
    const sc = window.arena.scene;
    const s = sc.buildSite;
    const out = {};
    for (const kind of ['bed', 'table', 'stool']) {
      s.clear();
      s.select(kind);
      sc.player.spawn(820 + Math.random() * 4, 820, 0);
      sc.player.pitch = 0;
      sc.player.update(0.016);
      sc.render(1, 0.016);
      if (!s.place()) {
        out[kind] = { placed: false };
        continue;
      }
      const p = window.probe.piece(kind, 0);
      if (!p) {
        out[kind] = { placed: true, found: false };
        continue;
      }
      const ground = sc.world.floorHeightAt(p.x, p.z);
      // Asked from mid-jump, not from the ground.
      //
      // A table top is 0.77 m up and a step is 0.65: from standing, a table is
      // correctly *not* the floor — you jump onto it, you do not stride onto it. Asking
      // from the ground therefore says nothing about whether it holds you, only that it
      // is taller than a step, which is by design.
      const from = ground + 0.6;
      // A cross well inside every one of these pieces whichever way it was turned, so
      // the samples test the surface rather than the rotation.
      // Twenty centimetres: inside a stool, which is only half a metre across, as well
      // as inside the larger pieces. A wider cross tests the ground beside a stool and
      // calls it a hole in the stool.
      const cross = [0.2, -0.2].flatMap((d) => [
        +(s.heightAt(p.x + d, p.z, ground, from) - ground).toFixed(2),
        +(s.heightAt(p.x, p.z + d, ground, from) - ground).toFixed(2),
      ]);
      out[kind] = {
        placed: true,
        found: true,
        top: +(s.heightAt(p.x, p.z, ground, from) - ground).toFixed(2),
        cross,
        // Well clear of it, the ground is the ground.
        away: +(s.heightAt(p.x + 30, p.z + 30, ground, from) - ground).toFixed(2),
      };
    }
    s.clear();
    return out;
  });
  console.log(`furniture: ${JSON.stringify(furniture)}`);

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
  const digitSelects = picked.selected === 'wallHalf' && picked.lit === 1;
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
    Object.keys(winding).length === 30;
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
  // Thirty kinds, plus a companion layer wherever a piece needs a second material:
  // three glazed, one door leaf, four fires — thirty-eight instanced meshes. Then the
  // preview, the removal marker, and the pool of four firelights: forty-four children.
  //
  // The clause that carries the weight is `childrenFull === childrenEmpty`: whatever the
  // composition, it must not move when ninety pieces go in. The absolute number is the
  // second guard, and it is what catches a per-piece object being introduced by accident.
  const costFlat =
    scaling.placed >= 80 &&
    scaling.instanced === 38 &&
    scaling.childrenFull === scaling.childrenEmpty &&
    scaling.childrenFull === 44;
  // One turn changes the piece and leaves the camera exactly where it was, and the
  // reverse turn comes back to where it started.
  const wheelIsolated =
    afterWheel.selected !== before2.selected &&
    afterWheel.zoom === wheelTest &&
    wheelTest === 3 &&
    backAgain === before2.selected;
  const glassWorks =
    glazing.glassMeshes.includes('Glass:windowGlass') &&
    glazing.glassMeshes.includes('Glass:windowVent') &&
    glazing.glassMeshes.includes('Glass:lantern') &&
    glazing.paneTransparent === true &&
    glazing.paneOpacity < 0.5 &&
    glazing.paneSmooth === true &&
    glazing.paneCastsNoShadow === true &&
    glazing.ventGlazed === true &&
    glazing.openingHasNoPane === true &&
    glazing.sharesTransforms === true;
  // A triangle: full width at the bottom, nothing at the apex, and it reaches the
  // ridge height the pitched roofs use so the two actually meet.
  const gableFits =
    gable.narrows === true &&
    gable.widths[0] > 1.7 &&
    gable.widths[gable.widths.length - 1] < 0.7 &&
    Math.abs(gable.apex - 3.0) < 0.3 &&
    Math.abs(gable.base) < 0.05;
  // Relative to wherever it started, and wrapping. The slot count has to follow the
  // group, which is the part that was leaving a stale row on the bar.
  const expectNext = (groups.cat + 1) % 4;
  const groupSizes = [10, 6, 4, 10];
  const groupsWork =
    groups.tabs === 4 &&
    afterTab.cat === expectNext &&
    afterTab.slots === groupSizes[expectNext] &&
    afterTab.litTabs === 1 &&
    backToWalls === groups.cat;
  // Not the floor from the ground, the floor once you are up there, and the pushout
  // lets go at the top while still holding at knee height.
  const topsStandable =
    onTop.found === true &&
    Math.abs(onTop.fromGround) < 0.01 &&
    Math.abs(onTop.fromLevel - 1.1) < 0.02 &&
    onTop.pushedAtTop < 0.01 &&
    onTop.pushedLow > 0.1;
  const roofSheltersYou =
    roofSide.found === true &&
    roofSide.underRidge < 0.01 &&
    roofSide.blocksSomewhere > 0.1 &&
    roofSide.ridgeSurface > 1.8;
  // Shut it stops you; open you come out the far side; shut again it stops you once
  // more, so the state really is a state and not a one-way door.
  const doorsOpen =
    door2.found === true &&
    door2.hasLeafLayer === true &&
    door2.leafCount === 1 &&
    door2.promptShut === 'doorLeaf' &&
    door2.openedFlag === true &&
    door2.promptOpen === true &&
    door2.shut > 0.3 &&
    door2.opened < -1 &&
    door2.shutAgain > 0.3;
  // Freed means the game is not holding the mouse, and pressing again gives it back.
  const cursorToggles =
    cursor.freed === false && freed.freed === true && freed.locked === false && regrabbed === false;
  // A bed on a floor stands on the floor's surface, not at the floor's base.
  const sitsOnFloor =
    onTopOf.found === true && onTopOf.lift > 0.2 && onTopOf.lift < 0.6;
  // Two fixtures aimed at two points along one wall land apart, both on the near side.
  // Two fixtures aimed at two points along one wall land apart from each other, both on
  // the side the player was standing on. How far they sit off the wall is measured by the
  // check above, which aims at a wall straight on; this one is about being able to place
  // more than one and about which face they end up on.
  const mountsWhereAimed =
    aimedMount.found === true &&
    aimedMount.first === true &&
    aimedMount.second === true &&
    aimedMount.apart > 1.5 &&
    aimedMount.sameSide === true &&
    aimedMount.nearSide === true;
  // Clear of the wall by about its half-thickness, facing into the room, and on the same
  // line as the wall rather than shifted along it.
  const fixturesMount =
    mounted.shelf === true &&
    mounted.offset > 0.08 &&
    mounted.offset < 0.4 &&
    mounted.facesIn > 0.9 &&
    mounted.alongWall < 0.01;
  // Every sample over a piece is held up, and the ground away from it is untouched.
  const furnitureHolds = ['bed', 'table', 'stool'].every((k) => {
    const f = furniture[k];
    if (!f || f.found !== true) return false;
    const heights = [f.top, ...f.cross];
    return heights.every((h) => h > 0.2) && Math.abs(f.away) < 0.01;
  });
  // Walked up on foot: every sample higher than the last, ending most of a cell up, with
  // room left underneath and no way through the low treads from the side.
  const stairsClimb =
    climb.found === true &&
    climb.heights.length > 3 &&
    climb.heights.every((h, i) => i === 0 || h > climb.heights[i - 1]) &&
    climb.climbed > 3 &&
    climb.underClear < 0.01 &&
    climb.sideBlocked > 0.1;
  // Back against the wall, standing on the floor: clear of the wall by its own depth and
  // not lifted off the ground.
  const cabinetFits =
    cupboard.found === true &&
    cupboard.offset > 0.24 &&
    cupboard.offset < 0.5 &&
    Math.abs(cupboard.lift) < 0.1 &&
    cupboard.alongWall < 0.01;
  // A pool of four, dark until something burns, aimed at the fire, and let go when you
  // walk away — so a hundred torches cost what four do.
  const firesLight =
    firelight.placed === true &&
    firelight.pool === 4 &&
    firelight.before === 0 &&
    firelight.lit >= 1 &&
    firelight.atFire < 0.5 &&
    firelight.intensity > 0 &&
    firelight.shadowless === true &&
    firelight.counted === true &&
    firelight.farLit === 0;
  // Not one program compiled by lighting a fire, and the pool still lights.
  const lightsAreFree =
    noRecompile.ok === true &&
    noRecompile.alwaysCounted === true &&
    noRecompile.after === noRecompile.before &&
    noRecompile.afterTorch === noRecompile.before &&
    noRecompile.lit >= 1;
  // Three shelves accepted on one wall at three distinct heights, at least one of them
  // finishing below the top of the cupboard already mounted there.
  const shelvesStack =
    stacking.placed === true &&
    stacking.accepted === 3 &&
    stacking.distinct === 3 &&
    stacking.below >= 1;
  // Furnishings darker than the structure, and still only two timber materials in all.
  const furnishDarker =
    stain.wall !== null &&
    stain.table !== null &&
    stain.table < stain.wall - 0.08 &&
    stain.cabinet === stain.table &&
    stain.shelf === stain.table &&
    stain.floor === stain.wall &&
    stain.materials === 2;
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
    labelThird !== '' &&
    labelWall !== '' &&
    labelThird !== labelWall;
  // One chosen slot, one raised slot, and the chosen one is what the label names.
  const styled = litNow.styled ?? [];
  // The one carrying the class must be the one that is drawn differently, and every
  // other slot must be drawn the same as each other. This is the check that caught a
  // raised square that did not match the chosen piece.
  const chosen = styled.filter((s) => s.on);
  const rest = styled.filter((s) => !s.on);
  const distinctlyDrawn =
    chosen.length === 1 &&
    rest.length > 0 &&
    new Set(rest.map((s) => s.border)).size === 1 &&
    chosen[0].border !== rest[0].border;
  const oneSelected =
    litNow.lit === 1 &&
    litNow.litKind === litNow.selected &&
    distinctlyDrawn &&
    styled.length === litNow.groupSize &&
    litNow.litTab === litNow.wantTab;

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
  line('name sits above the bar:', nameAbove, `"${labelThird}" / "${labelWall}"`);
  line(
    'exactly one slot looks chosen:',
    oneSelected,
    `kind=${litNow.litKind} selected=${litNow.selected} drawnApart=${distinctlyDrawn} slots=${styled.length} tab=${litNow.litTab}/${litNow.wantTab}`,
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
    `${scaling.placed} pieces, ${scaling.instanced} instanced meshes, ${scaling.childrenEmpty}->${scaling.childrenFull} children`,
  );
  line(
    'wheel switches, does not zoom:',
    wheelIsolated,
    `zoom ${wheelTest}->${afterWheel.zoom}, piece ${afterWheel.selected}`,
  );
  line('windows are glazed:', glassWorks, JSON.stringify(glazing.glassMeshes));
  line('gable fills the triangle:', gableFits, `widths ${JSON.stringify(gable.widths)} apex ${gable.apex}`);
  line(
    'groups switch with [ ]:',
    groupsWork,
    `${groups.cat} -> ${afterTab.cat} (${afterTab.slots} slots) -> ${backToWalls}`,
  );
  line(
    'you can stand on a railing:',
    topsStandable,
    `ground=${onTop.fromGround} up=${onTop.fromLevel} pushTop=${onTop.pushedAtTop} pushLow=${onTop.pushedLow}`,
  );
  line(
    'roof: shelter, shell, surface:',
    roofSheltersYou,
    `x=${JSON.stringify(roofSide.x)} z=${JSON.stringify(roofSide.z)} ridge=${roofSide.ridgeSurface}`,
  );
  line(
    'fixtures sit on the wall:',
    fixturesMount,
    `off=${mounted.offset} facing=${mounted.facesIn}`,
  );
  line(
    'stairs are walked up, not jumped:',
    stairsClimb,
    `rise=${JSON.stringify(climb.heights)} top=${climb.climbed} under=${climb.underClear} side=${climb.sideBlocked}`,
  );
  line(
    'a cabinet backs onto a wall:',
    cabinetFits,
    `off=${cupboard.offset} lift=${cupboard.lift} skew=${cupboard.alongWall}`,
  );
  line(
    'fires light the place up:',
    firesLight,
    `pool=${firelight.pool} lit=${firelight.lit} at=${firelight.atFire}m power=${firelight.intensity} away=${firelight.farLit}`,
  );
  line(
    'a fire compiles no shaders:',
    lightsAreFree,
    `programs ${noRecompile.before}->${noRecompile.after}->${noRecompile.afterTorch} counted=${noRecompile.alwaysCounted}`,
  );
  line(
    'shelves stack round a cupboard:',
    shelvesStack,
    `${stacking.accepted}/3 at ${JSON.stringify(stacking.ys)} below=${stacking.below} cupTop=${stacking.cabinetTop}`,
  );
  line(
    'furnishings darker than walls:',
    furnishDarker,
    `wall=${stain.wall} furniture=${stain.table} materials=${stain.materials}`,
  );
  line('a bed on a floor sits on it:', sitsOnFloor, `lift=${onTopOf.lift}`);
  line(
    'fixtures go where you aim:',
    mountsWhereAimed,
    `apart=${aimedMount.apart} nearSide=${aimedMount.nearSide} off=${aimedMount.offset}`,
  );
  line(
    'doors open and shut:',
    doorsOpen,
    `shut=${door2.shut} open=${door2.opened} shutAgain=${door2.shutAgain}`,
  );
  line('Alt frees the cursor:', cursorToggles, `freed=${freed.freed} locked=${freed.locked}`);
  line(
    'furniture holds you up:',
    furnitureHolds,
    ['bed', 'table', 'stool'].map((k) => `${k}=${furniture[k]?.top}`).join(' '),
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
    wheelIsolated &&
    glassWorks &&
    gableFits &&
    groupsWork &&
    topsStandable &&
    roofSheltersYou &&
    furnitureHolds &&
    stairsClimb &&
    cabinetFits &&
    firesLight &&
    lightsAreFree &&
    shelvesStack &&
    furnishDarker &&
    fixturesMount &&
    sitsOnFloor &&
    mountsWhereAimed &&
    doorsOpen &&
    cursorToggles &&
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
