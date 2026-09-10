// Measures the cost of stepping out of the lobby into the open world.
//
// This is the one thing the world probe deliberately cannot see. `debug-world.mjs`
// requests the exterior and then waits six seconds before its first snapshot, so it
// reports the world in its settled state and says nothing at all about the seconds
// the player actually complains about. The hitch on the transition is a *timing*
// defect, and nothing in the repo measured frame timing.
//
// What it does:
//   1. Boots into the lobby and lets it settle, so the numbers are not polluted by
//      first-load compilation that has nothing to do with the transition.
//   2. Installs a frame recorder that runs off requestAnimationFrame, i.e. outside
//      the engine, so a stalled engine cannot hide a stalled frame.
//   3. Asks for the exterior and keeps recording across the switch and well past it.
//   4. Reports the frame-time distribution, how long the world stays unsettled, and
//      the streaming backlog and resolution scale over the same window.
//
// Read the percentiles, not the mean. A mean of 20 ms with a p99 of 300 ms is the
// signature of exactly the problem being looked for, and averages hide it.
//
// Software GL is very slow in absolute terms, so the thresholds below are about
// *shape* — how much worse the transition window is than the same renderer's own
// steady state — and the comparison that matters is one run against another.
//
// Usage:
//   node scripts/debug-transition.mjs [url] [--window=18]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('http')) ?? 'http://localhost:4173';
const windowArg = args.find((a) => a.startsWith('--window='));
/** Seconds of recording after the switch is requested. */
const WINDOW_S = windowArg ? Number(windowArg.split('=')[1]) : 18;

const errors = [];
const { chromium } = await import('playwright');
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});

/** Percentile of a sorted array. */
const q = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

