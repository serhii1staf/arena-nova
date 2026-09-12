import { ITEMS, type ItemId } from './Items.ts';

/**
 * Inventory and vitals
 * --------------------
 * What the player is carrying, and how they are doing.
 *
 * Counts per item rather than an array of slots. A slot array is what you need when
 * slots have meaning — when the order matters, or two half stacks of the same thing
 * can exist side by side — and none of that is true here: the grid is drawn in a
 * fixed order and a stack limit is a cap on a number. Counting avoids an entire class
 * of bug (the same item in two places, disagreeing) for no loss.
 *
 * Persisted to local storage, and that is a deliberate first step rather than the
 * finished answer. It means the inventory survives a reload, and it also means a
 * determined player can edit it and that a reinstall loses it. Making it authoritative
 * needs the same thing the placed buildings need — world state owned by the server —
 * and that is a larger piece of work than this file.
 */

const KEY = 'arena.inventory';
const VITALS_KEY = 'arena.vitals';

/** Slots shown in the grid. Above this an item simply cannot be picked up. */
export const SLOTS = 24;

/**
 * How long a full water meter lasts at rest, and a full food meter, in seconds.
 *
 * Long on purpose. This is a building and exploring game with survival in it, not a
 * game about drinking: a meter that demands attention every two minutes stops being
 * pressure and becomes a chore.
 */
const WATER_SECONDS = 900;
const FOOD_SECONDS = 1500;
/** Health lost per second while either meter is empty. */
const STARVE_RATE = 0.014;
/** Health regained per second while both meters are above a quarter. */
const HEAL_RATE = 0.008;

export interface Vitals {
  /** 0..1 each. */
  health: number;
  water: number;
  food: number;
}

type Listener = () => void;

export class Inventory {
  private readonly counts = new Map<ItemId, number>();
  private readonly listeners = new Set<Listener>();
  private readonly vitals: Vitals = { health: 1, water: 1, food: 1 };
  /** Accumulated fractional decay, so a slow drain is not lost to rounding. */
  private drained = 0;

  constructor() {
    this.load();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
    this.save();
  }

  /** How many of an item are held. */
  count(id: ItemId): number {
    return this.counts.get(id) ?? 0;
  }

  /** Every item held, in a stable order, for the grid. */
  entries(): { id: ItemId; count: number }[] {
    const out: { id: ItemId; count: number }[] = [];
    for (const [id, n] of this.counts) if (n > 0) out.push({ id, count: n });
    return out;
  }

  /** Distinct items held, which is what fills a slot. */
  used(): number {
    let n = 0;
    for (const v of this.counts.values()) if (v > 0) n++;
    return n;
  }

  /**
   * Adds items, returning how many actually fitted.
   *
   * Reports the shortfall rather than throwing or silently dropping it: the caller is
   * a pickup that has to decide whether the thing on the ground is now gone.
   */
  add(id: ItemId, n = 1): number {
    if (n <= 0) return 0;
    const have = this.count(id);
    if (have === 0 && this.used() >= SLOTS) return 0;
    const room = ITEMS[id].stack - have;
    const taken = Math.min(n, Math.max(0, room));
    if (taken === 0) return 0;
    this.counts.set(id, have + taken);
    this.changed();
    return taken;
  }

  /** Removes items. False and no change at all if there are not enough. */
  take(id: ItemId, n = 1): boolean {
    const have = this.count(id);
    if (have < n) return false;
    const left = have - n;
    if (left === 0) this.counts.delete(id);
    else this.counts.set(id, left);
    this.changed();
    return true;
  }

  /** True when the player holds a tool of this sort. */
  hasTool(kind: NonNullable<(typeof ITEMS)[ItemId]['tool']>): boolean {
    for (const [id, n] of this.counts) {
      if (n > 0 && ITEMS[id].tool === kind) return true;
    }
    return false;
  }

  /** Eats one of an item, if it is food and there is room to benefit. */
  eat(id: ItemId): boolean {
    const value = ITEMS[id].eat;
    if (!value || this.count(id) <= 0) return false;
    if (!this.take(id, 1)) return false;
    this.vitals.food = Math.min(1, this.vitals.food + value);
    this.changed();
    return true;
  }

  get state(): Readonly<Vitals> {
    return this.vitals;
  }

  /** Fills the water meter. Called while standing in water. */
  drink(): void {
    if (this.vitals.water > 0.995) return;
    this.vitals.water = Math.min(1, this.vitals.water + 0.5);
    this.changed();
  }

  /**
   * Advances the meters.
   *
   * Writes to storage at most once a second rather than on every frame: this runs
   * sixty times a second and `localStorage` is synchronous, so saving each time would
   * put a disk write in the frame loop.
   */
  tick(dt: number): void {
    const v = this.vitals;
    v.water = Math.max(0, v.water - dt / WATER_SECONDS);
    v.food = Math.max(0, v.food - dt / FOOD_SECONDS);
    if (v.water <= 0 || v.food <= 0) {
      v.health = Math.max(0, v.health - dt * STARVE_RATE);
    } else if (v.water > 0.25 && v.food > 0.25 && v.health < 1) {
      v.health = Math.min(1, v.health + dt * HEAL_RATE);
    }
    this.drained += dt;
    if (this.drained >= 1) {
      this.drained = 0;
      this.saveVitals();
      for (const fn of this.listeners) fn();
    }
  }

  private save(): void {
    try {
      const flat: Record<string, number> = {};
      for (const [id, n] of this.counts) if (n > 0) flat[id] = n;
      localStorage.setItem(KEY, JSON.stringify(flat));
    } catch {
      /* storage unavailable — the inventory simply will not persist */
    }
    this.saveVitals();
  }

  private saveVitals(): void {
    try {
      localStorage.setItem(VITALS_KEY, JSON.stringify(this.vitals));
    } catch {
      /* ignore */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const flat = JSON.parse(raw) as Record<string, number>;
        for (const [id, n] of Object.entries(flat)) {
          // Validated against the registry, not trusted: this is player-editable
          // text, and an unknown id or a silly count would otherwise reach the grid.
          if (!(id in ITEMS)) continue;
          const key = id as ItemId;
          const capped = Math.max(0, Math.min(ITEMS[key].stack, Math.floor(Number(n) || 0)));
          if (capped > 0) this.counts.set(key, capped);
        }
      }
      const rawV = localStorage.getItem(VITALS_KEY);
      if (rawV) {
        const v = JSON.parse(rawV) as Partial<Vitals>;
        const clamp = (x: unknown, fallback: number): number => {
          const n = Number(x);
          return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
        };
        this.vitals.health = clamp(v.health, 1);
        this.vitals.water = clamp(v.water, 1);
        this.vitals.food = clamp(v.food, 1);
      }
    } catch {
      /* corrupt or unreadable — start empty rather than refuse to load */
    }
  }
}

/**
 * The session's inventory.
 *
 * One per page, reached the way the game session is: the HUD, the world's pickups and
 * the crafting panel all have to be looking at the same bag, and they are created and
 * destroyed at different times.
 */
let shared: Inventory | null = null;

export function inventory(): Inventory {
  shared ??= new Inventory();
  return shared;
}
