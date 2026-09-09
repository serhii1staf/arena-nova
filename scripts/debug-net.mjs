// Verifies real multiplayer against the deployed server: two independent
// browsers join the same room, and each must see the other's avatar appear and
// move. Run against the public URL, so this exercises the actual edge deployment
// rather than a local stub.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'https://arena-nova.odi44972.workers.dev';
const room = `test-${Date.now().toString(36)}`;

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});

const errors = [];

/** Boots one client into the lobby of a named room. */
async function spawnClient(label, skin) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 500 } });
  const page = await ctx.newPage();
  // Different characters per client, so the crowd is checked for the skin each
  // player actually chose rather than everyone defaulting to the same model.
  await page.addInitScript((id) => localStorage.setItem('arena.skin', id), skin);
  // Software rendering plus a real network round-trip; the boot is slow here.
  page.setDefaultTimeout(150000);
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`);
  });
  await page.goto(`${url}/?room=${room}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  return page;
}

const status = (page) =>
  page.evaluate(() => {
    const net = window.arena.scene.net;
    return {
      state: net.state,
      localId: net.localId,
      remotes: [...net.remotePlayers.values()].map((p) => ({
        id: p.id,
        skin: p.skin,
        x: +p.x.toFixed(2),
        z: +p.z.toFixed(2),
      })),
    };
  });

try {
  console.log('=== NETWORK PROBE ===');
  console.log(`room: ${room}`);
  const a = await spawnClient('A', 'skeleton');
  const b = await spawnClient('B', 'anne');

  // Give both sockets time to connect and exchange a few snapshots.
  let sa = null;
  let sb = null;
  for (let i = 0; i < 20; i++) {
    await a.waitForTimeout(1000);
    sa = await status(a);
    sb = await status(b);
    if (sa.remotes.length > 0 && sb.remotes.length > 0) break;
  }
  console.log('A:', JSON.stringify(sa));
  console.log('B:', JSON.stringify(sb));

  // Now move A and confirm B's copy of A actually follows.
  const before = sb.remotes[0]?.x ?? null;
  // Two browser contexts are open, so A has to be the focused one or its key
  // presses go nowhere — that made this check flaky.
  await a.bringToFront();
  await a.locator('#app canvas').click({ position: { x: 200, y: 200 } }).catch(() => {});
  await a.keyboard.down('KeyW');
  // Wall time is the wrong clock here: the engine clamps frameDelta to 0.1 s, so
  // under software rendering the simulation advances far slower than real time.
  const startTime = await a.evaluate(() => window.arena.scene.time);
  for (let i = 0; i < 60; i++) {
    await a.waitForTimeout(500);
    const now = await a.evaluate(() => window.arena.scene.time);
    if (now - startTime >= 5) break;
  }
  await a.keyboard.up('KeyW');
  await a.waitForTimeout(2000);
  const sb2 = await status(b);
  const after = sb2.remotes[0]?.z ?? null;
  const beforeZ = sb.remotes[0]?.z ?? null;
  console.log('B sees A after A walked:', JSON.stringify(sb2.remotes));

  const sawEachOther =
    sa.state === 'online' &&
    sb.state === 'online' &&
    sa.remotes.length > 0 &&
    sb.remotes.length > 0 &&
    sa.remotes[0].id === sb.localId &&
    sb.remotes[0].id === sa.localId;
  const moved = beforeZ !== null && after !== null && Math.abs(after - beforeZ) > 1;

  console.log(`identities match: ${sawEachOther}`);
  console.log(`movement replicated: ${moved} (z ${beforeZ} -> ${after})`);
  void before;
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log(' ', e);

  // ---- Open world --------------------------------------------------------
  // The session has to survive the scene switch. Each scene used to own its own
  // connection, so stepping through the portal dropped you out of the room and
  // nobody in the big world could see anybody.
  console.log('--- both players step into the open world ---');
  for (const p of [a, b]) {
    await p.evaluate(() => window.arena.engine.requestScene('exterior'));
  }
  for (const p of [a, b]) {
    await p
      .waitForFunction(
        () => window.arena.engine.scenes.currentName === 'exterior' && !!window.arena.scene,
        { timeout: 150000 },
      )
      .catch(() => {});
  }
  await a.waitForTimeout(6000);

  const exterior = await Promise.all([status(a), status(b)]);
  console.log('A in exterior:', JSON.stringify(exterior[0]));
  console.log('B in exterior:', JSON.stringify(exterior[1]));
  const crowd = await b.evaluate(() => {
    const g = window.arena.scene.scene.getObjectByName('RemotePlayers');
    return { present: !!g, avatars: g?.children.length ?? 0 };
  });
  console.log('B remote-player group:', JSON.stringify(crowd));

  const worldOk =
    exterior[0].state === 'online' &&
    exterior[1].state === 'online' &&
    exterior[0].remotes.length > 0 &&
    exterior[1].remotes.length > 0 &&
    crowd.avatars > 0;
  console.log(`open world sync: ${worldOk}`);

  const ok = sawEachOther && moved && worldOk && errors.length === 0;
  console.log('RESULT:', ok ? 'PASS — two players see each other, lobby and open world' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
