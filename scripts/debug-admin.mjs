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

async function spawn(label, name) {
  const ctx = await browser.newContext({ viewport: { width: 820, height: 540 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/AudioContext|audio device|Pointer Lock/i.test(m.text())) {
      errors.push(`${label} ${m.text()}`);
    }
  });
  await page.addInitScript((n) => localStorage.setItem('arena.name', n), name);
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
      remotes: [...net.remotePlayers.values()].map((p) => ({ name: p.name, admin: p.admin })),
      panelAvailable: !!document.getElementById('admin'),
    };
  });

try {
  console.log('=== ADMIN / RESERVED NAME PROBE ===');
  console.log(`room: ${room}`);

  // First claimant.
  const a = await spawn('A', RESERVED);
  let sa = null;
  for (let i = 0; i < 30; i++) {
    await a.waitForTimeout(1000);
    sa = await state(a);
    if (sa.online && sa.admin) break;
  }

  // Second claimant, same name, same room.
  const b = await spawn('B', RESERVED);
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

  // Ping has to be a real measurement, not a placeholder.
  for (let i = 0; i < 20 && sa.ping <= 0; i++) {
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
  const list = await a.evaluate(() => {
    const el = document.getElementById('players');
    return {
      // The pause overlay must NOT be up: holding Tab hands the cursor back on
      // purpose, and pausing on that covered the list with the pause menu.
      paused: document.getElementById('pause')?.classList.contains('open') ?? false,
      open: el?.classList.contains('on') ?? false,
      rows: el?.querySelectorAll('.playerRow').length ?? 0,
      count: document.getElementById('playersCount')?.textContent ?? '',
      hasAdminTag: !!el?.querySelector('.adminTag'),
      pingText: el?.querySelector('.playerPing')?.textContent ?? '',
      litBars: !!el?.querySelector('.bars.lit4, .bars.lit3, .bars.lit2, .bars.lit1'),
    };
  });
  await a.screenshot({ path: join(here, 'admin_players.png') });
  await a.keyboard.up('Tab');
  await a.waitForTimeout(600);
  const listClosed = await a.evaluate(
    () => !(document.getElementById('players')?.classList.contains('on') ?? false),
  );

  console.log(`A: ${JSON.stringify(sa)}`);
  console.log(`B: ${JSON.stringify(sb)}`);
  console.log(`panel A: ${JSON.stringify(panelA)}  panel B: ${JSON.stringify(panelB)}`);
  console.log(`list: ${JSON.stringify(list)} closedOnRelease=${listClosed}`);

  const firstGotAdmin = sa.admin === true;
  const secondRefused = sb.admin === false;
  // The refused client must not be walking around under the reserved name either.
  const secondRenamed =
    sa.remotes.length > 0 && sa.remotes.every((r) => r.name !== RESERVED);
  const panelGated = panelA.open && panelA.buttons >= 20 && !panelB.open;
  const pingMeasured = sa.ping > 0 && sa.ping < 5000;
  const listWorks =
    list.open && !list.paused && list.rows >= 2 && list.hasAdminTag && list.litBars;
  const listCloses = listClosed;

  console.log(`first claim gets the name + admin: ${firstGotAdmin ? 'ok' : 'FAIL'}`);
  console.log(`second claim refused:              ${secondRefused ? 'ok' : 'FAIL'}`);
  console.log(`second not shown under that name:  ${secondRenamed ? 'ok' : 'FAIL'} (${JSON.stringify(sa.remotes)})`);
  console.log(`panel opens for admin only:        ${panelGated ? 'ok' : 'FAIL'} (${panelA.buttons} commands)`);
  console.log(`ping is a real measurement:        ${pingMeasured ? 'ok' : 'FAIL'} (${sa.ping} ms)`);
  console.log(`player list on held Tab:           ${listWorks ? 'ok' : 'FAIL'}`);
  console.log(`list closes on release:            ${listCloses ? 'ok' : 'FAIL'}`);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log(' ', e);

  const pass =
    firstGotAdmin &&
    secondRefused &&
    secondRenamed &&
    panelGated &&
    pingMeasured &&
    listWorks &&
    listCloses &&
    errors.length === 0;
  console.log('RESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
