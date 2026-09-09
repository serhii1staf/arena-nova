// Builds the updater manifest from the freshly signed bundles. Written from the
// files on disk rather than by hand, so the signature always belongs to the
// binary that ships in the same release.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const dir = join('src-tauri', 'target', 'release', 'bundle', 'nsis');
const exe = `Arena Nova_${version}_x64-setup.exe`;
const sig = readFileSync(join(dir, `${exe}.sig`), 'utf8').trim();

// GitHub normalises spaces in asset filenames to dots on upload, so the download
// URL is not the local filename percent-encoded — that form 404s and the in-game
// updater fails at the download step, after having already told the player an
// update exists.
const assetName = exe.replace(/ /g, '.');

const manifest = {
  version,
  notes: `Arena Nova ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: sig,
      url: `https://github.com/serhii1staf/arena-nova/releases/download/v${version}/${assetName}`,
    },
  },
};

writeFileSync('latest.json', `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json -> ${version}`);
console.log(manifest.platforms['windows-x86_64'].url);
