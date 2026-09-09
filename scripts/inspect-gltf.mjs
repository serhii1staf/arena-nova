// Reports what is actually inside a folder of .gltf files: animation names,
// skinning, triangle counts and how the buffers are stored. Used to decide
// whether an asset pack is usable before wiring anything up.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const filter = process.argv[3] ?? '';

for (const name of readdirSync(dir)) {
  if (!name.endsWith('.gltf')) continue;
  if (filter && !name.includes(filter)) continue;
  const raw = readFileSync(join(dir, name), 'utf8');
  let g;
  try {
    g = JSON.parse(raw);
  } catch {
    console.log(`${name}: not valid JSON`);
    continue;
  }
  const anims = (g.animations ?? []).map((a) => a.name ?? '(unnamed)');
  const tris = (g.meshes ?? []).reduce((n, m) => {
    for (const p of m.primitives ?? []) {
      const acc = g.accessors?.[p.indices];
      if (acc) n += acc.count / 3;
    }
    return n;
  }, 0);
  const embedded = (g.buffers ?? []).every((b) => !b.uri || b.uri.startsWith('data:'));
  const images = (g.images ?? []).map((i) => i.uri?.slice(0, 40) ?? 'embedded');
  console.log(
    [
      name.padEnd(38),
      `${(statSync(join(dir, name)).size / 1024).toFixed(0)}kB`.padStart(7),
      `tris:${String(Math.round(tris)).padStart(6)}`,
      `skins:${g.skins?.length ?? 0}`,
      `anims:${anims.length}`,
      embedded ? 'embedded' : 'external',
      images.length ? `img:${images.join(',')}` : 'img:none',
    ].join('  '),
  );
  if (anims.length) console.log(`      ${anims.join(' | ')}`);
}
