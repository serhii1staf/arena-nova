/**
 * PropRegistry
 * ------------
 * Spatial hash of everything solid or climbable in the streamed world. Chunks
 * register their props on load and drop them on unload, so collision queries
 * only ever touch what is actually nearby — the cost stays flat no matter how
 * large the world gets.
 */

export interface Prop {
  x: number;
  z: number;
  /** Horizontal radius. */
  r: number;
  /** World height of the walkable top (used to stand on rocks and logs). */
  top: number;
  /** Blocks movement at body height (trunks, boulders). */
  solid: boolean;
}

const CELL = 16;

export class PropRegistry {
  private readonly cells = new Map<string, Prop[]>();
  /** Props grouped by owning chunk so they can be removed together. */
  private readonly byOwner = new Map<string, Prop[]>();

  private static cellKey(cx: number, cz: number): string {
    return `${cx}|${cz}`;
  }

  add(owner: string, prop: Prop): void {
    const key = PropRegistry.cellKey(Math.floor(prop.x / CELL), Math.floor(prop.z / CELL));
    let list = this.cells.get(key);
    if (!list) this.cells.set(key, (list = []));
    list.push(prop);

    let owned = this.byOwner.get(owner);
    if (!owned) this.byOwner.set(owner, (owned = []));
    owned.push(prop);
  }

  /** Removes every prop registered by a chunk. */
  removeOwner(owner: string): void {
    const owned = this.byOwner.get(owner);
    if (!owned) return;
    const doomed = new Set(owned);
    // Only touch the cells the chunk could have written to.
    for (const prop of owned) {
      const key = PropRegistry.cellKey(Math.floor(prop.x / CELL), Math.floor(prop.z / CELL));
      const list = this.cells.get(key);
      if (!list) continue;
      const kept = list.filter((p) => !doomed.has(p));
      if (kept.length) this.cells.set(key, kept);
      else this.cells.delete(key);
    }
    this.byOwner.delete(owner);
  }

  /** Visits every prop in the 3×3 cell neighbourhood of a point. */
  forEachNear(x: number, z: number, fn: (p: Prop) => void): void {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const list = this.cells.get(PropRegistry.cellKey(cx + ox, cz + oz));
        if (!list) continue;
        for (const p of list) fn(p);
      }
    }
  }

  clear(): void {
    this.cells.clear();
    this.byOwner.clear();
  }

  get size(): number {
    return this.byOwner.size;
  }
}
