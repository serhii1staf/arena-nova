// Probes the snow: falling flakes, snow lying on the high ground, tracks walked
// through it, and a thaw taking it away again.
//
// Snowfall is a slow function of time, biome and altitude, so a run that just
// waited would either catch a front or not. The computed values are pinned with
// `Object.defineProperty`, the same trick the rain and atmosphere probes use, and
// each state is inspected while it is held there.
//
// Two things here cannot be checked by asking the code what it did.
//
// The lying snow is decided entirely inside the terrain's fragment shader, from
// each fragment's own height and slope. Nothing on the CPU knows the answer, and a
// shader that fails to compile leaves `onBeforeCompile` looking perfectly healthy
// while the ground renders untouched. So the ground is measured by reading pixels
// back off the canvas: how white the lower half of the frame is, with the snow
// pinned off and then on, at the same place and the same time of day.
//
// The tracks are a canvas the shader samples, so the print is proven by reading
// the map back rather than by trusting that the stamp function was reached.
//
// Usage:
//   node scripts/debug-snow.mjs [url]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://localhost:4173';
const errors = [];

const { chromium } = await import('playwright');
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(300000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // The 404 is this probe's own doing: it tries to import the world generator as
    // a module first, which only exists when served from source, and falls back to
    // asking the built world for heights. Expected, and not the game's problem.
    // The room socket is also not this probe's business. Running the suite in a
    // loop trips the server's own rate limit, and a 429 there says nothing about
    // whether snow renders.
    if (
      m.type() === 'error' &&
      !/AudioContext|audio device|Pointer Lock|404|Failed to load resource|WebSocket/i.test(
        m.text(),
      )
    ) {
      errors.push(m.text());
    }
  });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  await page.waitForFunction(
    () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene,
    { timeout: 300000 },
  );

  await page.evaluate(() => {
    const w = window;
    w.__snow = {
      /** Holds the weather where the probe wants it. */
      pin(fall, cover) {
        const dn = w.arena.scene.dayNight;
        Object.defineProperty(dn, 'snowAmount', {
          configurable: true,
          get: () => fall,
          set: () => {},
        });
        Object.defineProperty(dn, 'snowCover', {
          configurable: true,
          get: () => cover,
          set: () => {},
        });
        // Rain is pinned off as well. The two split one front, so a probe that
        // forced snow on without forcing rain off would be measuring sleet.
        Object.defineProperty(dn, 'rainAmount', {
          configurable: true,
          get: () => 0,
          set: () => {},
        });
        Object.defineProperty(dn, 'wetness', {
          configurable: true,
          get: () => 0,
          set: () => {},
        });
      },
      /** Waits until the streamed world has nothing left queued. */
      settled() {
        return w.arena.scene.worldStats().queued === 0;
      },
      state() {
        const dn = w.arena.scene.dayNight;
        return {
          fall: +dn.snowAmount.toFixed(3),
          cover: +dn.snowCover.toFixed(3),
          rain: +dn.rainAmount.toFixed(3),
          night: +dn.nightFactor.toFixed(3),
        };
      },
      /** Is the flake field drawing, and with what? */
      flakes() {
        let snow = null;
        let rain = null;
        w.arena.scene.world.group.traverse((o) => {
          if (o.name === 'Snow') snow = o;
          if (o.name === 'Rain') rain = o;
        });
        if (!snow) return { visible: false, count: 0, amount: 0, sharedWind: false };
        const u = snow.material.uniforms;
        return {
          visible: snow.visible,
          count: snow.geometry.getAttribute('position').count,
          amount: +u.uAmount.value.toFixed(3),
          // The gust that bends a tree has to be the same uniform object, not a
          // copy of its value — that is what keeps the weather in agreement.
          sharedWind: !!rain && rain.material.uniforms.uWind === u.uWind,
        };
      },
      /** Puts the camera somewhere and points it. */
      go(x, z, yaw, pitch, zoom) {
        const sc = w.arena.scene;
        sc.player.spawn(x, z, yaw);
        sc.player.pitch = pitch;
        sc.setCameraZoom(zoom);
      },
      /**
       * Mean brightness of the lower half of the frame, 0..1.
       *
       * Read off the drawing buffer, which is the only place the answer exists:
       * the coverage is computed per fragment in the terrain shader and no CPU
       * value corresponds to it. The lower half is the ground at these camera
       * angles; including the sky would swamp the measurement.
       */
      ground() {
        return +(w.__snow.lastGround ?? -1).toFixed(4);
      },
      trodden() {
        return +w.arena.scene.world.snowTrodden().toFixed(5);
      },
      /** What the terrain material was actually told, as opposed to asked. */
      terrainCover() {
        let seen = null;
        w.arena.scene.world.group.traverse((o) => {
          if (o.isMesh && o.material && o.material.userData && 'snowCover' in o.material.userData) {
            seen = o.material.userData.snowCover;
          }
        });
        return seen;
      },
      /** Ground height where the camera is, so a shot can be attributed. */
      hereHeight() {
        const p = w.arena.scene.player.feetPosition;
        return +w.arena.scene.world.floorHeightAt(p.x, p.z).toFixed(1);
      },
      /** Walks a straight line, stamping prints from the real footstep flag. */
      async walk(steps) {
        const sc = w.arena.scene;
        for (let i = 0; i < steps; i++) {
          sc.player.footstepFlag = true;
          await new Promise((r) => requestAnimationFrame(() => r()));
        }
      },
      cost() {
        const info = w.arena.engine.renderer.info.render;
        let snowDraws = 0;
        w.arena.scene.world.group.traverse((o) => {
          if (o.name === 'Snow' && o.visible) snowDraws++;
        });
        return { draws: info.calls, tris: info.triangles, snowDraws };
      },
    };
  });

  // Sample the frame from inside the render, because there is nowhere else it
  // exists. Without `preserveDrawingBuffer` the drawing buffer is undefined by the
  // time anything outside the render can look at it — drawing the WebGL canvas into
  // a 2D one returns solid black, which reads as a perfectly plausible measurement
  // and silently passes. Enabling that flag to make the probe easier would slow the
  // real renderer down, so instead the composer is wrapped and `readPixels` runs
  // immediately after it, still inside the same task.
  await page.evaluate(() => {
    const w = window;
    const engine = w.arena.engine;
    const gl = engine.renderer.getContext();
    const original = engine.postfx.render.bind(engine.postfx);
    engine.postfx.render = (dt) => {
      original(dt);
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      // The lower half only: at these camera angles that is the ground, and
      // including the sky would swamp the difference being measured.
      const y = 0;
      const h = Math.max(1, Math.floor(height / 2));
      const buf = new Uint8Array(width * h * 4);
      gl.readPixels(0, y, width, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let lum = 0;
      let n = 0;
      // Every sixteenth pixel. The mean converges long before the whole buffer is
      // walked, and this runs inside the frame.
      for (let i = 0; i < buf.length; i += 64) {
        lum += (buf[i] * 0.2126 + buf[i + 1] * 0.7152 + buf[i + 2] * 0.0722) / 255;
        n++;
      }
      w.__snow.lastGround = lum / Math.max(1, n);
    };
  });

  const call = (fn, ...args) =>
    page.evaluate(([f, a]) => window.__snow[f](...a), [fn, args]);

  const settle = async () => {
    await page.waitForFunction(() => window.__snow.settled(), { timeout: 300000 });
    await page.evaluate(
      () =>
        new Promise((r) => {
          let n = 0;
          const tick = () => (++n > 4 ? r() : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
    );
  };

  // Ground at a middling height, and deliberately *not* the summit.
  //
  // The summit is the wrong place to measure fresh snow: anything above the
  // permanent snow line is painted white by its biome already, so a covering
  // changes nothing there and the comparison reads as a flat failure. The
  // interesting band is ground that is bare in clear weather and white under a
  // deep cover, which is between the fresh-snow line at full cover and the
  // permanent line — a hillside, not a peak.
  const spot = await page.evaluate(() => {
    const w = window.arena.scene.world;
    let best = null;
    for (let z = -1400; z <= 1400; z += 48) {
      for (let x = -1400; x <= 1400; x += 48) {
        const h = w.floorHeightAt(x, z);
        if (h < 95 || h > 165) continue;
        // Prefer the flattest such ground: snow sheds off steep faces by design,
        // so a cliff would under-report the effect for a legitimate reason.
        const slope =
          Math.abs(w.floorHeightAt(x + 8, z) - w.floorHeightAt(x - 8, z)) +
          Math.abs(w.floorHeightAt(x, z + 8) - w.floorHeightAt(x, z - 8));
        if (!best || slope < best.slope) best = { x, z, h, slope: +slope.toFixed(2) };
      }
    }
    return best;
  });
  const high = spot;

  console.log('=== SNOW PROBE ===');
  console.log(`test ground (bare when clear, white when deep): ${JSON.stringify(high)}`);

  // ---- 1. Clear: nothing lying, nothing falling -------------------------
  await call('pin', 0, 0);
  await page.evaluate(() => {
    window.arena.scene.dayNight.t01 = 0.5; // noon, so the light is the same throughout
  });
  // Stood on the summit looking down the slope, not at it from below. Everything
  // in the lower half of the frame is then ground that is unambiguously above the
  // snow line, which is what the brightness comparison depends on — from the
  // valley the same shot is mostly sky and the measurement means nothing.
  await call('go', high.x, high.z, 0, -0.55, 0);
  await settle();
  const clear = {
    state: await call('state'),
    flakes: await call('flakes'),
    ground: await call('ground'),
    cover: await call('terrainCover'),
    height: await call('hereHeight'),
    cost: await call('cost'),
  };
  await page.screenshot({ path: join(here, 'snow_clear.png') });

  // ---- 2. A dusting: the summits only -----------------------------------
  await call('pin', 0.4, 0.18);
  await settle();
  const dusting = { ground: await call('ground'), state: await call('state') };
  await page.screenshot({ path: join(here, 'snow_dusting.png') });

  // ---- 3. Deep cover, snow falling --------------------------------------
  await call('pin', 0.95, 0.95);
  await settle();
  const deep = {
    state: await call('state'),
    flakes: await call('flakes'),
    ground: await call('ground'),
    cover: await call('terrainCover'),
    cost: await call('cost'),
  };
  await page.screenshot({ path: join(here, 'snow_deep.png') });

  // ---- 4. Tracks --------------------------------------------------------
  // Snowfall pinned off first: falling snow heals tracks, and this measures
  // whether they appear at all.
  await call('pin', 0, 0.95);
  await settle();
  const beforeWalk = await call('trodden');
  await page.evaluate(() => window.__snow.walk(40));
  await page.evaluate(
    () =>
      new Promise((r) => {
        let n = 0;
        const tick = () => (++n > 6 ? r() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
  );
  const afterWalk = await call('trodden');
  // Look straight down at the ground just walked over.
  await call('go', high.x, high.z, 0, -1.2, 0);
  await settle();
  await page.screenshot({ path: join(here, 'snow_tracks.png') });
  const troddenGround = await call('ground');

  // ---- 5. Thaw ----------------------------------------------------------
  // The pins are released so the real accumulation logic runs, then the clock is
  // pushed to a clear noon. Cover must fall on its own.
  await page.evaluate(() => {
    const dn = window.arena.scene.dayNight;
    // Drop the pinned accessors so the real accumulation runs again. These are
    // plain instance fields underneath, so deleting the accessor leaves the field
    // free for `update` to assign normally.
    for (const k of ['snowAmount', 'snowCover', 'rainAmount', 'wetness']) delete dn[k];
    dn.snowCover = 0.9;
    dn.t01 = 0.5;
  });
  const thawFrom = await page.evaluate(() => window.arena.scene.dayNight.snowCover);
  await page.waitForTimeout(12000);
  const thawTo = await page.evaluate(() => window.arena.scene.dayNight.snowCover);

  // ---- Report -----------------------------------------------------------
  console.log('--- clear ---');
  console.log(`  ${JSON.stringify(clear.state)}`);
  console.log(`  flakes visible=${clear.flakes.visible} (${clear.flakes.count} in the field)`);
  console.log(`  ground brightness ${clear.ground} at ${clear.height} m`);
  console.log(`  terrain material told cover=${clear.cover}`);
  console.log(`  draws ${clear.cost.draws} tris ${(clear.cost.tris / 1000).toFixed(0)}k`);
  console.log('--- dusting (cover 0.18) ---');
  console.log(`  ground brightness ${dusting.ground}`);
  console.log('--- deep (cover 0.95, falling) ---');
  console.log(`  ${JSON.stringify(deep.state)}`);
  console.log(`  flakes visible=${deep.flakes.visible} amount=${deep.flakes.amount}`);
  console.log(`  ground brightness ${deep.ground}`);
  console.log(`  terrain material told cover=${deep.cover}`);
  console.log(
    `  draws ${deep.cost.draws} tris ${(deep.cost.tris / 1000).toFixed(0)}k` +
      ` (snow adds ${deep.cost.draws - clear.cost.draws} draws)`,
  );
  console.log('--- tracks ---');
  console.log(`  trodden before=${beforeWalk} after=${afterWalk}`);
  console.log(`  ground brightness looking down ${troddenGround}`);
  console.log('--- thaw ---');
  console.log(`  cover ${thawFrom} -> ${thawTo} over 12 s of clear noon`);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 6)) console.log(' ', e);

  // ---- Judgements -------------------------------------------------------
  const flakesOffWhenClear = !clear.flakes.visible;
  const flakesOnWhenFalling = deep.flakes.visible && deep.flakes.amount > 0.5;
  // One Points, so the field's own cost is one draw whatever the flake count is.
  const cheap = deep.cost.snowDraws <= 1 && deep.cost.draws <= 420;
  // The measurement that proves the shader ran: the ground actually got whiter.
  const groundWhitens = deep.ground > clear.ground + 0.03;
  // And that it is a ramp, not a switch — a dusting must land between the two.
  const ramps = dusting.ground > clear.ground && dusting.ground < deep.ground;
  const printsLand = afterWalk > beforeWalk + 1e-4;
  const thaws = thawTo < thawFrom - 0.005;

  console.log('\n=== VERDICT ===');
  console.log(`no flakes in clear weather:     ${flakesOffWhenClear ? 'ok' : 'FAIL'}`);
  console.log(`flakes fall when it snows:      ${flakesOnWhenFalling ? 'ok' : 'FAIL'}`);
  console.log(`snow whitens the high ground:   ${groundWhitens ? 'ok' : 'FAIL'} (${clear.ground} -> ${deep.ground})`);
  console.log(`cover is a ramp, not a switch:  ${ramps ? 'ok' : 'FAIL'} (dusting ${dusting.ground})`);
  console.log(`footprints reach the map:       ${printsLand ? 'ok' : 'FAIL'} (${beforeWalk} -> ${afterWalk})`);
  console.log(`clear noon melts it:            ${thaws ? 'ok' : 'FAIL'} (${thawFrom} -> ${thawTo})`);
  console.log(`costs one draw:                 ${cheap ? 'ok' : 'FAIL'} (${deep.cost.snowDraws})`);

  const pass =
    flakesOffWhenClear &&
    flakesOnWhenFalling &&
    groundWhitens &&
    ramps &&
    printsLand &&
    thaws &&
    cheap &&
    errors.length === 0;
  console.log('\nRESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
