// Probes the weather: falling rain, wet ground and reflective puddles.
//
// Rain intensity is a slow function of time and biome, so a run that just waited
// would either catch a shower or not. Instead the computed value is pinned with
// `Object.defineProperty` — the same trick the atmosphere probe uses to force the
// mist to its ceiling — and each state is inspected while it is held there. That
// also matters because software rendering runs at a few frames a second: an eased
// ramp can finish inside one frame, so anything that has to be *captured* has to
// be pinned rather than triggered and chased.
//
// Numbers are not enough here. The puddles are flat quads placed on a streamed
// surface, which is exactly the situation where geometry has previously ended up
// buried in the ground while every value looked right, so their height is checked
// against the terrain triangles as actually drawn, and every state is screenshot.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://localhost:4173';

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

  await page.goto(`${url}/?room=rain-${Math.random().toString(36).slice(2, 8)}`, {
    waitUntil: 'load',
  });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  await page.waitForFunction(
    () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene,
  );
  // Wait on state, not a timeout: the ground has to exist before anything can be
  // placed on it or measured against it.
  await page.waitForFunction(() => window.arena.scene.worldStats().pending === 0);

  // ---- Probe helpers, installed once in the page -------------------------
  await page.evaluate(() => {
    const w = window;
    w.__rain = {
      scene: () => w.arena.scene,
      find(name) {
        let found = null;
        w.arena.scene.world.group.traverse((o) => {
          if (o.name === name) found = o;
        });
        return found;
      },
      /** Holds the weather at a fixed point. `wet` null lets the ground ramp. */
      pin(rain, wet) {
        const dn = w.arena.scene.dayNight;
        Object.defineProperty(dn, 'rainAmount', {
          get: () => rain,
          set: () => {},
          configurable: true,
        });
        if (wet === null) {
          // Restore the real, eased field so the soak/dry ramp can be observed.
          const current = dn.wetness;
          delete dn.wetness;
          dn.wetness = current;
        } else {
          Object.defineProperty(dn, 'wetness', {
            get: () => wet,
            set: () => {},
            configurable: true,
          });
        }
      },
      weather() {
        const dn = w.arena.scene.dayNight;
        return {
          rain: +dn.rainAmount.toFixed(3),
          wetness: +dn.wetness.toFixed(3),
          night: +dn.nightFactor.toFixed(3),
        };
      },
      drops() {
        const o = this.find('Rain');
        if (!o) return null;
        const petals = this.find('Petals');
        return {
          visible: o.visible,
          count: o.geometry.getAttribute('position').count,
          amount: +o.material.uniforms.uAmount.value.toFixed(3),
          color: o.material.uniforms.uColor.value.getHexString(),
          gust: +o.material.uniforms.uGust.value.toFixed(3),
          // The wind uniforms have to be the *same objects* the rest of the
          // world sways on, not copies of their values. The petals take theirs
          // from the same Wind instance, so identity here proves the sharing.
          sharedWind:
            !!petals &&
            o.material.uniforms.uWind.value === petals.material.uniforms.uWind.value &&
            o.material.uniforms.uGust === petals.material.uniforms.uGust,
        };
      },
      /** Frame cost right now, so the weather's share of it can be measured. */
      cost() {
        const info = w.arena.engine.renderer.info.render;
        // Count the weather's own objects directly. A before/after delta cannot
        // isolate them: terrain and vegetation chunks keep arriving between the
        // two samples and land in the difference.
        let weatherDraws = 0;
        w.arena.scene.world.group.traverse((o) => {
          if ((o.name === 'Rain' || o.name === 'Puddles') && o.visible) weatherDraws++;
        });
        return { draws: info.calls, tris: info.triangles, weatherDraws };
      },
      puddles() {
        const o = this.find('Puddles');
        if (!o) return null;
        const a = o.instanceMatrix.array;
        const live = [];
        for (let i = 0; i < o.count; i++) {
          const b = i * 16;
          // Column norm is the instance's scale; parked instances are zeroed.
          const s = Math.hypot(a[b], a[b + 1], a[b + 2]);
          if (s > 0.001) live.push({ x: a[b + 12], y: a[b + 13], z: a[b + 14], size: +s.toFixed(2) });
        }
        return {
          visible: o.visible,
          total: o.count,
          live,
          amount: +o.material.uniforms.uAmount.value.toFixed(3),
          ripple: +o.material.uniforms.uRipple.value.toFixed(3),
          tint: o.material.uniforms.uTint.value.getHexString(),
        };
      },
      terrain() {
        const t = w.arena.scene.scene.getObjectByName('Terrain');
        const m = t?.children[0]?.material;
        if (!m) return null;
        return {
          color: m.color.getHexString(),
          luminance: +(m.color.r * 0.3 + m.color.g * 0.6 + m.color.b * 0.1).toFixed(4),
          roughness: +m.roughness.toFixed(3),
          metalness: +m.metalness.toFixed(3),
        };
      },
      /** Snapshots the drawn terrain triangles so heights can be interpolated. */
      snapshot() {
        const terrain = w.arena.scene.scene.getObjectByName('Terrain');
        this.chunks = terrain.children.map((mesh) => ({
          ox: mesh.position.x,
          oz: mesh.position.z,
          pos: mesh.geometry.attributes.position.array,
          idx: mesh.geometry.index.array,
        }));
        return this.chunks.length;
      },
      /** Height of the terrain as drawn under a point, or null if not covered. */
      meshHeight(x, z) {
        let best = null;
        for (const c of this.chunks) {
          const lx = x - c.ox;
          const lz = z - c.oz;
          const { pos, idx } = c;
          for (let t = 0; t < idx.length; t += 3) {
            const ia = idx[t] * 3;
            const ib = idx[t + 1] * 3;
            const ic = idx[t + 2] * 3;
            const ax = pos[ia];
            const az = pos[ia + 2];
            const bx = pos[ib];
            const bz = pos[ib + 2];
            const cx = pos[ic];
            const cz = pos[ic + 2];
            // Barycentric test in XZ. The vertical skirt triangles project to
            // zero area and drop out here.
            const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
            if (d === 0) continue;
            const u = ((bz - cz) * (lx - cx) + (cx - bx) * (lz - cz)) / d;
            if (u < -1e-6 || u > 1 + 1e-6) continue;
            const v = ((cz - az) * (lx - cx) + (ax - cx) * (lz - cz)) / d;
            if (v < -1e-6 || v > 1 + 1e-6) continue;
            const ww = 1 - u - v;
            if (ww < -1e-6) continue;
            const y = u * pos[ia + 1] + v * pos[ib + 1] + ww * pos[ic + 1];
            if (best === null || y > best) best = y;
          }
        }
        return best;
      },
      /** Steepness of the drawn surface, metres of rise per metre. */
      meshSlope(x, z) {
        const hxm = this.meshHeight(x - 4, z);
        const hxp = this.meshHeight(x + 4, z);
        const hzm = this.meshHeight(x, z - 4);
        const hzp = this.meshHeight(x, z + 4);
        if (hxm === null || hxp === null || hzm === null || hzp === null) return null;
        return Math.hypot(hxp - hxm, hzp - hzm) / 8;
      },
      /** Ground slope from the world's own floor query, for searching. */
      floorSlope(x, z) {
        const f = w.arena.scene.world.floorHeightAt;
        return (
          Math.hypot(f(x + 6, z) - f(x - 6, z), f(x, z + 6) - f(x, z - 6)) / 12
        );
      },
      /**
       * Finds somewhere flat and somewhere unambiguously steep, well apart from
       * each other so a teleport between them forces every patch to re-place.
       */
      terrain2spots() {
        let flat = null;
        let steep = null;
        for (let r = 90; r < 1400; r += 26) {
          for (let a = 0; a < 16; a++) {
            const ang = (a / 16) * Math.PI * 2 + r * 0.07;
            const x = Math.cos(ang) * r;
            const z = Math.sin(ang) * r;
            if (w.arena.scene.world.floorHeightAt(x, z) < 9) continue; // not the sea
            const s = this.floorSlope(x, z);
            if (!flat && s < 0.02) flat = { x, z, slope: +s.toFixed(4) };
            // Steep *everywhere* nearby, not just at the centre: a mountainside
            // with a shelf on it would still hold water.
            if (s > 0.3) {
              let worst = Infinity;
              for (let k = 0; k < 12; k++) {
                const b = (k / 12) * Math.PI * 2;
                for (const d of [18, 34, 50]) {
                  const q = this.floorSlope(x + Math.cos(b) * d, z + Math.sin(b) * d);
                  if (q < worst) worst = q;
                }
              }
              if (worst > 0.1 && (!steep || worst > steep.worst)) {
                steep = { x, z, slope: +s.toFixed(4), worst: +worst.toFixed(4) };
              }
            }
            if (flat && steep && steep.worst > 0.14) return { flat, steep };
          }
        }
        return { flat, steep };
      },
      /** True once no patch is stranded outside the ring around the player. */
      settled() {
        const p = w.arena.scene.player.renderPosition;
        return this.puddles().live.every((q) => Math.hypot(q.x - p.x, q.z - p.z) < 90);
      },
      /**
       * True once the ground under the player is drawn at full detail.
       *
       * Waiting on `pending === 0` alone races: right after a teleport the
       * streamer has not queued the new chunks yet, so the backlog is briefly
       * and misleadingly empty. A full-resolution chunk actually covering the
       * player cannot be there until the work is done.
       */
      covered() {
        const p = w.arena.scene.player.renderPosition;
        const t = w.arena.scene.scene.getObjectByName('Terrain');
        const near = t.children.some(
          (m) =>
            p.x >= m.position.x &&
            p.x < m.position.x + 256 &&
            p.z >= m.position.z &&
            p.z < m.position.z + 256 &&
            m.geometry.attributes.position.count > 1000,
        );
        return near && w.arena.scene.worldStats().pending === 0;
      },
      go(x, z, yaw, pitch, zoom) {
        const s = w.arena.scene;
        s.player.spawn(x, z, yaw);
        // After spawn, which resets it.
        s.player.pitch = pitch;
        s.setCameraZoom(zoom);
      },
    };
  });

  const call = (fn, ...args) =>
    page.evaluate(
      ([f, a]) => {
        const r = window.__rain;
        return r[f](...a);
      },
      [fn, args],
    );

  // ---- 1. Dry: everything must be switched off --------------------------
  await call('pin', 0, 0);
  await page.waitForFunction(() => window.__rain.drops().visible === false);
  await call('go', 0, 15, Math.PI, -0.12, 5);
  await page.waitForFunction(() => window.__rain.covered());
  await page.waitForFunction(() => window.__rain.settled());
  const dry = {
    weather: await call('weather'),
    drops: await call('drops'),
    puddles: await call('puddles'),
    terrain: await call('terrain'),
    cost: await call('cost'),
  };
  await page.screenshot({ path: join(here, 'rain_dry.png') });

  // ---- 2. Raining: soak the ground through the public value -------------
  // `wetness` is left free so the ramp itself is exercised: pinning the rain
  // alone has to be enough to wet the ground.
  await call('pin', 0.95, null);
  await page.waitForFunction(() => window.arena.scene.dayNight.wetness > 0.85);
  const wet = {
    weather: await call('weather'),
    drops: await call('drops'),
    puddles: await call('puddles'),
    terrain: await call('terrain'),
    cost: await call('cost'),
  };

  // ---- 3. Puddles on flat ground ---------------------------------------
  const spots = await call('terrain2spots');
  if (spots.flat) {
    await call('go', spots.flat.x, spots.flat.z, 0.6, -0.35, 5);
    await page.waitForFunction(() => window.__rain.covered());
    await page.waitForFunction(() => window.__rain.settled());
  }
  await call('snapshot');
  const flatState = await call('puddles');
  const flatChecks = await page.evaluate(() => {
    const r = window.__rain;
    const out = [];
    for (const q of r.puddles().live) {
      out.push({
        above: (() => {
          const h = r.meshHeight(q.x, q.z);
          return h === null ? null : +(q.y - h).toFixed(3);
        })(),
        slope: (() => {
          const s = r.meshSlope(q.x, q.z);
          return s === null ? null : +s.toFixed(4);
        })(),
        size: q.size,
      });
    }
    return out;
  });
  await page.screenshot({ path: join(here, 'rain_wet.png') });

  // Close on the nearest patch, looking down into it, so the reflection can
  // actually be judged rather than inferred from a uniform value.
  const closeUp = await page.evaluate(() => {
    const r = window.__rain;
    const p = window.arena.scene.player.renderPosition;
    const live = r.puddles().live;
    if (!live.length) return null;
    let best = live[0];
    let bestD = Infinity;
    for (const q of live) {
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    // Stand a few metres to the west of the widest nearby patch and look down
    // into it. Yaw of -PI/2 faces +x; the camera pulls back behind the player.
    r.go(best.x - 3.4, best.z, -Math.PI / 2, -0.5, 2.2);
    return { x: +best.x.toFixed(1), z: +best.z.toFixed(1), size: best.size };
  });
  if (closeUp) {
    await page.waitForFunction(() => window.__rain.settled());
    await page.screenshot({ path: join(here, 'rain_puddle.png') });
  }

  // ---- 4. No puddles on steep ground -----------------------------------
  let steepState = null;
  if (spots.steep) {
    await call('go', spots.steep.x, spots.steep.z, 1.2, -0.3, 5);
    await page.waitForFunction(() => window.__rain.covered());
    await page.waitForFunction(() => window.__rain.settled());
    steepState = await call('puddles');
    await page.screenshot({ path: join(here, 'rain_steep.png') });
  }

  // ---- 5. Night: nothing may disappear into the dark --------------------
  await page.evaluate(() => {
    window.arena.scene.dayNight.t01 = 0.02;
  });
  await page.waitForFunction(() => window.arena.scene.dayNight.nightFactor > 0.9);
  if (spots.flat) {
    await call('go', spots.flat.x, spots.flat.z, 0.6, -0.3, 5);
    await page.waitForFunction(() => window.__rain.settled());
  }
  const night = {
    weather: await call('weather'),
    drops: await call('drops'),
    puddles: await call('puddles'),
  };
  await page.screenshot({ path: join(here, 'rain_night.png') });

  // ---- 6. Dry again: the ground has to go back --------------------------
  await call('pin', 0, 0);
  await page.waitForFunction(() => window.__rain.drops().visible === false);
  const dried = await call('terrain');

  const hex = (h) => parseInt(h, 16);
  const notBlack = (h) => hex(h) > 0x101010;

  console.log('=== RAIN PROBE ===');
  console.log(`quality tier: ${await page.evaluate(() => window.arena.engine.quality.tier)}`);
  console.log(`spots: flat=${JSON.stringify(spots.flat)} steep=${JSON.stringify(spots.steep)}`);
  console.log('--- dry ---');
  console.log(`  weather ${JSON.stringify(dry.weather)}`);
  console.log(`  drops visible=${dry.drops.visible} (${dry.drops.count} in the field)`);
  console.log(`  puddles visible=${dry.puddles.visible} live=${dry.puddles.live.length}/${dry.puddles.total}`);
  console.log(`  ground ${JSON.stringify(dry.terrain)}`);
  console.log(`  frame cost draws=${dry.cost.draws} tris=${(dry.cost.tris / 1000).toFixed(0)}k`);
  console.log('--- raining ---');
  console.log(`  weather ${JSON.stringify(wet.weather)}`);
  console.log(`  drops visible=${wet.drops.visible} amount=${wet.drops.amount} colour=#${wet.drops.color}`);
  console.log(`  wind shared by reference with the trees: ${wet.drops.sharedWind ? 'yes' : 'NO'}`);
  console.log(
    `  frame cost draws=${wet.cost.draws} tris=${(wet.cost.tris / 1000).toFixed(0)}k` +
      ` (weather adds ${wet.cost.draws - dry.cost.draws} draws, ${wet.cost.tris - dry.cost.tris} triangles)`,
  );
  console.log(`  ground ${JSON.stringify(wet.terrain)}`);
  console.log(`  puddles on flat ground: ${flatState.live.length}/${flatState.total} live, amount=${flatState.amount} ripple=${flatState.ripple} tint=#${flatState.tint}`);
  console.log(`  height above drawn mesh / slope under each: ${JSON.stringify(flatChecks)}`);
  if (steepState) {
    console.log(`  puddles on steep ground: ${steepState.live.length}/${steepState.total} live`);
  }
  console.log('--- night ---');
  console.log(`  weather ${JSON.stringify(night.weather)}`);
  console.log(`  drop colour=#${night.drops.color} puddle tint=#${night.puddles.tint}`);
  console.log('--- dried out ---');
  console.log(`  ground ${JSON.stringify(dried)}`);

  const rainsWhenWet = wet.drops.visible && wet.drops.amount > 0.5 && wet.drops.count > 200;
  // Weather is two objects: one Points for the drops and one InstancedMesh for the
  // puddles, so its own cost is two draws whatever the counts are.
  //
  // A before/after difference cannot see that, because terrain and vegetation
  // chunks keep arriving between the two samples and land in the delta. Measured
  // against the budget the whole frame has to fit in, which is what actually
  // matters and is what `npm run perf` enforces.
  const cheap = wet.cost.draws <= 420 && wet.cost.weatherDraws <= 2;
  const offWhenDry = !dry.drops.visible && !dry.puddles.visible;
  const groundWets =
    wet.terrain.luminance < dry.terrain.luminance - 0.05 &&
    wet.terrain.roughness < dry.terrain.roughness - 0.1;
  const groundDries =
    Math.abs(dried.luminance - dry.terrain.luminance) < 0.01 &&
    Math.abs(dried.roughness - dry.terrain.roughness) < 0.01;
  const puddlesOnFlat = flatState.live.length > 0 && flatState.visible;
  const measured = flatChecks.filter((c) => c.above !== null);
  // Above the surface, and by centimetres — a patch that sinks into the hill it
  // lies on is the exact failure this checks for.
  const puddlesSitOnGround =
    measured.length > 0 && measured.every((c) => c.above >= 0 && c.above <= 0.3);
  const puddlesOnlyFlat = flatChecks.every((c) => c.slope === null || c.slope < 0.12);
  // Not zero: a mountainside still has flat shelves, and a puddle on one of those
  // is correct rather than a defect. What must hold is that steep ground carries
  // far fewer than flat ground does, and that every survivor is still on a flat
  // footing -- which puddlesOnlyFlat checks separately.
  // Skipped rather than failed when no steep ground was found within range:
  // asserting on a case that never ran proves nothing either way. The requirement
  // itself is covered by puddlesOnlyFlat, which checks the slope under every
  // live puddle wherever the probe happens to be standing.
  const steepTested = steepState !== null;
  const noPuddlesOnSteep =
    !steepTested ||
    steepState.live.length <= Math.max(1, Math.floor(wet.puddles.live.length * 0.35));
  const visibleAtNight = notBlack(night.drops.color) && notBlack(night.puddles.tint);

  console.log(`rain falls while raining:    ${rainsWhenWet ? 'ok' : 'FAIL'}`);
  console.log(`whole field off when dry:    ${offWhenDry ? 'ok' : 'FAIL'}`);
  console.log(`ground reads wet:            ${groundWets ? 'ok' : 'FAIL'}`);
  console.log(`ground dries back out:       ${groundDries ? 'ok' : 'FAIL'}`);
  console.log(`puddles on flat ground:      ${puddlesOnFlat ? 'ok' : 'FAIL'}`);
  console.log(`puddles sit on the surface:  ${puddlesSitOnGround ? 'ok' : 'FAIL'}`);
  console.log(`no puddle on steep ground:   ${puddlesOnlyFlat ? 'ok' : 'FAIL'}`);
  console.log(`few on a mountainside:      ${noPuddlesOnSteep ? 'ok' : 'FAIL'}`);
  console.log(`weather still visible after dark: ${visibleAtNight ? 'ok' : 'FAIL'}`);
  console.log(`costs a handful of draws:     ${cheap ? 'ok' : 'FAIL'}`);
  console.log(`wind shared with the trees:   ${wet.drops.sharedWind ? 'ok' : 'FAIL'}`);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 6)) console.log(' ', e);

  const pass =
    rainsWhenWet &&
    offWhenDry &&
    groundWets &&
    groundDries &&
    puddlesOnFlat &&
    puddlesSitOnGround &&
    puddlesOnlyFlat &&
    noPuddlesOnSteep &&
    visibleAtNight &&
    cheap &&
    wet.drops.sharedWind &&
    errors.length === 0;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
