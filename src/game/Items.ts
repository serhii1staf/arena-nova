import type { BufferGeometry } from 'three';
import { Carpentry } from '../world/Building.ts';

/**
 * Items
 * -----
 * Everything that can sit in a player's inventory, described once.
 *
 * Each item owns its own geometry, and that geometry is what the world drops, what
 * the inventory draws an icon of, and what a placed workbench is made of. One
 * definition means an icon can never show something the world does not contain — the
 * failure that a hand-drawn icon set guarantees the first time a shape changes.
 *
 * Built from the same `Carpentry` primitive as the construction pieces, so every face
 * comes out wound outwards and lit correctly without a normals pass.
 */

export type ItemId =
  // Gathered off the ground.
  | 'stick'
  | 'stone'
  | 'fibre'
  | 'berries'
  // Worked materials.
  | 'log'
  | 'plank'
  // Tools.
  | 'spear'
  | 'axe'
  | 'pickaxe'
  // Placeable.
  | 'workbench';

export interface ItemDef {
  id: ItemId;
  /** How many fit in one inventory slot. */
  stack: number;
  /** Tint for the icon, so stone does not come out timber-coloured. */
  colour: number;
  /**
   * What holding this lets you do. `axe` fells a snag, `pickaxe` breaks stone.
   * A plain material has no verb.
   */
  tool?: 'axe' | 'pickaxe' | 'spear';
  /** Food value, 0..1 of the meter, when eaten. */
  eat?: number;
}

/** Board thickness reused across the item shapes. */
const B = 0.05;

/** A rough stone: eight faces around a centre reads as a lump at icon size. */
function stoneGeo(scale: number): BufferGeometry {
  const c = new Carpentry();
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // Radii jittered by index rather than randomly, so the shape is stable between
    // runs — an icon that changes shape on reload looks like a bug.
    const r = scale * (0.62 + ((i * 37) % 11) / 40);
    const h = scale * (0.4 + ((i * 53) % 7) / 30);
    c.box(Math.cos(a) * r * 0.5, h * 0.6, Math.sin(a) * r * 0.5, r * 0.42, h, r * 0.42);
  }
  return c.finish();
}

function stickGeo(): BufferGeometry {
  return new Carpentry()
    .box(0, 0.03, 0, 0.035, 0.03, 0.42)
    // A side twig, so it is a stick and not a dowel.
    .box(0.07, 0.03, 0.12, 0.09, 0.022, 0.022)
    .finish();
}

function fibreGeo(): BufferGeometry {
  const c = new Carpentry();
  // A twist of cordage: five strands laid side by side with a wrap at each end.
  for (let i = 0; i < 5; i++) {
    c.box(-0.06 + i * 0.03, 0.02, 0, 0.013, 0.016, 0.2 - Math.abs(i - 2) * 0.02);
  }
  c.box(0, 0.02, 0.16, 0.075, 0.022, 0.02);
  c.box(0, 0.02, -0.16, 0.075, 0.022, 0.02);
  return c.finish();
}

function berriesGeo(): BufferGeometry {
  const c = new Carpentry();
  for (const [x, y, z] of [
    [0, 0.05, 0],
    [0.07, 0.045, 0.04],
    [-0.06, 0.05, 0.05],
    [0.02, 0.05, -0.07],
    [-0.03, 0.12, 0.01],
  ]) {
    c.box(x, y, z, 0.045, 0.045, 0.045);
  }
  // Stalk.
  c.box(0, 0.17, 0, 0.012, 0.06, 0.012);
  return c.finish();
}

function logGeo(): BufferGeometry {
  const c = new Carpentry();
  // Eight staves round the axis: a round log out of boxes, the same trick the barrel
  // uses, and it reads as round from every angle an icon is seen from.
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    c.box(0, 0.16 + Math.sin(a) * 0.13, Math.cos(a) * 0.13, 0.42, 0.055, 0.055);
  }
  c.box(0, 0.16, 0, 0.42, 0.09, 0.09);
  return c.finish();
}

function plankGeo(): BufferGeometry {
  return new Carpentry().box(0, B, 0, 0.44, B, 0.11).finish();
}

function spearGeo(): BufferGeometry {
  return new Carpentry()
    .box(0, 0.03, 0, 0.024, 0.024, 0.62)
    // Knapped head, lashed on.
    .box(0, 0.03, -0.68, 0.05, 0.018, 0.08)
    .box(0, 0.03, -0.6, 0.036, 0.03, 0.035)
    .finish();
}

