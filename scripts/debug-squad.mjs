// Probes the squad and the waypoint compass.
//
// Two clients in one room. A invites B through the relay, B answers, and both sides
// have to end up agreeing — membership is held by the clients rather than the server,
// so "both agreed" is the only thing worth asserting and the only thing that can go
// wrong. Then the coordinate readout and the compass are checked on A.
//
// Run against a live room: the relay is a server path, and an offline transport would
// exercise nothing at all.
//
// Usage:
//   node scripts/debug-squad.mjs [url]
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? 'http://localhost:8787';
const room = `squad-${Math.random().toString(36).slice(2, 9)}`;
const errors = [];

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});

async function spawn(label, name, skin) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 560 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  page.on('pageerror', (e) => {
    if (/Pointer Lock/i.test(e.message)) return;
    errors.push(`${label} pageerror: ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/AudioContext|audio device|Pointer Lock|404/i.test(m.text())) {
      errors.push(`${label} ${m.text()}`);
    }
  });
  await page.addInitScript(
    ([n, s]) => {
      localStorage.setItem('arena.name', n);
      localStorage.setItem('arena.skin', s);
    },
    [name, skin],
  );
  await page.goto(`${url}/?room=${room}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  await page.waitForFunction(() => window.arena?.scene?.net?.isOnline === true, {
    timeout: 120000,
  });
  return page;
}

const idOf = (page) => page.evaluate(() => window.arena.scene.net.localId);
const sees = (page) =>
  page.evaluate(() => [...window.arena.scene.net.remotePlayers.keys()]);

try {
  console.log('=== SQUAD / WAYPOINT PROBE ===');
  console.log(`room: ${room}`);

  const a = await spawn('A', 'Alpha', 'captain');
  const b = await spawn('B', 'Bravo', 'mako');
  const [idA, idB] = [await idOf(a), await idOf(b)];

  // Each has to see the other before an invite can be addressed.
  for (let i = 0; i < 30; i++) {
    await a.waitForTimeout(1000);
    if ((await sees(a)).includes(idB) && (await sees(b)).includes(idA)) break;
  }
  console.log(`A=${idA} sees ${JSON.stringify(await sees(a))}`);
  console.log(`B=${idB} sees ${JSON.stringify(await sees(b))}`);

  // --- A invites B, through the button a player actually presses ------------
  //
  // Driven by a real click rather than by calling the action directly. That
  // distinction matters here: the list is an overlay with `pointer-events: none`,
  // so the invite button inherited the pass-through and was impossible to click
  // while every underlying call worked perfectly. A probe that reached past the
  // DOM would have reported this feature as working.
  await a.bringToFront();
  await a.keyboard.down('Tab');
  await a.waitForTimeout(1200);
  const buttonClickable = await a
    .waitForSelector('#players .rowInvite', { timeout: 30000, state: 'visible' })
    .then(() => true)
    .catch(() => false);
  let clicked = false;
  if (buttonClickable) {
    clicked = await a
      .click('#players .rowInvite', { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
  }
  await a.screenshot({ path: join(here, 'squad_button.png') });
  await a.keyboard.up('Tab');
  console.log(`invite button present=${buttonClickable} clicked=${clicked}`);
  // Fall back to the action so the rest of the probe still reports, but the click
  // result is asserted below either way.
  if (!clicked) await a.evaluate((id) => window.arena.ui.squadInvite(id), idB);
  const cardAppeared = await b
    .waitForFunction(() => document.querySelectorAll('#squadInvites .inviteCard').length > 0, {
      timeout: 60000,
    })
    .then(() => true)
    .catch(() => false);
  await b.bringToFront();
  await b.screenshot({ path: join(here, 'squad_invite.png') });

  const inviteText = await b.evaluate(
    () => document.querySelector('#squadInvites .inviteText')?.textContent ?? '',
  );

  // --- B accepts -----------------------------------------------------------
  // Answered with the keyboard, which is the path a player actually has: while the
  // game holds the mouse there is no cursor, and the canvas takes the click.
  if (cardAppeared) await b.keyboard.press('KeyY');

  const bothAgree = await Promise.all([
    a
      .waitForFunction((id) => window.arena.ui.squadHas(id), idB, { timeout: 60000 })
      .then(() => true)
      .catch(() => false),
    b
      .waitForFunction((id) => window.arena.ui.squadHas(id), idA, { timeout: 60000 })
      .then(() => true)
      .catch(() => false),
  ]);

  // The roster has to appear, with a distance in it.
  await a.bringToFront();
  await a.waitForTimeout(2500);
  const roster = await a.evaluate(() => {
    const el = document.getElementById('squad');
    const rows = [...(el?.querySelectorAll('.squadRow') ?? [])];
    return {
      on: el?.classList.contains('on') ?? false,
      rows: rows.length,
      names: rows.map((r) => r.querySelector('.squadName')?.textContent ?? ''),
      distances: rows.map((r) => r.querySelector('.squadFar')?.textContent ?? ''),
    };
  });
  await a.screenshot({ path: join(here, 'squad_roster.png') });

  // --- Waypoint: F3 readout and a compass bearing --------------------------
  await a.keyboard.press('F3');
  await a.waitForTimeout(600);
  const readout = await a.evaluate(() => ({
    open: document.getElementById('coords')?.classList.contains('on') ?? false,
    text: document.getElementById('coordsRead')?.textContent ?? '',
  }));

  await a.fill('#coordsInput', '400 -250');
  await a.press('#coordsInput', 'Enter');
  await a.waitForTimeout(900);
  const compass = await a.evaluate(() => {
    const el = document.getElementById('compass');
    return {
      on: el?.classList.contains('on') ?? false,
      transform: document.getElementById('compassNeedle')?.style.transform ?? '',
      range: document.getElementById('compassRange')?.textContent ?? '',
    };
  });
  await a.screenshot({ path: join(here, 'squad_waypoint.png') });

  console.log(`invite card on B: ${cardAppeared} "${inviteText.trim()}"`);
  console.log(`both agree: A->B=${bothAgree[0]} B->A=${bothAgree[1]}`);
  console.log(`roster: ${JSON.stringify(roster)}`);
  console.log(`F3 readout: ${JSON.stringify(readout)}`);
  console.log(`compass: ${JSON.stringify(compass)}`);
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 6)) console.log(' ', e);

  const inviteDelivered = cardAppeared && /Alpha/.test(inviteText);
  const buttonWorks = buttonClickable && clicked;
  const agreed = bothAgree[0] && bothAgree[1];
  const rosterShown = roster.on && roster.rows === 1 && roster.names[0] === 'Bravo';
  const distanceShown = /^\d+ m$/.test((roster.distances[0] ?? '').trim());
  const coordsShown = readout.open && /^X -?\d+\s+Y -?\d+\s+Z -?\d+$/.test(readout.text.trim());
  const compassAims = compass.on && /rotate\(-?\d+deg\)/.test(compass.transform);
  const rangeShown = /(\d+ m|\d+\.\d+k m|arrived|на месте)/.test(compass.range);

  console.log('\n=== VERDICT ===');
  console.log(`invite button is clickable:      ${buttonWorks ? 'ok' : 'FAIL'}`);
  console.log(`invite reaches the other player: ${inviteDelivered ? 'ok' : 'FAIL'}`);
  console.log(`both sides agree after accept:   ${agreed ? 'ok' : 'FAIL'}`);
  console.log(`roster lists the member:         ${rosterShown ? 'ok' : 'FAIL'}`);
  console.log(`roster shows a distance:         ${distanceShown ? 'ok' : 'FAIL'} ("${roster.distances[0]}")`);
  console.log(`F3 shows coordinates:            ${coordsShown ? 'ok' : 'FAIL'} ("${readout.text}")`);
  console.log(`compass points at the target:    ${compassAims ? 'ok' : 'FAIL'} ("${compass.transform}")`);
  console.log(`compass shows a range:           ${rangeShown ? 'ok' : 'FAIL'} ("${compass.range}")`);

  const pass =
    buttonWorks &&
    inviteDelivered &&
    agreed &&
    rosterShown &&
    distanceShown &&
    coordsShown &&
    compassAims &&
    rangeShown &&
    errors.length === 0;
  console.log('\nRESULT:', pass ? 'PASS' : 'FAIL');
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
}
