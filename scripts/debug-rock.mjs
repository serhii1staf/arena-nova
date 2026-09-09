// Temporary probe: stands the camera right next to a boulder so the stone
// texture projection can be inspected close up.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = 'http://localhost:4173';

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('btnPlay');
    return !!b && !b.disabled;
  });
  await page.click('#btnPlay');
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.arena.engine.requestScene('exterior'));
  await page.waitForTimeout(6000);

  const found = await page.evaluate(() => {
    const sc = window.arena.scene;
    const veg = sc.scene.getObjectByName('Vegetation');
    const p = sc.player.renderPosition;
    let best = null;
    veg.traverse((o) => {
      if (!o.isInstancedMesh || o.name !== 'rock') return;
      const a = o.instanceMatrix.array;
      for (let i = 0; i < o.count; i++) {
        const x = a[i * 16 + 12];
        const z = a[i * 16 + 14];
        // Scale is baked into the matrix; take the X basis length.
        const s = Math.hypot(a[i * 16], a[i * 16 + 1], a[i * 16 + 2]);
        const d = Math.hypot(x - p.x, z - p.z);
        if (s > 1.6 && (!best || d < best.d)) best = { x, z, s: +s.toFixed(2), d: +d.toFixed(1) };
      }
    });
    return best;
  });

  const mat = await page.evaluate(() => {
    const veg = window.arena.scene.scene.getObjectByName('Vegetation');
    let out = null;
    veg.traverse((o) => {
      if (out || !o.isInstancedMesh || o.name !== 'rock') return;
      const m = o.material;
      const c = o.geometry.attributes.color;
      const samples = [];
      if (c) {
        for (let i = 0; i < 3; i++) {
          samples.push([+c.getX(i).toFixed(3), +c.getY(i).toFixed(3), +c.getZ(i).toFixed(3)]);
        }
      }
      out = {
        vertexColors: m.vertexColors,
        matColor: [+m.color.r.toFixed(3), +m.color.g.toFixed(3), +m.color.b.toFixed(3)],
        hasMap: !!m.map,
        hasNormalMap: !!m.normalMap,
        flatShading: m.flatShading,
        hasColorAttr: !!c,
        colorSamples: samples,
        vertexCount: o.geometry.attributes.position.count,
      };
    });
    return out;
  });
  console.log('rock material:', JSON.stringify(mat));

  if (!found) {
    console.log('no boulder found nearby');
  } else {
    console.log(`boulder at ${found.x.toFixed(1)}, ${found.z.toFixed(1)} scale ${found.s}`);
    // Stand a few metres off and look at it.
    await page.evaluate(({ x, z }) => {
      const sc = window.arena.scene;
      sc.player.spawn(x + 4.5, z + 4.5, 0);
      sc.player.yaw = Math.atan2(-(x - (x + 4.5)), -(z - (z + 4.5)));
      sc.player.pitch = -0.12;
      sc.setCameraZoom(0);
    }, found);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(here, 'rock_closeup.png') });
    console.log('screenshot: scripts/rock_closeup.png');
  }
  console.log(`errors: ${errors.length}`);
} finally {
  await browser.close();
}
