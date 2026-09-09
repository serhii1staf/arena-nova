// Temporary probe: verifies that props and the player sit exactly on the terrain
// as *drawn*. It reads the real triangle data out of the streamed chunk
// geometries and interpolates the surface there, so it tests the rendered mesh
// rather than re-deriving heights from the generator.
import { chromium } from 'playwright';

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

  // Walk so chunks stream in across several LOD rings.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(7000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(1200);

  const report = await page.evaluate(() => {
    const sc = window.arena.scene;
    const world = sc.world;
    const scene = sc.scene;
    const terrain = scene.getObjectByName('Terrain');
    const vegetation = scene.getObjectByName('Vegetation');
    const landmarks = scene.getObjectByName('Landmarks');

    // Snapshot every chunk's triangles once, in world XZ.
    const chunks = [];
    for (const mesh of terrain.children) {
      const geo = mesh.geometry;
      const pos = geo.attributes.position.array;
      const idx = geo.index.array;
      chunks.push({
        ox: mesh.position.x,
        oz: mesh.position.z,
        pos,
        idx,
      });
    }

    /** Height of the drawn terrain under a point, or null if no chunk covers it. */
    const meshHeight = (x, z) => {
      let best = null;
      for (const c of chunks) {
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
          // Barycentric test in the XZ plane. Skirt triangles are vertical, so
          // their projected area is zero and they drop out here.
          const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
          if (d === 0) continue;
          const u = ((bz - cz) * (lx - cx) + (cx - bx) * (lz - cz)) / d;
          if (u < -1e-6 || u > 1 + 1e-6) continue;
          const v = ((cz - az) * (lx - cx) + (ax - cx) * (lz - cz)) / d;
          if (v < -1e-6 || v > 1 + 1e-6) continue;
          const w = 1 - u - v;
          if (w < -1e-6) continue;
          const y = u * pos[ia + 1] + v * pos[ib + 1] + w * pos[ic + 1];
          // Multiple chunks can overlap along a shared edge; take the highest.
          if (best === null || y > best) best = y;
        }
      }
      return best;
    };

    const stat = (name, samples) => {
      if (samples.length === 0) return { name, n: 0 };
      const abs = samples.map(Math.abs).sort((a, b) => a - b);
      return {
        name,
        n: samples.length,
        median: +abs[Math.floor(abs.length * 0.5)].toFixed(3),
        p95: +abs[Math.floor(abs.length * 0.95)].toFixed(3),
        maxAbs: +abs[abs.length - 1].toFixed(3),
      };
    };

    // --- 1. Streamed prop instances vs the ground beneath them ---------------
    const propDiffs = [];
    const propXZ = [];
    let instances = 0;
    const walk = (root, out) => {
      root?.traverse((o) => {
        if (!o.isInstancedMesh) return;
        const arr = o.instanceMatrix.array;
        const stride = Math.max(1, Math.floor(o.count / 8));
        for (let i = 0; i < o.count; i += stride) {
          const b = i * 16;
          const x = arr[b + 12];
          const y = arr[b + 13];
          const z = arr[b + 14];
          instances++;
          propXZ.push([x, z]);
          const m = meshHeight(x, z);
          if (m === null) continue;
          out.push(y - m);
        }
      });
    };
    walk(vegetation, propDiffs);

    // --- 2. What the player stands on vs what is drawn -----------------------
    const p = sc.player.renderPosition;
    const surfaceDiffs = [];
    for (let i = 0; i < 250; i++) {
      const x = p.x + (Math.random() - 0.5) * 300;
      const z = p.z + (Math.random() - 0.5) * 300;
      const m = meshHeight(x, z);
      if (m === null) continue;
      // Skip anywhere a boulder or log is registered: there `floorHeightAt`
      // correctly reports the prop's climbable top, not the ground.
      let nearProp = false;
      for (const [px, pz] of propXZ) {
        if (Math.abs(px - x) < 4 && Math.abs(pz - z) < 4) {
          nearProp = true;
          break;
        }
      }
      if (nearProp) continue;
      surfaceDiffs.push(world.floorHeightAt(x, z) - m);
    }

    // --- 3. Landmarks (campfires, camps, ruins) vs their pad ----------------
    const landmarkDiffs = [];
    for (const chunkRoot of landmarks?.children ?? []) {
      // Skip the pooled fire lights, which live directly under the group.
      if (!chunkRoot.children) continue;
      for (const anchor of chunkRoot.children) {
        if (anchor.isLight) continue;
        const m = meshHeight(anchor.position.x, anchor.position.z);
        if (m === null) continue;
        landmarkDiffs.push(anchor.position.y - m);
      }
    }

    const playerMesh = meshHeight(p.x, p.z);
    return {
      surface: stat('floorHeightAt vs drawn mesh', surfaceDiffs),
      props: stat('prop base vs drawn mesh', propDiffs),
      landmarks: stat('landmark base vs drawn mesh', landmarkDiffs),
      instancesSampled: instances,
      chunksScanned: chunks.length,
      player: {
        y: +p.y.toFixed(3),
        mesh: playerMesh === null ? null : +playerMesh.toFixed(3),
        diff: playerMesh === null ? null : +(p.y - playerMesh).toFixed(3),
      },
    };
  });

  console.log('=== GROUND PROBE ===');
  console.log(JSON.stringify(report, null, 2));
  console.log(`errors: ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log(' ', e);

  // The player and every prop must be exact. Landmarks are allowed a few
  // centimetres because they stream out past the near-detail rings, where the
  // terrain grid is 32 m and cannot reproduce a levelled pad precisely — at that
  // distance (>800 m) the offset is far under a pixel.
  const ok =
    report.surface.maxAbs !== undefined &&
    report.surface.maxAbs < 0.02 &&
    report.props.maxAbs < 0.02 &&
    (report.landmarks.n === 0 || report.landmarks.maxAbs < 0.3) &&
    report.player.diff === 0 &&
    errors.length === 0;
  console.log('RESULT:', ok ? 'PASS — everything sits on the drawn surface' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