function axeGeo(): BufferGeometry {
  return new Carpentry()
    .box(0, 0.03, 0.08, 0.026, 0.026, 0.34)
    .box(0, 0.03, -0.28, 0.03, 0.09, 0.12)
    .box(0.06, 0.03, -0.28, 0.04, 0.075, 0.09)
    .finish();
}

function pickaxeGeo(): BufferGeometry {
  return new Carpentry()
    .box(0, 0.03, 0.08, 0.028, 0.028, 0.36)
    .box(0, 0.03, -0.28, 0.26, 0.045, 0.05)
    .box(-0.22, 0.03, -0.28, 0.06, 0.032, 0.035)
    .box(0.22, 0.03, -0.28, 0.06, 0.032, 0.035)
    .finish();
}

/**
 * A workbench: a heavy top on four legs with a tool rack.
 *
 * The item and the thing standing in the world are the same geometry, so what you
 * carry is visibly what you put down.
 */
export function workbenchGeo(): BufferGeometry {
  const c = new Carpentry();
  for (const sx of [-0.62, 0.62]) {
    for (const sz of [-0.34, 0.34]) {
      c.box(sx, 0.36, sz, 0.07, 0.36, 0.07);
    }
  }
  // Top, five boards.
  for (let i = 0; i < 5; i++) {
    c.box(0, 0.78, -0.32 + (i * 0.64) / 4, 0.7, 0.045, 0.075);
  }
  // Apron and stretchers.
  c.box(0, 0.68, 0, 0.66, 0.06, 0.38);
  for (const sz of [-0.34, 0.34]) c.box(0, 0.16, sz, 0.6, 0.045, 0.045);
  // Back rack with pegs, so it reads as a bench and not a table.
  c.box(0, 1.12, -0.36, 0.68, 0.28, 0.04);
  for (const sx of [-0.42, -0.14, 0.14, 0.42]) c.box(sx, 1.02, -0.28, 0.02, 0.02, 0.06);
  c.box(0, 1.42, -0.36, 0.68, 0.035, 0.09);
  return c.finish();
}

/** One shared geometry per item, built on first use and kept for the session. */
const geos = new Map<ItemId, BufferGeometry>();

const builders: Record<ItemId, () => BufferGeometry> = {
  stick: stickGeo,
  stone: () => stoneGeo(0.22),
  fibre: fibreGeo,
  berries: berriesGeo,
  log: logGeo,
  plank: plankGeo,
  spear: spearGeo,
  axe: axeGeo,
  pickaxe: pickaxeGeo,
  workbench: workbenchGeo,
};

export function itemGeometry(id: ItemId): BufferGeometry {
  const hit = geos.get(id);
  if (hit) return hit;
  const made = builders[id]();
  geos.set(id, made);
  return made;
}

/** Frees every item geometry. Only on teardown; they are shared. */
export function disposeItemGeometry(): void {
  for (const g of geos.values()) g.dispose();
  geos.clear();
}

export const ITEMS: Record<ItemId, ItemDef> = {
  stick: { id: 'stick', stack: 50, colour: 0x8a6238 },
  stone: { id: 'stone', stack: 50, colour: 0x8e9296 },
  fibre: { id: 'fibre', stack: 50, colour: 0xa8a06a },
  berries: { id: 'berries', stack: 25, colour: 0x9c2f4a, eat: 0.22 },
  log: { id: 'log', stack: 10, colour: 0x7a5530 },
  plank: { id: 'plank', stack: 50, colour: 0xc19a5f },
  spear: { id: 'spear', stack: 1, colour: 0x9c7a4a, tool: 'spear' },
  axe: { id: 'axe', stack: 1, colour: 0x9aa0a4, tool: 'axe' },
  pickaxe: { id: 'pickaxe', stack: 1, colour: 0x9aa0a4, tool: 'pickaxe' },
  workbench: { id: 'workbench', stack: 3, colour: 0xb07c46 },
};

/** Display order in the inventory, so the grid does not reshuffle. */
export const ITEM_ORDER: readonly ItemId[] = [
  'stick',
  'stone',
  'fibre',
  'berries',
  'log',
  'plank',
  'spear',
  'axe',
  'pickaxe',
  'workbench',
];
