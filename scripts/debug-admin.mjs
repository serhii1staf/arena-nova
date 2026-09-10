// Verifies the reserved name and the admin gate against the live server.
//
// Two clients both claim the reserved name in the same room. The first must get it
// and be granted admin; the second must be refused, keep a distinct name, and get
// nothing. Run against the deployment, because the claim is stored in the room's
// durable storage and an in-memory stub would not exercise that at all.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'https://arena-nova.odi44972.workers.dev';
const room = `admin-${Math.random().toString(36).slice(2, 9)}`;
const RESERVED = 'Kairozun';
const errors = [];

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});

/** Distinct install tokens, so "the same install reconnecting" is expressible. */
const TOKEN_A = 'a'.repeat(8) + '1234567890abcdef1234567890abcdef';
const TOKEN_B = 'b'.repeat(8) + 'fedcba0987654321fedcba0987654321';

async function spawn(label, name, skin, owner) {
  const ctx = await browser.newContext({ viewport: { width: 820, height: 540 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  // Pointer Lock is excluded for the same reason it is excluded from the console
  // filter below: this probe drives two pages and switches which one is in front,
  // and a lock request from a page that just lost focus is refused by the browser
  // for want of a user gesture. That is the automation, not the game.
  page.on('pageerror', (e) => {
    if (/Pointer Lock/i.test(e.message)) return;
    errors.push(`${label} pageerror: ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/AudioContext|audio device|Pointer Lock/i.test(m.text())) {
      errors.push(`${label} ${m.text()}`);
    }
  });
  // A different character per client, so the two rows in the list must show two
  // different portraits — one shared picture for everybody would pass a check that
  // only counted images.
  // The owner token is seeded rather than left to the client to mint, because that
  // is the whole point of the reconnect case below: a fresh browser context has
  // fresh storage, so without seeding, "the same install coming back" cannot be
  // told apart from "a stranger arriving".
  await page.addInitScript(
    ([n, s, o]) => {
      localStorage.setItem('arena.name', n);
      localStorage.setItem('arena.skin', s);
      localStorage.setItem('arena.owner', o);
    },
    [name, skin, owner],
  );
  await page.goto(`${url}/?room=${room}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  return page;
}

const state = (page) =>
  page.evaluate(() => {
    const net = window.arena.scene.net;
    return {
      online: net.isOnline,
      id: net.localId,
      admin: net.isAdmin,
      ping: Math.round(net.ping),
      // Each client measures its own round trip and reports it on the input it is
      // already sending; the server clamps it and puts it in the snapshot. So a
      // remote's ping has to be a real number here, not a placeholder.
      remotes: [...net.remotePlayers.values()].map((p) => ({
        name: p.name,
        admin: p.admin,
        ping: Math.round(p.ping),
      })),
      panelAvailable: !!document.getElementById('admin'),
    };
  });

try {
  console.log('=== ADMIN / RESERVED NAME PROBE ===');
  console.log(`room: ${room}`);

  // First claimant.
  const a = await spawn('A', RESERVED, 'captain', TOKEN_A);
  let sa = null;
  for (let i = 0; i < 30; i++) {
    await a.waitForTimeout(1000);
    sa = await state(a);
    if (sa.online && sa.admin) break;
  }

  // Second claimant, same name, same room.
  const b = await spawn('B', RESERVED, 'mako', TOKEN_B);
  let sb = null;
  for (let i = 0; i < 30; i++) {
    await b.waitForTimeout(1000);
    sb = await state(b);
    if (sb.online && sb.id) break;
  }
  // Give the refusal a moment to arrive and be applied.
  await b.waitForTimeout(4000);
  sb = await state(b);
  sa = await state(a);

  // Both round trips are driven by the frame loop, and a browser stops animating a
  // page that is not in front — so each client has to be the visible one while it
  // measures its own latency. Same reason `debug-net.mjs` brings a page forward
  // before sending it keystrokes.
  await b.bringToFront();
  for (let i = 0; i < 25 && sb.ping <= 0; i++) {
    await b.waitForTimeout(1000);
    sb = await state(b);
  }
  await a.bringToFront();
  // Ping has to be a real measurement, not a placeholder.
  for (let i = 0; i < 25 && sa.ping <= 0; i++) {
    await a.waitForTimeout(1000);
    sa = await state(a);
  }
  // The other player's ping takes longer to arrive than our own, and legitimately
  // so: B has to complete a round trip, report the result on its next input, and
  // have the server put that in a snapshot. Zero means "not measured yet", so wait
  // for it rather than reading it once and too early. It is a relayed value, so it
  // keeps arriving in every snapshot whether or not B is still animating.
  for (let i = 0; i < 30 && !(sa.remotes[0]?.ping > 0); i++) {
    await a.waitForTimeout(1000);
    sa = await state(a);
  }

  // The panel must open for A on P and stay shut for B.
  const openFor = async (page) => {
    await page.keyboard.press('KeyP');
    await page.waitForTimeout(700);
    return page.evaluate(() => {
      const el = document.getElementById('admin');
      return {
        open: el?.classList.contains('on') ?? false,
        buttons: el?.querySelectorAll('.adminBtn').length ?? 0,
      };
    });
  };
  const panelA = await openFor(a);
  const panelB = await openFor(b);
  await a.screenshot({ path: join(here, 'admin_panel.png') });

  // The player list on held Tab.
  await a.keyboard.down('Tab');
  await a.waitForTimeout(1200);
  const peek = await a.evaluate(() => {
    const el = document.getElementById('players');
    return {
      peeking: window.arena.engine.input.isPeeking,
      panelClass: el?.className ?? 'MISSING',
      opacity: el ? Number(getComputedStyle(el).opacity).toFixed(2) : null,
    };
  });
  console.log(`  tab held -> ${JSON.stringify(peek)}`);

  // Portraits are rendered off the frame loop, once per character, the first time
  // the panel asks for one — so give them a moment to land while Tab is held. Until
  // then the row shows the lettered chip, which is a legitimate state and would
  // silently pass a check that only looked at the row count.
  const portraitsReady = await a
    .waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll('#players img.portrait')];
        return imgs.length >= 2 && imgs.every((i) => i.complete && i.naturalWidth > 0);
      },
      { timeout: 90000 },
    )
    .then(() => true)
    .catch(() => false);

  const list = await a.evaluate(() => {
    const el = document.getElementById('players');
    const rows = [...(el?.querySelectorAll('.playerRow') ?? [])];
    return {
      // The pause overlay must NOT be up: holding Tab hands the cursor back on
      // purpose, and pausing on that covered the list with the pause menu.
      paused: document.getElementById('pause')?.classList.contains('open') ?? false,
      open: el?.classList.contains('on') ?? false,
      rows: rows.length,
      count: document.getElementById('playersCount')?.textContent ?? '',
      hasAdminTag: !!el?.querySelector('.adminTag'),
      // Every row, self or not: a remote player's latency now comes from the
      // snapshot, so a dash anywhere here is a regression.
      pings: rows.map((r) => ({
        self: r.classList.contains('self'),
        text: r.querySelector('.playerPing')?.textContent ?? '',
        bars: r.querySelector('.bars')?.className ?? '',
      })),
      litBars: !!el?.querySelector('.bars.lit4, .bars.lit3, .bars.lit2, .bars.lit1'),
      chips: el?.querySelectorAll('.chip').length ?? 0,
    };
  });

  // Look at the pixels, not just at the element. A portrait that renders solid
  // black, or all-transparent, satisfies every count and every attribute.
  const portraits = await a.evaluate(() => {
    const out = [];
    for (const img of document.querySelectorAll('#players img.portrait')) {
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
        // Order-sensitive, so two different characters cannot collide by having
        // the same amount of ink in them.
        fingerprint = (fingerprint * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) % 1e9;
      }
      out.push({
        w: c.width,
        h: c.height,
        // Share of the square the figure covers, and how bright it is where it
        // does. An empty render scores 0 coverage; a black one scores 0 brightness.
        coverage: +(opaque / Math.max(1, c.width * c.height)).toFixed(3),
        brightness: opaque ? Math.round(lum / opaque) : 0,
        fingerprint,
      });
    }
    return out;
  });
  await a.screenshot({ path: join(here, 'admin_players.png') });
  await a.keyboard.up('Tab');
  await a.waitForTimeout(600);
  const listClosed = await a.evaluate(
    () => !(document.getElementById('players')?.classList.contains('on') ?? false),
  );

  // ---------------------------------------------------------------------------
  // The owner comes back.
  //
  // This is the case the probe used to be structurally unable to fail: every run
  // takes a brand-new room, so the first claim always met empty storage and always
  // succeeded. The claim is meant to be *permanent*, which only means anything on a
  // later connection — and that is where it was broken. The room recorded the
  // connection id, which is minted per socket, so the owner returned with a new id,
  // failed to match the record, and was refused from their own name for good. The
  // admin panel then had nothing to open.
  //
  // A closes first, so this is a genuine reconnect and not a second live claimant.
  // ---------------------------------------------------------------------------
  await a.context().close();
  await b.context().close();
  const c = await spawn('C', RESERVED, 'captain', TOKEN_A);
  let sc = null;
  for (let i = 0; i < 30; i++) {
    await c.waitForTimeout(1000);
    sc = await state(c);
    if (sc.online && sc.admin) break;
  }
  const panelC = await openFor(c);
  // And a stranger must still be refused after the owner has been recognised once,
  // so the self-healing path cannot be mistaken for "anyone may rebind".
  const d = await spawn('D', RESERVED, 'mako', TOKEN_B);
  let sd = null;
  for (let i = 0; i < 30; i++) {
    await d.waitForTimeout(1000);
    sd = await state(d);
    if (sd.online && sd.id) break;
  }
  await d.waitForTimeout(4000);
  sd = await state(d);

  console.log(`A: ${JSON.stringify(sa)}`);
  console.log(`B: ${JSON.stringify(sb)}`);
  console.log(`C (owner reconnecting): ${JSON.stringify(sc)} panel=${JSON.stringify(panelC)}`);
  console.log(`D (stranger, after):    ${JSON.stringify(sd)}`);
  console.log(`panel A: ${JSON.stringify(panelA)}  panel B: ${JSON.stringify(panelB)}`);
  console.log(`list: ${JSON.stringify(list)} closedOnRelease=${listClosed}`);
  console.log(`portraits: ready=${portraitsReady} ${JSON.stringify(portraits)}`);

  const firstGotAdmin = sa.admin === true;
  const secondRefused = sb.admin === false;
  // The permanent half of the claim: same install, later connection, still admin,
  // and the panel still opens.
  const ownerRecognised = sc?.admin === true && panelC.open && panelC.buttons >= 20;
  const strangerStillRefused = sd?.admin === false;
  // The refused client must not be walking around under the reserved name either.
  const secondRenamed =
    sa.remotes.length > 0 && sa.remotes.every((r) => r.name !== RESERVED);
  const panelGated = panelA.open && panelA.buttons >= 20 && !panelB.open;
  const pingMeasured = sa.ping > 0 && sa.ping < 5000;
  const listWorks =
    list.open && !list.paused && list.rows >= 2 && list.hasAdminTag && list.litBars;
  const listCloses = listClosed;

  // The remote player's own measurement, relayed by the server. Checked in the
  // session state and in the rendered row, because either one could be right while
  // the other shows a placeholder.
  const remotePingReported =
    sa.remotes.length > 0 && sa.remotes.every((r) => r.ping > 0 && r.ping < 5000);
  const remoteRow = list.pings.find((p) => !p.self) ?? null;
  const remotePingShown = !!remoteRow && /^\d+ ms$/.test(remoteRow.text.trim());
  const everyRowHasPing =
    list.pings.length >= 2 && list.pings.every((p) => /^\d+ ms$/.test(p.text.trim()));

  // Two players wearing two different characters: two portraits, neither blank nor
  // black, and no lettered chip left standing in as a fallback.
  const portraitsDrawn =
    portraitsReady &&
    portraits.length >= 2 &&
    list.chips === 0 &&
    portraits.every((p) => p.w >= 32 && p.h >= 32 && p.coverage > 0.08 && p.coverage < 0.99) &&
    portraits.every((p) => p.brightness >= 40);
  const portraitsDiffer = new Set(portraits.map((p) => p.fingerprint)).size >= 2;

  console.log(`first claim gets the name + admin: ${firstGotAdmin ? 'ok' : 'FAIL'}`);
  console.log(`second claim refused:              ${secondRefused ? 'ok' : 'FAIL'}`);
  console.log(
    `owner still admin after reconnect: ${ownerRecognised ? 'ok' : 'FAIL'} (admin=${sc?.admin}, panel=${panelC.open}, ${panelC.buttons} commands)`,
  );
  console.log(`stranger refused after that:       ${strangerStillRefused ? 'ok' : 'FAIL'} (admin=${sd?.admin})`);
  console.log(`second not shown under that name:  ${secondRenamed ? 'ok' : 'FAIL'} (${JSON.stringify(sa.remotes)})`);
  console.log(`panel opens for admin only:        ${panelGated ? 'ok' : 'FAIL'} (${panelA.buttons} commands)`);
  console.log(`ping is a real measurement:        ${pingMeasured ? 'ok' : 'FAIL'} (${sa.ping} ms)`);
  console.log(
    `remote player reports its ping:    ${remotePingReported ? 'ok' : 'FAIL'} (${JSON.stringify(sa.remotes.map((r) => r.ping))})`,
  );
  console.log(
    `remote row shows a number, not —:  ${remotePingShown ? 'ok' : 'FAIL'} ("${remoteRow?.text ?? 'no remote row'}")`,
  );
  console.log(`every row shows a ping:            ${everyRowHasPing ? 'ok' : 'FAIL'}`);
  console.log(
    `portraits drawn, not blank/black:  ${portraitsDrawn ? 'ok' : 'FAIL'} (${portraits.length} imgs, ${list.chips} chips)`,
  );
  console.log(`portraits differ per character:    ${portraitsDiffer ? 'ok' : 'FAIL'}`);
  console.log(`player list on held Tab:           ${listWorks ? 'ok' : 'FAIL'}`);
  console.log(`list closes on release:            ${listCloses ? 'ok' : 'FAIL'}`);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log(' ', e);

  const pass =
    firstGotAdmin &&
    secondRefused &&
    ownerRecognised &&
    strangerStillRefused &&
    secondRenamed &&
    panelGated &&
    pingMeasured &&
    remotePingReported &&
    remotePingShown &&
    everyRowHasPing &&
    portraitsDrawn &&
    portraitsDiffer &&
    listWorks &&
    listCloses &&
    errors.length === 0;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
