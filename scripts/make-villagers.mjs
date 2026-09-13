/**
 * Converts the authored character pack's `.gltf` files into `.glb`.
 *
 * The pack ships self-contained glTF: the mesh, the skeleton and ten animation clips are all
 * base64 inside a 1.8 MB JSON document. Shipping those as they are would mean the browser
 * downloading and then decoding base64 for every villager model, and base64 is a third larger
 * than the bytes it encodes. GLB is the same data with the buffer as a binary chunk, which is
 * both smaller and parsed without a decode step.
 *
 * Deliberately dependency-free. A GLB is a twelve-byte header and two length-prefixed
 * chunks — writing it directly is a few lines, and adding a model pipeline to the project for
 * one conversion would be a worse trade than that.
 *
 * Clips are pruned to the ones the game can actually use. The pack carries ten per character,
 * including a death, a punch and a roll, and animation data is most of the file: a villager
 * needs to stand, walk and run.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const src = process.argv[2];
const dst = process.argv[3];
if (!src || !dst) {
  console.error('usage: node scripts/make-villagers.mjs <gltf-dir> <out-dir>');
  process.exit(1);
}
mkdirSync(dst, { recursive: true });

/** The only clips a villager or a farm animal needs. */
const KEEP = new Set(['Idle', 'Walk']);

const align4 = (n) => (n + 3) & ~3;

let total = 0;
for (const file of readdirSync(src).filter((f) => f.endsWith('.gltf'))) {
  const doc = JSON.parse(readFileSync(join(src, file), 'utf8'));

  // The pack has exactly one buffer, embedded as a data URI.
  const buffer = doc.buffers?.[0];
  if (!buffer?.uri?.startsWith('data:')) {
    console.warn(`skip ${file}: buffer is not embedded`);
    continue;
  }
  const bin = Buffer.from(buffer.uri.slice(buffer.uri.indexOf(',') + 1), 'base64');

  // Drop the clips we will never play.
  const before = doc.animations?.length ?? 0;
  if (Array.isArray(doc.animations)) {
    doc.animations = doc.animations.filter((a) => KEEP.has(a.name));
  }

  /**
   * Rebuild the buffer around what is still referenced.
   *
   * Deleting the animation *definitions* alone saves nothing worth having: the keyframe data
   * stays in the buffer, orphaned but still downloaded. Fourteen dropped clips out of
   * seventeen left the files at 900 kB to 1.2 MB each, twelve and a half megabytes for a dozen
   * models. The data has to be repacked, which means collecting every accessor anything still
   * points at, keeping only their buffer views, and re-indexing both.
   */
  const usedAccessors = new Set();
  const useAcc = (i) => {
    if (typeof i === 'number') usedAccessors.add(i);
  };
  for (const mesh of doc.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      useAcc(prim.indices);
      for (const v of Object.values(prim.attributes ?? {})) useAcc(v);
      for (const t of prim.targets ?? []) for (const v of Object.values(t)) useAcc(v);
    }
  }
  for (const skin of doc.skins ?? []) useAcc(skin.inverseBindMatrices);
  for (const anim of doc.animations ?? []) {
    for (const s of anim.samplers ?? []) {
      useAcc(s.input);
      useAcc(s.output);
    }
  }

  const accIds = [...usedAccessors].sort((a, b) => a - b);
  const accMap = new Map(accIds.map((old, i) => [old, i]));
  const newAccessors = [];
  const viewIds = [];
  const viewMap = new Map();
  for (const old of accIds) {
    const acc = { ...doc.accessors[old] };
    if (typeof acc.bufferView === 'number') {
      if (!viewMap.has(acc.bufferView)) {
        viewMap.set(acc.bufferView, viewIds.length);
        viewIds.push(acc.bufferView);
      }
      acc.bufferView = viewMap.get(acc.bufferView);
    }
    newAccessors.push(acc);
  }

  // Copy the kept views into a fresh buffer, four-byte aligned as the spec requires.
  const chunks = [];
  const newViews = [];
  let offset = 0;
  for (const old of viewIds) {
    const v = doc.bufferViews[old];
    const start = v.byteOffset ?? 0;
    const slice = bin.subarray(start, start + v.byteLength);
    const pad = align4(offset) - offset;
    if (pad > 0) {
      chunks.push(Buffer.alloc(pad, 0));
      offset += pad;
    }
    chunks.push(slice);
    const nv = { buffer: 0, byteOffset: offset, byteLength: v.byteLength };
    if (v.byteStride !== undefined) nv.byteStride = v.byteStride;
    if (v.target !== undefined) nv.target = v.target;
    newViews.push(nv);
    offset += v.byteLength;
  }
  const packed = Buffer.concat(chunks);

  // Re-point everything at the new indices.
  doc.accessors = newAccessors;
  doc.bufferViews = newViews;
  const remap = (i) => accMap.get(i);
  for (const mesh of doc.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      if (typeof prim.indices === 'number') prim.indices = remap(prim.indices);
      for (const k of Object.keys(prim.attributes ?? {})) {
        prim.attributes[k] = remap(prim.attributes[k]);
      }
      for (const t of prim.targets ?? []) {
        for (const k of Object.keys(t)) t[k] = remap(t[k]);
      }
    }
  }
  for (const skin of doc.skins ?? []) {
    if (typeof skin.inverseBindMatrices === 'number') {
      skin.inverseBindMatrices = remap(skin.inverseBindMatrices);
    }
  }
  for (const anim of doc.animations ?? []) {
    for (const s of anim.samplers ?? []) {
      s.input = remap(s.input);
      s.output = remap(s.output);
    }
  }

  delete buffer.uri;
  buffer.byteLength = packed.length;
  doc.buffers = [buffer];

  const json = Buffer.from(JSON.stringify(doc), 'utf8');
  const jsonPad = align4(json.length) - json.length;
  const binPad = align4(packed.length) - packed.length;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
  const binChunk = Buffer.concat([packed, Buffer.alloc(binPad, 0)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonChunk.length, 0);
  jsonHead.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binChunk.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4); // 'BIN'

  const out = Buffer.concat([header, jsonHead, jsonChunk, binHead, binChunk]);
  const name = `${basename(file, '.gltf')}.glb`;
  writeFileSync(join(dst, name), out);
  total += out.length;
  console.log(
    `${name.padEnd(28)} ${(out.length / 1024).toFixed(0)} kB   clips ${before} -> ${doc.animations?.length ?? 0}`,
  );
}
console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB`);