const summarise = (frames) => {
  if (frames.length === 0) return null;
  const sorted = [...frames].sort((a, b) => a - b);
  return {
    frames: frames.length,
    median: +q(sorted, 0.5).toFixed(1),
    p90: +q(sorted, 0.9).toFixed(1),
    p99: +q(sorted, 0.99).toFixed(1),
    worst: +sorted[sorted.length - 1].toFixed(1),
    over33: frames.filter((f) => f > 33).length,
    over100: frames.filter((f) => f > 100).length,
    over250: frames.filter((f) => f > 250).length,
  };
};

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(300000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/AudioContext|audio device|Pointer Lock/i.test(m.text())) {
      errors.push(m.text());
    }
  });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');

  // Let the lobby reach a steady state first. Everything after this point is the
  // transition and only the transition.
  await page.waitForFunction(() => window.arena?.engine?.scenes?.currentName === 'lobby');
  await page.waitForTimeout(6000);

  // Baseline: the same renderer, same page, nothing happening. Without it the
  // transition numbers have nothing to be compared against, and software GL is
  // slow enough that raw milliseconds mean very little on their own.
  const baseline = await page.evaluate(
    (secs) =>
      new Promise((done) => {
        const out = [];
        let last = performance.now();
        const until = last + secs * 1000;
        const tick = (now) => {
          out.push(now - last);
          last = now;
          if (now < until) requestAnimationFrame(tick);
          else done(out);
        };
        requestAnimationFrame(tick);
      }),
    4,
  );

  // Record across the switch. The recorder is its own rAF loop rather than an
  // engine hook on purpose: while the scene is being built the engine's tick
  // returns early without rendering, so anything driven by the engine would simply
  // not observe the frames that matter most.
  await page.evaluate(() => {
    window.__t = { frames: [], marks: [], samples: [], stream: [], started: performance.now() };
    let last = performance.now();
    const tick = (now) => {
      window.__t.frames.push({ at: now - window.__t.started, ms: now - last });
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // State alongside the frames, so a spike can be attributed rather than guessed
    // at. Sampled on a timer because it must keep sampling while the engine is
    // blocked inside the scene build.
    // The streaming cost of every rendered frame, not a periodic sample.
    //
    // This is the measurement that survives a software rasteriser. End-to-end
    // frame time under SwiftShader is dominated by rasterisation — the settled
    // world runs near a second per frame — so its percentiles say nothing about
    // the streaming defect. `streamMs` is pure CPU spent building chunks, and
    // world chunks are only ever built inside a pump, which only runs on a
    // rendered frame. So one sample per frame is not a sample at all: it is every
    // build the world does, complete, however slow the GPU happens to be.
    window.__t.unhook = window.arena.engine.onFrame(() => {
      const scene = window.arena.engine.scenes.current;
      const s = scene?.worldStats?.();
      if (!s || typeof s.streamMs !== 'number') return;
      window.__t.stream.push({
        at: performance.now() - window.__t.started,
        ms: s.streamMs,
        queued: s.queued,
        cost: s.cost,
      });
    });

    window.__t.sampler = setInterval(() => {
      const eng = window.arena?.engine;
      const scene = eng?.scenes?.current;
      let stats = null;
      try {
        stats = scene?.worldStats?.() ?? null;
      } catch {
        stats = null;
      }
      window.__t.samples.push({
        at: performance.now() - window.__t.started,
        scene: eng?.scenes?.currentName ?? '?',
        res: eng ? +eng.quality.currentResolutionScale.toFixed(2) : null,
        tier: eng?.quality?.tier ?? '?',
        chunks: stats?.chunks ?? null,
        queued: stats?.queued ?? null,
        backlog: stats?.backlog ?? null,
      });
    }, 250);
  });

  const switchAt = await page.evaluate(() => {
    const t = performance.now() - window.__t.started;
    window.__t.marks.push({ label: 'requestScene', at: t });
    window.arena.engine.requestScene('exterior');
    return t;
  });

  await page.waitForFunction(
    () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene,
    { timeout: 300000 },
  );
  const arrivedAt = await page.evaluate(() => {
    const t = performance.now() - window.__t.started;
    window.__t.marks.push({ label: 'exteriorLive', at: t });
    return t;
  });

  await page.waitForTimeout(WINDOW_S * 1000);

  const rec = await page.evaluate(() => {
    clearInterval(window.__t.sampler);
    window.__t.unhook?.();
    return {
      frames: window.__t.frames,
      marks: window.__t.marks,
      samples: window.__t.samples,
      stream: window.__t.stream,
      primeMs: window.arena.engine.scenes.current?.worldStats?.().primeMs ?? null,
    };
  });
  await page.screenshot({ path: join(here, 'transition_after.png') });

  // ---- Report --------------------------------------------------------------
  const base = summarise(baseline.slice(2));
  // Frames are attributed by when they *ended*, and the switch frame is the one
  // that straddles the request: it is charged to the transition, which is where it
  // belongs, since it contains the teardown and most of the build.
  const during = rec.frames.filter((f) => f.at >= switchAt && f.at <= arrivedAt + 6000);
  const settled = rec.frames.filter((f) => f.at > arrivedAt + 6000);
  const dur = summarise(during.map((f) => f.ms));
  const set = summarise(settled.map((f) => f.ms));

  console.log('=== TRANSITION: LOBBY -> EXTERIOR ===');
  console.log(`url: ${url}`);
  console.log(`switch requested at ${switchAt.toFixed(0)} ms, exterior live at ${arrivedAt.toFixed(0)} ms`);
  console.log(`scene build (fade + teardown + build): ${(arrivedAt - switchAt).toFixed(0)} ms`);
  console.log(`prime() cost: ${rec.primeMs === null ? 'n/a' : `${rec.primeMs.toFixed(0)} ms of CPU`}`);

  // --- The primary metric ---------------------------------------------------
  // CPU spent building chunks, per rendered frame, against the 5 ms the streamer
  // is budgeted. Reported first because it is the only figure here that is not
  // distorted by the renderer: see the note in the page hook above.
  const BUDGET = 5;
  const streamAll = rec.stream.map((s) => s.ms);
  const streamBusy = rec.stream.filter((s) => s.queued > 0).map((s) => s.ms);
  const sAll = summarise(streamAll);
  const sBusy = summarise(streamBusy);
  const overruns = streamAll.filter((m) => m > BUDGET).length;
  const bigOverruns = streamAll.filter((m) => m > BUDGET * 4).length;
  console.log(`\nstreaming CPU per frame, ms (budget ${BUDGET} ms)`);
  console.log(`  while backlog draining: ${JSON.stringify(sBusy)}`);
  console.log(`  whole window:           ${JSON.stringify(sAll)}`);
  console.log(
    `  frames over budget: ${overruns}/${streamAll.length}` +
      `  over 4x budget: ${bigOverruns}`,
  );
  console.log(`  worst streaming frame: ${(sAll?.worst ?? 0).toFixed(1)} ms`);

  // Attribution. Which streamer the time went into, summed over the window and on
  // the single worst frame — the difference between knowing and guessing.
  const layers = ['terrain', 'scatter', 'landmarks', 'waterfalls'];
  const totals = {};
  const peaks = {};
  for (const l of layers) {
    totals[l] = +rec.stream.reduce((a, s) => a + (s.cost?.[l] ?? 0), 0).toFixed(0);
    peaks[l] = +rec.stream.reduce((m, s) => Math.max(m, s.cost?.[l] ?? 0), 0).toFixed(1);
  }
  console.log(`  total CPU by layer:    ${JSON.stringify(totals)}`);
  console.log(`  worst single frame by layer: ${JSON.stringify(peaks)}`);
  const worstStream = rec.stream.reduce((a, b) => (b.ms > (a?.ms ?? 0) ? b : a), null);
  if (worstStream) {
    console.log(
      `  the ${worstStream.ms.toFixed(0)} ms frame: ${JSON.stringify(worstStream.cost)} (queued ${worstStream.queued})`,
    );
  }

  // --- Secondary, and unreliable under software GL --------------------------
  console.log('\nframe time, ms (dominated by the rasteriser; compare runs, not absolutes)');
  console.log(`  lobby baseline:  ${JSON.stringify(base)}`);
  console.log(`  transition +6s:  ${JSON.stringify(dur)}`);
  console.log(`  settled after:   ${JSON.stringify(set)}`);

  // The single worst frame, and what the world was doing around it.
  const worstFrame = during.reduce((a, b) => (b.ms > (a?.ms ?? 0) ? b : a), null);
  if (worstFrame) {
    const near = rec.samples.reduce(
      (a, b) => (Math.abs(b.at - worstFrame.at) < Math.abs((a?.at ?? 1e9) - worstFrame.at) ? b : a),
      null,
    );
    console.log(
      `\nworst frame: ${worstFrame.ms.toFixed(0)} ms at +${(worstFrame.at - switchAt).toFixed(0)} ms after the request`,
    );
    console.log(`  world then: ${JSON.stringify(near)}`);
  }

  // How long the backlog takes to drain, and how far resolution fell while it did.
  const afterLive = rec.samples.filter((s) => s.at >= arrivedAt);
  const drained = afterLive.find((s) => s.queued === 0);
  const minRes = afterLive.reduce((m, s) => (s.res !== null && s.res < m ? s.res : m), 1);
  const endRes = afterLive.length ? afterLive[afterLive.length - 1].res : null;
  const peakQueued = afterLive.reduce((m, s) => Math.max(m, s.queued ?? 0), 0);
  console.log(`\nstreaming backlog peak: ${peakQueued} items`);
  console.log(
    `backlog drained: ${drained ? `${(drained.at - arrivedAt).toFixed(0)} ms after the world opened` : `NOT within ${WINDOW_S}s`}`,
  );
  console.log(`resolution scale: fell to ${minRes}, ended at ${endRes}`);
  console.log('\nbacklog over time (every 4th sample):');
  for (const s of afterLive.filter((_, i) => i % 4 === 0)) {
    console.log(
      `  +${String((s.at - arrivedAt).toFixed(0)).padStart(6)} ms  chunks=${String(s.chunks).padStart(3)} queued=${String(s.queued).padStart(3)} res=${s.res} ${JSON.stringify(s.backlog)}`,
    );
  }

  console.log(`\nerrors: ${errors.length}`);
  for (const e of errors.slice(0, 6)) console.log(' ', e);

  // Judgements, all on the streaming metric and the backlog.
  //
  // Frame time is deliberately not judged. Under a software rasteriser the settled
  // world already runs at about a second a frame, so a threshold on end-to-end
  // frame time would either fail always or pass always and would say nothing about
  // whether streaming behaves. The gates below are on CPU actually spent building,
  // which is the thing the budget exists to bound.
  //
  // Some overrun is legitimate and cannot be designed away: a streamer that has
  // started a chunk must finish it, so the frame that begins a build at 4.9 ms
  // pays for the whole of it. What must not happen is *many* streamers each doing
  // that on the same frame, for seconds on end.
  const streamP99 = sBusy?.p99 ?? 0;
  const streamWorst = sAll?.worst ?? 0;
  const withinBudget = streamP99 < BUDGET * 3;
  const noRunaway = streamWorst < BUDGET * 10;
  const overrunRate = streamBusy.length ? overruns / streamBusy.length : 0;
  const mostlyInBudget = overrunRate < 0.5;
  const settles = !!drained;
  const holdsResolution = minRes >= 0.75;

  console.log('\n=== VERDICT ===');
  console.log(`streaming p99 under ${BUDGET * 3} ms:      ${withinBudget ? 'ok' : 'FAIL'} (${streamP99} ms)`);
  console.log(`no streaming frame over ${BUDGET * 10} ms:  ${noRunaway ? 'ok' : 'FAIL'} (${streamWorst.toFixed(1)} ms)`);
  console.log(
    `under half of busy frames overrun:  ${mostlyInBudget ? 'ok' : 'FAIL'} (${(overrunRate * 100).toFixed(0)}%)`,
  );
  console.log(`backlog drains inside the window:   ${settles ? 'ok' : 'FAIL'}`);
  console.log(`resolution holds at 0.75 or better: ${holdsResolution ? 'ok' : 'FAIL'} (${minRes})`);

  const pass =
    withinBudget && noRunaway && mostlyInBudget && settles && holdsResolution && errors.length === 0;
  console.log('\nRESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
