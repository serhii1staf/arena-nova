import type { Inventory } from './Inventory.ts';
import type { ItemId } from './Items.ts';

/**
 * Recipes
 * -------
 * What can be made from what, and where.
 *
 * Two tiers, and the split is the point. Anything you can do with your hands you can
 * do standing anywhere, so a player who has just arrived is never stuck; anything that
 * needs a bench needs a bench, which is what gives the benches scattered across the
 * map a reason to be worth finding. A player's own bench is itself a bench recipe, so
 * the first one has to be found rather than conjured — that is the whole shape of the
 * early game.
 */

export interface Recipe {
  /** Stable id, used as a key in the panel and in the i18n table. */
  id: string;
  /** What comes out, and how many. */
  out: ItemId;
  count: number;
  /** What goes in. */
  needs: { id: ItemId; count: number }[];
  /** True when a workbench has to be within reach. */
  bench: boolean;
  /** Seconds of work. Short, but not instant: a craft should feel like an action. */
  seconds: number;
}

export const RECIPES: readonly Recipe[] = [
  // --- By hand ---
  {
    id: 'spear',
    out: 'spear',
    count: 1,
    needs: [
      { id: 'stick', count: 2 },
      { id: 'stone', count: 1 },
      { id: 'fibre', count: 1 },
    ],
    bench: false,
    seconds: 2.5,
  },
  {
    id: 'axe',
    out: 'axe',
    count: 1,
    needs: [
      { id: 'stick', count: 1 },
      { id: 'stone', count: 2 },
      { id: 'fibre', count: 2 },
    ],
    bench: false,
    seconds: 3,
  },
  // Splitting a log needs nothing but an axe and somewhere to put it, so it is a hand
  // recipe — otherwise a player with a bench full of logs and no bench in sight is
  // holding firewood they cannot use.
  {
    id: 'plankFromLog',
    out: 'plank',
    count: 3,
    needs: [{ id: 'log', count: 1 }],
    bench: false,
    seconds: 2,
  },

  // --- At a bench ---
  {
    id: 'pickaxe',
    out: 'pickaxe',
    count: 1,
    needs: [
      { id: 'stick', count: 2 },
      { id: 'stone', count: 3 },
      { id: 'fibre', count: 2 },
    ],
    bench: true,
    seconds: 4,
  },
  {
    id: 'workbench',
    out: 'workbench',
    count: 1,
    needs: [
      { id: 'plank', count: 6 },
      { id: 'stick', count: 4 },
      { id: 'fibre', count: 2 },
    ],
    bench: true,
    seconds: 6,
  },
];

/** Why a recipe cannot be made right now, or null when it can. */
export type Blocked = 'bench' | 'materials' | null;

export function blockedBy(r: Recipe, inv: Inventory, atBench: boolean): Blocked {
  if (r.bench && !atBench) return 'bench';
  for (const need of r.needs) {
    if (inv.count(need.id) < need.count) return 'materials';
  }
  // A tool that splits a log is a tool, not an ingredient — it is not consumed, so it
  // is checked separately rather than listed in `needs`.
  if (r.id === 'plankFromLog' && !inv.hasTool('axe')) return 'materials';
  return null;
}

/**
 * Takes the materials and hands over the result.
 *
 * All or nothing: the inputs are checked in full before any of them is removed, so a
 * craft that turns out to be short cannot eat half the materials on its way to
 * failing.
 */
export function craft(r: Recipe, inv: Inventory, atBench: boolean): boolean {
  if (blockedBy(r, inv, atBench) !== null) return false;
  for (const need of r.needs) {
    if (!inv.take(need.id, need.count)) return false;
  }
  return inv.add(r.out, r.count) > 0;
}

/**
 * Recipes ordered so the ones you can make now come first.
 *
 * This is the recommendation the panel shows: not a separate list to keep in step,
 * just the one list sorted by whether it is available. Within a tier the declared
 * order is kept, so the panel does not reshuffle as materials come and go.
 */
export function recommended(inv: Inventory, atBench: boolean): { r: Recipe; blocked: Blocked }[] {
  return RECIPES.map((r) => ({ r, blocked: blockedBy(r, inv, atBench) })).sort((a, b) => {
    const rank = (x: Blocked): number => (x === null ? 0 : x === 'materials' ? 1 : 2);
    return rank(a.blocked) - rank(b.blocked);
  });
}
