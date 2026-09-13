// Verifies the gathering and crafting loop against the live deployment.
//
// Asserts on behaviour end to end: something is actually lying on the ground, E takes
// it, the bag counts it, the panel draws it with a real picture, a recipe becomes
// available only once its materials are held, crafting consumes them and yields the
// tool, a dead tree refuses to fall without an axe and drops logs with one, and a
// workbench is findable and changes what can be made.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'https://arena-nova.odi44972.workers.dev';
const room = `craft-${Math.random().toString(36).slice(2, 9)}`;
const errors = [];

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});

try {
  console.log('=== CRAFTING PROBE ===');
  console.log(`room: ${room}`);

  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  page.on('pageerror', (e) => {
    if (/Pointer Lock/i.test(e.message)) return;
    errors.push(`pageerror: ${e.message}`);
    console.log(`  ! pageerror: ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/AudioContext|audio device|Pointer Lock/i.test(m.text())) {
      errors.push(m.text());
      console.log(`  ! ${m.text()}`);
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem('arena.name', 'Forager');
    localStorage.setItem('arena.skin', 'captain');
    // A clean bag and a clean set of gathered cells, so a rerun starts from nothing.
    localStorage.removeItem('arena.inventory');
    localStorage.removeItem('arena.vitals');
    localStorage.removeItem('arena.gathered');
  });
  await page.goto(`${url}/?room=${room}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  await page.waitForFunction(
    () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene?.gather,
    null,
    { timeout: 300000 },
  );

  await page.evaluate(() => {
    const w = window;
    w.probe = {
      /** Puts the player somewhere and settles a frame. */
      go(x, z, yaw = 0) {
        const sc = w.arena.scene;
        sc.player.spawn(x, z, yaw);
        sc.player.pitch = 0;
        sc.player.update(0.016);
        sc.render(1, 0.016);
      },
      /** Everything currently built, by kind. */
      spawned() {
        const g = w.arena.scene.gather;
        const out = {};
        for (const c of g.group.children) {
          if (!c.isInstancedMesh) continue;
          out[c.name.replace('Gather:', '')] = c.count;
        }
        return { total: g.count(), byKind: out, children: g.group.children.length };
      },
      /**
       * Walks to the nearest thing of a kind and stands facing it, the way a player
       * would, then reports what the prompt offers.
       */
      approach(kind) {
        const sc = w.arena.scene;
        const g = sc.gather;
        // Reach into the live lists through the instanced meshes' own transforms.
        const mesh = g.group.children.find((c) => c.name === `Gather:${kind}`);
        if (!mesh || mesh.count === 0) return null;
        const m = mesh.matrixWorld.clone();
        mesh.getMatrixAt(0, m);
        const x = m.elements[12];
        const z = m.elements[14];
        // Two metres short of it, looking at it. Yaw 0 faces -Z and forward for yaw t
        // is (-sin t, 0, -cos t).
        const px = x + 1.6;
        const pz = z + 1.6;
        const yaw = Math.atan2(-(x - px), -(z - pz));
        this.go(px, pz, yaw);
        sc.render(1, 0.016);
        return { x, z, prompt: document.getElementById('interactHint')?.textContent ?? '' };
      },
      bag() {
        const inv = w.arena.inventory();
        const out = {};
        for (const e of inv.entries()) out[e.id] = e.count;
        return out;
      },
      vitals() {
        const v = w.arena.inventory().state;
        return {
          health: +v.health.toFixed(4),
          water: +v.water.toFixed(4),
          food: +v.food.toFixed(4),
        };
      },
    };
  });

  const spawned = await page.evaluate(() => {
    window.probe.go(420, 420);
    return window.probe.spawned();
  });
  console.log(`spawned nearby: ${JSON.stringify(spawned)}`);

  // ---- Picking something up -------------------------------------------------
  const pickup = await page.evaluate(async () => {
    const sc = window.arena.scene;
    const before = window.probe.bag();
    const near = window.probe.approach('stick');
    if (!near) return { found: false };
    // Press E the way a player does, through the real listener.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
    sc.render(1, 0.016);
    return { found: true, prompt: near.prompt, before, after: window.probe.bag() };
  });
  console.log(`pickup: ${JSON.stringify(pickup)}`);

  // ---- Enough for a spear ---------------------------------------------------
  // Gathered rather than granted: the loop under test is "walk up to things and take
  // them", so the probe keeps doing that until it has the makings of a spear.
  const gathered = await page.evaluate(async () => {
    const sc = window.arena.scene;
    const want = { stick: 2, stone: 1, fibre: 1 };
    let steps = 0;
    for (let i = 0; i < 400 && steps < 400; i++) {
      steps++;
      const bag = window.probe.bag();
      const missing = Object.keys(want).find((k) => (bag[k] ?? 0) < want[k]);
      if (!missing) break;
      const near = window.probe.approach(missing);
      if (!near) {
        // Nothing of that kind in range: walk on and let the streamer bring more in.
        window.probe.go(420 + i * 37, 420 - i * 29);
        continue;
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
      sc.render(1, 0.016);
    }
    return { steps, bag: window.probe.bag() };
  });
  console.log(`gathered: ${JSON.stringify(gathered)}`);

  // ---- The panel ------------------------------------------------------------
  await page.keyboard.press('KeyI');
  await page.waitForTimeout(900);
  // Icons are one offscreen batch; give it a moment to land.
  await page
    .waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll('#invGrid img.invIcon')];
        return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
      },
      null,
      { timeout: 60000 },
    )
    .catch(() => {});
  // The figure is a separate, larger render on the same idle queue, so it lands after
  // the icons rather than with them. Waited for, because it is asynchronous by design.
  await page
    .waitForFunction(
      () => {
        const f = document.getElementById('invFace');
        return !!f && !f.hidden && f.complete && f.naturalWidth > 0;
      },
      null,
      { timeout: 90000 },
    )
    .catch(() => {});
  const panel = await page.evaluate(() => {
    const grid = document.getElementById('invGrid');
    const cells = [...(grid?.querySelectorAll('.invCell') ?? [])];
    const recipes = [...document.querySelectorAll('.invRecipe')].map((r) => ({
      id: r.dataset.recipe,
      blocked: r.classList.contains('blocked'),
      disabled: r.disabled,
      hasIcon: (() => {
        const i = r.querySelector('img');
        return !!i && i.complete && i.naturalWidth > 0;
      })(),
    }));
    // Real pixels in the icons, not just <img> elements.
    // Only the filled slots. The grid draws all twenty-four so the room left is visible,
    // and an empty one legitimately has no picture in it.
    const drawn = cells.map((c) => {
      const img = c.querySelector('img.invIcon');
      if (!img) return undefined;
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let opaque = 0;
      let fp = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 24) opaque++;
        fp = (fp * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) % 1e9;
      }
      return { coverage: +(opaque / Math.max(1, cv.width * cv.height)).toFixed(3), fp };
    });
    return {
      open: document.getElementById('inventory')?.classList.contains('on') ?? false,
      cells: cells.length,
      drawn,
      recipes,
      face: (() => {
        const f = document.getElementById('invFace');
        if (!f || f.hidden || !f.complete || f.naturalWidth === 0) return false;
        // Portrait aspect, which is what distinguishes the full figure from the square
        // head crop this replaced. A square here would mean the old picture came back.
        return f.naturalHeight > f.naturalWidth * 1.2;
      })(),
      faceSize: (() => {
        const f = document.getElementById('invFace');
        return f ? `${f.naturalWidth}x${f.naturalHeight}` : '';
      })(),
      bars: ['barHealth', 'barWater', 'barFood'].map(
        (id) => document.getElementById(id)?.style.width ?? '',
      ),
    };
  });
  console.log(`panel: ${JSON.stringify({ ...panel, drawn: panel.drawn.map((d) => d?.coverage) })}`);
  await page.screenshot({ path: join(here, 'craft_panel.png') });

  // ---- Crafting a spear ----------------------------------------------------
  const crafted = await page.evaluate(async () => {
    const before = window.probe.bag();
    const row = document.querySelector('.invRecipe[data-recipe="spear"]');
    if (!row) return { found: false };
    const wasBlocked = row.classList.contains('blocked');
    row.click();
    // The bar sweeps for the recipe's own seconds; the panel finishes it from its
    // per-frame pass, so this waits on the model rather than on a timer.
    const ok = await new Promise((resolve) => {
      const started = performance.now();
      const spin = () => {
        if ((window.probe.bag().spear ?? 0) > 0) return resolve(true);
        if (performance.now() - started > 12000) return resolve(false);
        requestAnimationFrame(spin);
      };
      spin();
    });
    return { found: true, wasBlocked, ok, before, after: window.probe.bag() };
  });
  console.log(`craft spear: ${JSON.stringify(crafted)}`);
  await page.keyboard.press('KeyI');
  await page.waitForTimeout(300);

  // ---- A dead tree needs an axe -------------------------------------------
  const felling = await page.evaluate(async () => {
    const sc = window.arena.scene;
    const near = window.probe.approach('snag');
    if (!near) return { found: false };
    const promptNoAxe = document.getElementById('interactHint')?.textContent ?? '';
    // Counted at the tree itself rather than over the whole field. Approaching one
    // moves the player, which crosses cell boundaries and legitimately changes how
    // many snags are in range — an earlier version of this compared totals and read
    // the streamer's work as if the axe had felled five trees.
    const snagAt = (x, z) => {
      const mesh = window.arena.scene.gather.group.children.find((c) => c.name === 'Gather:snag');
      if (!mesh) return false;
      const m = mesh.matrixWorld.clone();
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        if (Math.hypot(m.elements[12] - x, m.elements[14] - z) < 0.5) return true;
      }
      return false;
    };
    const stillThereNoAxe = (() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
      sc.render(1, 0.016);
      return snagAt(near.x, near.z);
    })();

    // Now with an axe in hand. This check is about the axe being the gate; the
    // crafting path was proven separately above.
    window.arena.inventory().add('axe', 1);
    const again = window.probe.approach('snag');
    const promptWithAxe = document.getElementById('interactHint')?.textContent ?? '';
    const logsBefore = window.probe.spawned().byKind.log ?? 0;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
    sc.render(1, 0.016);
    return {
      found: true,
      again: !!again,
      promptNoAxe,
      promptWithAxe,
      stillThereNoAxe,
      goneWithAxe: again ? !snagAt(again.x, again.z) : false,
      logsBefore,
      logsAfter: window.probe.spawned().byKind.log ?? 0,
    };
  });
  console.log(`felling: ${JSON.stringify(felling)}`);

  // ---- A workbench, and what it unlocks -----------------------------------
  const bench = await page.evaluate(async () => {
    const sc = window.arena.scene;
    const g = sc.gather;
    const awayFrom = g.atBench(sc.player.feetPosition);
    const near = window.probe.approach('bench');
    if (!near) return { found: false, awayFrom };
    const at = g.atBench(sc.player.feetPosition);
    const prompt = document.getElementById('interactHint')?.textContent ?? '';

    // Exactly the materials a pickaxe wants, so the only thing that can still block it
    // is the bench. Testing the gate needs the other reason removed — a recipe short of
    // stone is blocked at a bench too, and reads the same in the DOM.
    const inv = window.arena.inventory();
    inv.add('stick', 2);
    inv.add('stone', 3);
    inv.add('fibre', 2);

    // Using it opens the panel.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 500));
    const opened = document.getElementById('inventory')?.classList.contains('on') ?? false;
    const pickAt = document
      .querySelector('.invRecipe[data-recipe="pickaxe"]')
      ?.classList.contains('blocked');
    const hint = document.getElementById('invHint')?.textContent ?? '';

    // Now walk away with the same materials and watch the same recipe close again.
    //
    // Waited for rather than slept through. The panel reconciles its rows on the HUD
    // pass, so how long that takes is a property of the frame rate, not of the feature —
    // a fixed pause passed on a fast run and failed on a slow one, which is a flaky
    // probe rather than a flaky game. It still fails if the row never closes.
    window.probe.go(near.x + 300, near.z + 300);
    await new Promise((resolve) => {
      const started = performance.now();
      const spin = () => {
        const row = document.querySelector('.invRecipe[data-recipe="pickaxe"]');
        if (row?.classList.contains('blocked')) return resolve();
        if (performance.now() - started > 5000) return resolve();
        requestAnimationFrame(spin);
      };
      spin();
    });
    const awayNow = g.atBench(sc.player.feetPosition);
    const pickAway = document
      .querySelector('.invRecipe[data-recipe="pickaxe"]')
      ?.classList.contains('blocked');
    // Which of the two is stale, if either: the panel's own idea of being at a bench,
    // or the rows it drew from it.
    const hintAway = document.getElementById('invHint')?.textContent ?? '';
    const stillOpen = document.getElementById('inventory')?.classList.contains('on') ?? false;
    return {
      found: true,
      awayFrom,
      at,
      prompt,
      opened,
      pickAt,
      awayNow,
      pickAway,
      hint,
      hintAway,
      stillOpen,
    };
  });
  console.log(`bench: ${JSON.stringify(bench)}`);
  await page.screenshot({ path: join(here, 'craft_bench.png') });

  // ---- A tree goes over rather than vanishing ------------------------------
  const fall = await page.evaluate(async () => {
    const sc = window.arena.scene;
    const g = sc.gather;
    const near = window.probe.approach('snag');
    if (!near) return { found: false };
    window.arena.inventory().add('axe', 1);
    window.probe.approach('snag');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
    // The key is only read inside the scene's own frame pass, so the press has to be
    // followed by a frame. Without this the tree was never actually cut and the probe
    // reported no fall — which looked like the feature was missing.
    sc.render(1, 0.016);

    // A real Mesh appears among the instanced ones for the length of the fall, and its
    // roll angle has to grow. Sampled over a few advances rather than trusted to be
    // there: a tree that snapped flat in one frame would satisfy any check that only
    // looked at the start and the end.
    const trunk = () => g.group.children.find((c) => c.isMesh && !c.isInstancedMesh) ?? null;
    const angles = [];
    for (let i = 0; i < 12; i++) {
      g.update(sc.player.feetPosition, 0.12);
      const t = trunk();
      angles.push(t ? +t.rotation.z.toFixed(3) : null);
      if (!t) break;
    }
    // Advance well past the end so it lands and drops its timber.
    for (let i = 0; i < 12; i++) g.update(sc.player.feetPosition, 0.2);
    return {
      found: true,
      angles,
      rose: angles.filter((a) => a !== null).length >= 3,
      cleared: trunk() === null,
      logs: window.probe.spawned().byKind.log ?? 0,
    };
  });
  console.log(`fall: ${JSON.stringify(fall)}`);

  // ---- Trunks and benches are solid, twigs are not ------------------------
  const solids = await page.evaluate(() => {
    const sc = window.arena.scene;
    const g = sc.gather;
    const probeAt = (kind) => {
      const mesh = g.group.children.find((c) => c.name === `Gather:${kind}`);
      if (!mesh || mesh.count === 0) return null;
      const m = mesh.matrixWorld.clone();
      mesh.getMatrixAt(0, m);
      const x = m.elements[12];
      const y = m.elements[13];
      const z = m.elements[14];
      // Slightly off the axis, which is where a body walking into something actually
      // is. Dead centre is a separate case and the world handles it, but testing only
      // there would say nothing about the ordinary one.
      const p = { x: x + 0.15, y: y + 0.2, z: z + 0.1 };
      g.collide(p, 0.4);
      return +Math.hypot(p.x - (x + 0.15), p.z - (z + 0.1)).toFixed(2);
    };
    return { snag: probeAt('snag'), bench: probeAt('bench'), stick: probeAt('stick') };
  });
  console.log(`solid: ${JSON.stringify(solids)}`);

  // ---- Putting down a bench you made --------------------------------------
  const placed = await page.evaluate(async () => {
    const sc = window.arena.scene;
    const g = sc.gather;
    // Somewhere with no generated bench nearby, so the test is about the placement.
    window.probe.go(-2400, 2400);
    g.update(sc.player.feetPosition, 0.016);
    const before = g.atBench(sc.player.feetPosition);
    window.arena.inventory().add('workbench', 1);
    // Through the panel, the way a player does it.
    if (!document.getElementById('inventory')?.classList.contains('on')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyI', bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
    }
    const cell = [...document.querySelectorAll('.invCell.placeable')][0] ?? null;
    if (!cell) return { found: false, before };
    cell.click();
    await new Promise((r) => setTimeout(r, 400));
    sc.render(1, 0.016);
    return {
      found: true,
      before,
      after: g.atBench(sc.player.feetPosition),
      held: window.probe.bag().workbench ?? 0,
      closed: !(document.getElementById('inventory')?.classList.contains('on') ?? false),
    };
  });
  console.log(`placed bench: ${JSON.stringify(placed)}`);

  // ---- Meters move, and cost stays flat -----------------------------------
  const v0 = await page.evaluate(() => window.probe.vitals());
  await page.waitForTimeout(3500);
  const v1 = await page.evaluate(() => window.probe.vitals());
  const cost = await page.evaluate(() => {
    // Walk a long way, which crosses many cell boundaries and rebuilds repeatedly.
    for (let i = 0; i < 40; i++) window.probe.go(1000 + i * 60, -1000 - i * 60);
    const sc = window.arena.scene;
    sc.render(1, 0.016);
    return {
      children: sc.gather.group.children.length,
      total: sc.gather.count(),
      draws: window.arena.engine.renderer.info.render.calls,
    };
  });
  console.log(`vitals ${JSON.stringify(v0)} -> ${JSON.stringify(v1)}; cost ${JSON.stringify(cost)}`);

  // ---- Report --------------------------------------------------------------
  const somethingSpawned = spawned.total > 4 && (spawned.byKind.stick ?? 0) > 0;
  const tookIt =
    pickup.found === true &&
    /E/.test(pickup.prompt) &&
    (pickup.after.stick ?? 0) > (pickup.before.stick ?? 0);
  const gotMaterials =
    (gathered.bag.stick ?? 0) >= 2 && (gathered.bag.stone ?? 0) >= 1 && (gathered.bag.fibre ?? 0) >= 1;
  const panelOpens = panel.open === true && panel.cells > 0;
  const filled = panel.drawn.filter((d) => d !== undefined && d !== null);
  const iconsDrawn =
    filled.length > 0 &&
    filled.every((d) => d.coverage > 0.02 && d.coverage < 0.99) &&
    new Set(filled.map((d) => d.fp)).size === filled.length &&
    // And the grid really does show every slot, full or not.
    panel.cells === 24;
  const faceAndBars =
    panel.face === true && panel.bars.length === 3 && panel.bars.every((b) => /%$/.test(b));
  const benchGated = panel.recipes.some((r) => r.id === 'workbench' && r.blocked);
  const craftedSpear =
    crafted.found === true &&
    crafted.wasBlocked === false &&
    crafted.ok === true &&
    (crafted.after.spear ?? 0) === 1 &&
    (crafted.after.stick ?? 0) === (crafted.before.stick ?? 0) - 2 &&
    (crafted.after.stone ?? 0) === (crafted.before.stone ?? 0) - 1;
  const axeGates =
    felling.found === true &&
    felling.stillThereNoAxe === true &&
    /топор|axe/i.test(felling.promptNoAxe) &&
    felling.goneWithAxe === true;
  // Logs are no longer checked here: they arrive when the trunk lands, which is what
  // the fall test below drives and asserts on.
  // The bench is the gate: with the materials in hand the recipe opens at the bench and
  // closes again when you walk away from it.
  const benchWorks =
    bench.found === true &&
    bench.awayFrom === false &&
    bench.at === true &&
    bench.opened === true &&
    bench.pickAt === false &&
    bench.awayNow === false &&
    bench.pickAway === true;
  const metersMove = v1.water < v0.water && v1.food < v0.food;
  // Seven instanced meshes and nothing else, however far the player walks.
  const costFlat = cost.children === 7 && cost.total > 0;

  // Went over gradually, then cleared itself and left timber.
  const fallsOver =
    fall.found === true &&
    fall.rose === true &&
    fall.angles.filter((a) => a !== null).length >= 3 &&
    (() => {
      const seen = fall.angles.filter((a) => a !== null);
      return seen[seen.length - 1] > seen[0] && seen[0] < 0.6;
    })() &&
    fall.cleared === true &&
    fall.logs > 0;
  // A trunk and a bench push; a twig on the ground does not.
  const solidWhereItShould =
    solids.snag !== null && solids.snag > 0.1 && solids.bench !== null && solids.bench > 0.1 && solids.stick === 0;
  const benchPlaced =
    placed.found === true &&
    placed.before === false &&
    placed.after === true &&
    placed.held === 0 &&
    placed.closed === true;

  const line = (label, ok, extra = '') =>
    console.log(`${label.padEnd(38)}${ok ? 'ok' : 'FAIL'}${extra ? ` ${extra}` : ''}`);
  line('things lying on the ground:', somethingSpawned, JSON.stringify(spawned.byKind));
  line('E picks one up:', tookIt, JSON.stringify(pickup.prompt));
  line('materials can be gathered:', gotMaterials, JSON.stringify(gathered.bag));
  line('I opens the bag:', panelOpens, `${panel.cells} cells`);
  line(
    'icons drawn and distinct:',
    iconsDrawn,
    `${filled.length} filled of ${panel.cells} slots ${JSON.stringify(filled.map((d) => d.coverage))}`,
  );
  line('full figure and three meters:', faceAndBars, `${panel.faceSize} ${JSON.stringify(panel.bars)}`);
  line('bench recipes gated:', benchGated);
  line('spear crafted, inputs spent:', craftedSpear, JSON.stringify(crafted.after));
  line(
    'axe gates felling, drops logs:',
    axeGates,
    `stood without axe=${felling.stillThereNoAxe}, fell with axe=${felling.goneWithAxe}, logs ${felling.logsBefore}->${felling.logsAfter}`,
  );
  line(
    'bench gates and ungates:',
    benchWorks,
    `at=${bench.at} pickAtBench=${bench.pickAt} pickAway=${bench.pickAway}`,
  );
  line('tree falls, then leaves logs:', fallsOver, `angles ${JSON.stringify(fall.angles)}`);
  line('trunks solid, twigs not:', solidWhereItShould, JSON.stringify(solids));
  line('own bench placed and works:', benchPlaced, `atBench ${placed.before}->${placed.after}`);
  line('meters drain:', metersMove, `${v0.water}->${v1.water}`);
  line('cost flat while walking:', costFlat, `${cost.children} children, ${cost.total} things`);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log(' ', e);

  const pass =
    somethingSpawned &&
    tookIt &&
    gotMaterials &&
    panelOpens &&
    iconsDrawn &&
    faceAndBars &&
    benchGated &&
    craftedSpear &&
    axeGates &&
    benchWorks &&
    fallsOver &&
    solidWhereItShould &&
    benchPlaced &&
    metersMove &&
    costFlat &&
    errors.length === 0;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
