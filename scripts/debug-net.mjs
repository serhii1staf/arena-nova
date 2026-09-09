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
async function spawnClient(label) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 500 } });
  const page = await ctx.newPage();
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
        x: +p.x.toFixed(2),
        z: +p.z.toFixed(2),
      })),
    };
  });

try {
  console.log('=== NETWORK PROBE ===');
  console.log(`room: ${room}`);
  const a = await spawnClient('A');
  const b = await spawnClient('B');

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
  await a.keyboard.down('KeyW');
  await a.waitForTimeout(6000);
  await a.keyboard.up('KeyW');
  await a.waitForTimeout(1500);
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

  const ok = sawEachOther && moved && errors.length === 0;
  console.log('RESULT:', ok ? 'PASS — two players see each other move' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
