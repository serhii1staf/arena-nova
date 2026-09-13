// Verifies the see-through squad highlight against the live server.
//
// Two clients join, form a squad, and are then placed deliberately: once in plain
// sight of each other, once with a hill between them. The assertions are about
// behaviour rather than presence — a highlight that is always on is exactly as wrong
// as one that never comes on, and only a two-position test can tell them apart.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'https://arena-nova.odi44972.workers.dev';
const room = `sight-${Math.random().toString(36).slice(2, 9)}`;
const errors = [];

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});

async function spawn(label, name, skin, token) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  // Printed as they arrive, not only in the final report. A probe that dies on a
  // timeout never reaches its report, and the reason was sitting in the console the
  // whole time.
  page.on('pageerror', (e) => {
    if (/Pointer Lock/i.test(e.message)) return;
    errors.push(`${label} pageerror: ${e.message}`);
    console.log(`  ! ${label} pageerror: ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/AudioContext|audio device|Pointer Lock/i.test(m.text())) {
      errors.push(`${label} ${m.text()}`);
      console.log(`  ! ${label} ${m.text()}`);
    }
  });
  await page.addInitScript(
    ([n, s, o]) => {
      localStorage.setItem('arena.name', n);
      localStorage.setItem('arena.skin', s);
      localStorage.setItem('arena.owner', o);
    },
    [name, skin, token],
  );
  await page.goto(`${url}/?room=${room}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  await page.waitForFunction(
    () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene?.crowd,
    null,
    { timeout: 300000 },
  );
  return page;
}

try {
  console.log('=== SQUAD SIGHT PROBE ===');
  console.log(`room: ${room}`);

  const a = await spawn('A', 'Scout', 'captain', 'a'.repeat(8) + '9182736450abcdef9182736450abcdef');
  const b = await spawn('B', 'Ranger', 'mako', 'b'.repeat(8) + '0fedcba9876543210fedcba98765432');

  // Both online and aware of each other.
  const ready = async (label, page) => {
    // Both pages have to be animating to exchange snapshots, and a browser stops
    // animating a page that is not in front — so each is brought forward while it
    // waits, the same way the networking probe does it.
    await page.bringToFront();
    const ok = await page
      .waitForFunction(
        () => {
          const n = window.arena.scene?.net;
          return !!n && n.isOnline && n.remotePlayers.size >= 1;
        },
        null,
        // Polled on a timer, not on animation frames.
        //
        // The default is one check per animation frame, and a page that is not in front
        // barely gets any — so this timed out on the page waiting its turn while the
        // condition it was waiting for had *already* come true. The diagnostic printed
        // right afterwards said so in as many words: online, one remote, everything the
        // wait wanted. It was the asking that had stalled, not the thing being asked
        // about. A timer keeps ticking in a background page; animation frames do not.
        { timeout: 120000, polling: 200 },
      )
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      const s = await page.evaluate(() => {
        const n = window.arena.scene?.net;
        return {
          scene: window.arena.engine.scenes.currentName,
          online: n?.isOnline ?? null,
          id: n?.localId ?? null,
          remotes: n ? n.remotePlayers.size : null,
        };
      });
      console.log(`  ${label} never saw anyone: ${JSON.stringify(s)}`);
    }
    return ok;
  };
  const seenA = await ready('A', a);
  const seenB = await ready('B', b);
  if (!seenA || !seenB) throw new Error('the two clients never met');

  const idOf = (page) => page.evaluate(() => window.arena.scene.net.localId);
  const idA = await idOf(a);
  const idB = await idOf(b);

  // Form the squad the way the game does: A invites, B accepts.
  await a.evaluate((id) => window.arena.scene.net.sendTo(id, 'squadInvite'), idB);
  await b.waitForTimeout(1500);
  await b.evaluate((id) => window.arena.scene.net.sendTo(id, 'squadAccept'), idA);
  await a.waitForTimeout(1500);
  // And B records A as well, so both sides have a squad.
  await b.evaluate((id) => {
    window.arena.scene.net.sendTo(id, 'squadInvite');
  }, idA);
  await a.waitForTimeout(1200);
  await a.evaluate((id) => window.arena.scene.net.sendTo(id, 'squadAccept'), idB);
  await b.waitForTimeout(1500);

  const squadSize = await a.evaluate(() => window.arena.squadIds?.().size ?? -1);
  console.log(`squad on A: ${squadSize}`);

  /**
   * Reads the highlight state of the one remote avatar on this page: whether any of
   * its meshes are currently drawing without depth testing.
   */
  const state = (page) =>
    page.evaluate(() => {
      const sc = window.arena.scene;
      let meshes = 0;
      let through = 0;
      let hasMap = 0;
      sc.crowd.group.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          meshes++;
          if (m.depthTest === false) through++;
          if (m.map) hasMap++;
        }
      });
      const tags = [...document.querySelectorAll('.squadTag')].map((el) => {
        const img = el.querySelector('img.squadTagFace');
        return {
          name: el.querySelector('.squadTagName')?.textContent ?? '',
          far: el.querySelector('.squadTagFar')?.textContent ?? '',
          // Drawn, not merely present: a portrait that failed to render leaves an
          // <img> with no natural size, which every count-based check would pass.
          face: !!img && !img.hidden && img.complete && img.naturalWidth > 0,
          transform: el.style.transform,
          opacity: el.style.opacity,
        };
      });
      return { meshes, through, hasMap, tags };
    });

  /** Puts a page's player at a spot and points it at a target, then settles frames. */
  const place = async (page, x, z, lookX, lookZ) => {
    await page.evaluate(
      ([px, pz, tx, tz]) => {
        const sc = window.arena.scene;
        // Yaw 0 faces -Z, and forward for yaw t is (-sin t, 0, -cos t).
        const yaw = Math.atan2(-(tx - px), -(tz - pz));
        sc.player.spawn(px, pz, yaw);
        sc.player.pitch = 0;
      },
      [x, z, lookX, lookZ],
    );
    // Several real frames, because the sight test is staggered across four of them.
    for (let i = 0; i < 14; i++) await page.waitForTimeout(60);
  };

  /**
   * Waits until `page` has actually received `id` at a spot, then settles.
   *
   * The fixed settle above is not enough on its own and one run in several proved it: the
   * observer reported no highlight and no tag at 260 m, because the teammate's position
   * had not arrived over the relay yet. Nothing was wrong with the game — the probe had
   * measured before the thing it was measuring existed. Waiting on the condition instead
   * of a duration is the only version of this that cannot flake.
   */
  const awaitSeen = async (page, id, x, z) => {
    await page.waitForFunction(
      ([who, tx, tz]) => {
        const p = window.arena.scene.net.remotePlayers.get(who);
        return !!p && Math.hypot(p.x - tx, p.z - tz) < 4;
      },
      [id, x, z],
      { timeout: 30000, polling: 100 },
    );
    // Then real frames, not milliseconds — and that distinction is the whole bug.
    //
    // The sight test is staggered every fourth *frame*, so the wait for it has to be
    // counted in frames too. Counted in wall time it was a guess about the frame rate,
    // and in a headless browser that guess is wrong: half a second is thirty frames on
    // this machine and can be four in CI, so the highlight had sometimes not been asked
    // about even once by the time the probe looked. Waiting on frames makes the settle
    // correct at any frame rate.
    await page.evaluate(
      (n) =>
        new Promise((done) => {
          let left = n;
          const tick = () => (--left <= 0 ? done(true) : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
      16,
    );
  };

  // ---- Case 1: standing together, in plain sight ---------------------------
  // Close enough that the sight line is short and clear. The highlight must be off.
  await a.bringToFront();
  await place(b, 300, 300, 306, 300);
  await place(a, 306, 300, 300, 300);
  await awaitSeen(a, idB, 300, 300);
  const near = await state(a);
  console.log(`in sight: ${JSON.stringify({ meshes: near.meshes, through: near.through, tags: near.tags })}`);

  // ---- Case 2: put terrain between them ------------------------------------
  // The pair of positions is *chosen by asking the same predicate the game uses*,
  // rather than hard-coded or guessed from a ridge heuristic. The map is generated,
  // so the only reliable way to set up an occluded sight line is to search for one.
  const pair = await a.evaluate(() => {
    const w = window.arena.scene.world;
    // Reproduces the game's own sight test: terrain in the way, sampled along the
    // line between two chest-height points.
    const sc = window.arena.scene;
    const ground = (x, z) => w.floorHeightAt(x, z);
    // The game's own predicate, not a copy of it. An earlier version of this probe
    // reimplemented the test with `floorHeightAt`, which also counts the tops of
    // trees and boulders — so it picked pairs the game considered in plain sight, and
    // the run passed or failed depending on where the trees fell.
    const blocked = (x, y, z) => sc.sightBlocked(x, y, z);
    // The game's own routine, sampling policy and chest height included. This used to be
    // a hand-rolled copy of it, and the copy stepped along the line differently — so a
    // ridge the search called cover was sometimes stepped straight over by the game, and
    // the run's verdict came down to where the samples happened to fall.
    const occluded = (ax, az, bx, bz) => {
      const dist = Math.hypot(bx - ax, bz - az);
      if (dist < 1) return false;
      // Asked from three eyes, not one. The real eye is the *camera*, which in third
      // person sits several metres behind the player — so a pair only just occluded from
      // the player's own position is a coin toss once the camera pulls back. Requiring
      // cover from the whole span the camera can occupy makes the pair robust rather than
      // marginal.
      for (const back of [0, 2, 4]) {
        const ex = ax - ((bx - ax) / dist) * back;
        const ez = az - ((bz - az) / dist) * back;
        const eye = { x: ex, y: ground(ex, ez) + 1.7, z: ez };
        if (!sc.crowd.hiddenBetween(eye, bx, ground(bx, bz), bz, blocked)) return false;
      }
      return true;
    };
    // Sweep a grid of origins and directions for a pair a few hundred metres apart
    // whose line is genuinely interrupted, and whose two ends are both on dry land.
    for (let ox = -900; ox <= 900; ox += 120) {
      for (let oz = -900; oz <= 900; oz += 120) {
        for (const span of [260, 380, 520]) {
          for (const dir of [
            [1, 0],
            [0, 1],
            [0.7, 0.7],
            [0.7, -0.7],
          ]) {
            const bx = ox + dir[0] * span;
            const bz = oz + dir[1] * span;
            if (Math.abs(bx) > 1300 || Math.abs(bz) > 1300) continue;
            if (occluded(ox, oz, bx, bz)) {
              return { ax: ox, az: oz, bx, bz, span: Math.round(Math.hypot(bx - ox, bz - oz)) };
            }
          }
        }
      }
    }
    return null;
  });
  console.log(`occluded pair: ${JSON.stringify(pair)}`);

  let far = null;
  if (pair) {
    await place(b, pair.bx, pair.bz, pair.ax, pair.az);
    await place(a, pair.ax, pair.az, pair.bx, pair.bz);
    await awaitSeen(a, idB, pair.bx, pair.bz);
    // What the game itself concluded, and the exact numbers it concluded it from. Printed
    // because a disagreement between the search and the live verdict is otherwise a guess:
    // the eye is the *camera*, not the player, and the target is the position that arrived
    // over the relay, not the one the search asked about.
    const verdict = await a.evaluate((who) => {
      const sc = window.arena.scene;
      const rp = sc.net.remotePlayers.get(who);
      const eye = sc.camera.getWorldPosition(new (Object.getPrototypeOf(sc.camera.position).constructor)());
      if (!rp) return { seen: false };
      const t = sc.crowd.tracked?.get(who);
      return {
        seen: true,
        eye: [+eye.x.toFixed(1), +eye.y.toFixed(1), +eye.z.toFixed(1)],
        them: [+rp.x.toFixed(1), +rp.y.toFixed(1), +rp.z.toFixed(1)],
        gameSays: sc.crowd.hiddenBetween(eye, rp.x, rp.y, rp.z, sc.sightBlocked),
        hidden: t?.hidden ?? null,
        showing: t?.showing ?? null,
      };
    }, idB);
    console.log(`game's own verdict: ${JSON.stringify(verdict)}`);
    far = await state(a);
    console.log(
      `behind terrain: ${JSON.stringify({ meshes: far.meshes, through: far.through, tags: far.tags })}`,
    );
    await a.screenshot({ path: join(here, 'squad_through.png') });
  }

  // ---- Case 3: out of the squad, no highlight anywhere ---------------------
  await a.evaluate((id) => {
    window.arena.scene.net.sendTo(id, 'squadLeave');
    // Leaving is a local decision too, so drop them from our own set.
    const ids = window.arena.squadIds();
    ids.delete(id);
  }, idB);
  for (let i = 0; i < 14; i++) await a.waitForTimeout(60);
  const left = await state(a);
  console.log(`after leaving: ${JSON.stringify({ through: left.through, tags: left.tags.length })}`);

  // ---- Report --------------------------------------------------------------
  const squadFormed = squadSize >= 1;
  // In sight: nothing draws through, and the tag is still there with a distance.
  const quietWhenSeen = near.meshes > 0 && near.through === 0;
  const taggedWhenSeen = near.tags.length === 1 && /^\d+ m$/.test(near.tags[0].far.trim());
  // The face is the part that carries at range, so it has to actually be an image
  // with pixels in it rather than a broken src.
  const facedWhenHidden = !!far && far.tags.length === 1 && far.tags[0].face === true;
  const namedCorrectly = near.tags.length === 1 && near.tags[0].name === 'Ranger';
  // Hidden: meshes draw through, and they keep their texture — the point is that you
  // recognise the character rather than see a coloured blob.
  const showsWhenHidden = !!far && far.through > 0;
  const keepsSkin = !!far && far.hasMap > 0;
  const taggedWhenHidden = !!far && far.tags.length === 1 && /^\d+ m$/.test(far.tags[0].far.trim());
  // Guarded like every other check that reads a tag. Unguarded, this threw instead of
  // failing, which is the worse outcome by a distance: an exception loses the whole
  // report, including the checks that had already passed and the reason this one did not.
  const distanceGrew =
    taggedWhenHidden &&
    taggedWhenSeen &&
    Number(far.tags[0].far.replace(/\D/g, '')) > Number(near.tags[0].far.replace(/\D/g, '')) + 50;
  const clearedOnLeave = left.through === 0 && left.tags.length === 0;

  const line = (label, ok, extra = '') =>
    console.log(`${label.padEnd(38)}${ok ? 'ok' : 'FAIL'}${extra ? ` ${extra}` : ''}`);
  line('squad formed:', squadFormed, `${squadSize} member(s)`);
  line('no highlight in plain sight:', quietWhenSeen, `${near.through}/${near.meshes} through`);
  line('tag shown with a distance:', taggedWhenSeen, JSON.stringify(near.tags[0]?.far));
  line('tag names the right player:', namedCorrectly, JSON.stringify(near.tags[0]?.name));
  line('shows through a ridge:', showsWhenHidden, far ? `${far.through}/${far.meshes} through` : 'no ridge found');
  line('keeps the character skin:', keepsSkin, far ? `${far.hasMap} textured` : '');
  line('tag follows them out there:', taggedWhenHidden, far ? JSON.stringify(far.tags[0]?.far) : '');
  line('face drawn in the tag:', facedWhenHidden, far ? String(far.tags[0]?.face) : '');
  line('distance grows with range:', distanceGrew);
  line('all cleared on leaving:', clearedOnLeave, `${left.through} through, ${left.tags.length} tags`);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log(' ', e);

  const pass =
    squadFormed &&
    quietWhenSeen &&
    taggedWhenSeen &&
    namedCorrectly &&
    showsWhenHidden &&
    keepsSkin &&
    taggedWhenHidden &&
    facedWhenHidden &&
    distanceGrew &&
    clearedOnLeave &&
    errors.length === 0;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
