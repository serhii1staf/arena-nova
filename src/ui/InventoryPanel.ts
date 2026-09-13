import { SLOTS, inventory } from '../game/Inventory.ts';
import type { Engine } from '../core/Engine.ts';
import { savedName } from '../net/identity.ts';
import { ITEMS, ITEM_ORDER, itemGeometry, type ItemId } from '../game/Items.ts';
import { RECIPES, blockedBy, craft, recommended, type Recipe } from '../game/Recipes.ts';
import { savedSkin } from '../player/skins.ts';
import { renderIcons } from './IconRenderer.ts';
import { bodyFor } from './Portraits.ts';
import { t } from './i18n.ts';

/**
 * InventoryPanel
 * --------------
 * What you are carrying, how you are doing, and what you could make.
 *
 * Opened with I. Three columns, because they answer three different questions and
 * putting them in one list would make all three harder to read: the bag on the left,
 * the recipes in the middle, and the player themself on the right with their meters
 * under them.
 *
 * Icons are 3D renders of the same geometry the world drops, taken once for the
 * session — the shared renderer does the batch and hands the context straight back.
 * The panel itself does no per-frame work at all: it redraws when the inventory
 * changes, when it opens, and when the player walks in or out of range of a bench.
 * A panel that rebuilt sixty times a second would be the most expensive thing on
 * screen while doing nothing.
 */

/** How long a craft takes to sweep its bar, matching the recipe's own seconds. */
interface Progress {
  recipe: Recipe;
  until: number;
  from: number;
}

export class InventoryPanel {
  private readonly engine: Engine;
  private readonly root: HTMLElement | null;
  private readonly grid: HTMLElement | null;
  private readonly list: HTMLElement | null;
  private readonly face: HTMLImageElement | null;
  private readonly bars: Record<'health' | 'water' | 'food', HTMLElement | null>;
  private readonly hint: HTMLElement | null;
  private open = false;
  private icons = new Map<ItemId, string>();
  /** Whether a bench was in range when the panel was last drawn. */
  private benchShown = false;
  private atBench = false;
  private progress: Progress | null = null;
  /** Set by the scene each frame; the panel never reaches into the world itself. */
  private benchProbe: (() => boolean) | null = null;
  private benchPlacer: (() => boolean) | null = null;
  /** Which character the figure on screen is of, so a change is noticed. */
  private shownSkin: string | null = null;

  constructor(engine: Engine) {
    this.engine = engine;
    this.root = document.getElementById('inventory');
    this.grid = document.getElementById('invGrid');
    this.list = document.getElementById('invRecipes');
    this.face = document.getElementById('invFace') as HTMLImageElement | null;
    this.hint = document.getElementById('invHint');
    this.bars = {
      health: document.getElementById('barHealth'),
      water: document.getElementById('barWater'),
      food: document.getElementById('barFood'),
    };

    inventory().onChange(() => {
      if (this.open) this.draw();
    });

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      if (e.code === 'KeyI') {
        e.preventDefault();
        this.toggle();
        return;
      }
      // Escape shuts the panel rather than falling through to the pause menu, which
      // is what you expect from the top-most thing on screen.
      if (e.code === 'Escape' && this.open) {
        e.stopPropagation();
        e.preventDefault();
        this.setOpen(false);
      }
    });
  }

  /** The scene tells the panel how to ask whether a bench is in reach. */
  setBenchProbe(fn: (() => boolean) | null): void {
    this.benchProbe = fn;
  }

  /** And how to put one down, since only the scene knows where "in front" is. */
  setBenchPlacer(fn: (() => boolean) | null): void {
    this.benchPlacer = fn;
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  private setOpen(on: boolean): void {
    this.open = on;
    this.root?.classList.toggle('on', on);
    // The cursor comes back on its own, and goes away again on close.
    //
    // A panel full of things to click, opened by a key, with the mouse still captured by
    // the game is a panel you cannot use — you had to know to press Alt as well. The
    // pause menu has always done this; there was no reason this did not.
    const input = this.engine.input;
    if (on !== input.isCursorFreed) input.toggleCursor();
    if (on) {
      this.paintIcons();
      this.draw();
    }
  }

  /**
   * Called once a frame from the HUD pass.
   *
   * Almost nothing on purpose. The meters move continuously so they are written when
   * they change by enough to see, and the recipe list is rebuilt only when walking
   * into or out of a bench's range changes what is possible.
   */
  update(): void {
    this.atBench = this.benchProbe?.() ?? false;
    if (!this.open) return;
    if (this.atBench !== this.benchShown) this.draw();
    // And the states are reconciled every frame regardless.
    //
    // Relying on the flag above alone was wrong: it only fires on the frame the bench
    // range changes, so anything that made a recipe available or unavailable without
    // crossing that boundary — a stack running out, a craft completing — left the rows
    // saying otherwise. This is a handful of class writes against values already
    // computed, so there is no reason not to simply be correct.
    this.refreshRecipeStates();
    this.drawBars();
    this.drawFace();
    this.drawProgress();
  }

  /** Re-marks each recipe row as available or not, without rebuilding the list. */
  private refreshRecipeStates(): void {
    if (!this.list) return;
    const inv = inventory();
    for (const row of this.list.querySelectorAll<HTMLButtonElement>('.invRecipe')) {
      const r = RECIPES.find((x) => x.id === row.dataset.recipe);
      if (!r) continue;
      const blocked = blockedBy(r, inv, this.atBench);
      row.classList.toggle('blocked', blocked !== null);
      row.disabled = blocked !== null || this.progress !== null;
      const tag = row.querySelector<HTMLElement>('.invRecipeTag');
      if (tag) {
        const text = blocked === 'bench' ? t('inv.needBench') : r.bench ? t('inv.bench') : t('inv.hand');
        if (tag.textContent !== text) tag.textContent = text;
      }
      // Held-against-required moves as materials do, so the numbers are never stale.
      const needs = row.querySelector<HTMLElement>('.invRecipeNeeds');
      if (needs) {
        const text = r.needs
          .map((nd) => `${t(`item.${nd.id}`)} ${inv.count(nd.id)}/${nd.count}`)
          .join(' · ');
        if (needs.textContent !== text) needs.textContent = text;
      }
    }
  }

  /**
   * Puts the player's own face in the panel, retrying until it exists.
   *
   * Portraits are rendered off the frame loop, once per character, the first time one
   * is asked for — so the first open of the panel almost always asks before there is
   * anything to show. Setting it only while redrawing meant the space stayed empty
   * until something else happened to trigger a redraw, which for a panel that redraws
   * on change could be never.
   */
  private drawFace(): void {
    if (!this.face) return;
    const want = savedSkin();
    // Keyed on which character it is showing, not merely on whether it is showing
    // something. Bailing out as soon as a picture existed meant the first character ever
    // drawn stayed there for the session — so after changing character the panel showed
    // somebody else, which is exactly what it looked like.
    if (this.shownSkin === want) return;
    // The whole figure, not a head crop blown up to fill the column.
    const url = bodyFor(want);
    if (!url) return;
    this.face.src = url;
    this.face.hidden = false;
    this.shownSkin = want;
  }

  private paintIcons(): void {
    if (this.icons.size > 0) return;
    const order = ITEM_ORDER;
    // One batch, one context, one release. Fitted per item rather than to a shared
    // frame: a log and a berry differ by an order of magnitude in size, and a frame
    // that suits one leaves the other a dot.
    const urls = renderIcons(
      order.map((id) => itemGeometry(id)),
      { size: 64 },
    );
    order.forEach((id, i) => {
      const url = urls[i];
      if (url) this.icons.set(id, url);
    });
  }

  private drawBars(): void {
    const v = inventory().state;
    for (const [key, el] of Object.entries(this.bars) as [keyof typeof this.bars, HTMLElement | null][]) {
      if (!el) continue;
      const pct = `${Math.round(v[key] * 100)}%`;
      if (el.style.width !== pct) el.style.width = pct;
    }
  }

  private drawProgress(): void {
    const p = this.progress;
    if (!p) return;
    const now = performance.now();
    if (now >= p.until) {
      this.progress = null;
      // Checked again at the moment it completes, not only when it started: you can
      // walk away from a bench mid-craft, and the materials should not vanish into a
      // recipe that is no longer allowed.
      craft(p.recipe, inventory(), this.atBench);
      this.draw();
      return;
    }
    const el = this.list?.querySelector<HTMLElement>(`[data-recipe="${p.recipe.id}"] .invBarFill`);
    if (el) {
      const f = (now - p.from) / (p.until - p.from);
      el.style.width = `${Math.round(f * 100)}%`;
    }
  }

  private draw(): void {
    const inv = inventory();
    this.benchShown = this.atBench;

    // --- The bag ---
    if (this.grid) {
      const held = ITEM_ORDER.filter((id) => inv.count(id) > 0);
      // Every slot, not only the full ones. An inventory that shrinks to fit what is in
      // it cannot answer the question you actually open it to ask, which is how much
      // room is left.
      const cells: HTMLElement[] = held.map((id) => {
          const cell = document.createElement('div');
          cell.className = 'invCell';
          cell.title = t(`item.${id}`);
          const url = this.icons.get(id);
          if (url) {
            const img = document.createElement('img');
            img.className = 'invIcon';
            img.src = url;
            img.alt = '';
            cell.appendChild(img);
          }
          const n = document.createElement('span');
          n.className = 'invCount';
          n.textContent = String(inv.count(id));
          const name = document.createElement('span');
          name.className = 'invName';
          name.textContent = t(`item.${id}`);
          cell.append(n, name);
          // Clicking is the only verb an item has, and what it means depends on the
          // item: food is eaten, a workbench is put down. Both are marked so the cell
          // shows it can be clicked at all, because an affordance nobody notices is
          // the same as not having one.
          if (ITEMS[id].eat) {
            cell.classList.add('edible');
            cell.title = `${t(`item.${id}`)} — ${t('inv.eat')}`;
            cell.addEventListener('click', () => {
              if (inv.eat(id)) this.engine.audio?.eat();
              this.draw();
            });
          } else if (id === 'workbench') {
            cell.classList.add('placeable');
            cell.title = `${t(`item.${id}`)} — ${t('inv.place')}`;
            cell.addEventListener('click', () => {
              // Taken only if it actually went down. Somewhere blocked leaves it in
              // the bag rather than consuming it into nothing.
              if (this.benchPlacer?.() !== true) return;
              inv.take('workbench', 1);
              this.setOpen(false);
            });
          }
          return cell;
      });
      for (let i = held.length; i < SLOTS; i++) {
        const blank = document.createElement('div');
        blank.className = 'invCell empty';
        cells.push(blank);
      }
      this.grid.replaceChildren(...cells);
    }

    // --- Recipes, the ones you can make first ---
    if (this.list) {
      this.list.replaceChildren(
        ...recommended(inv, this.atBench).map(({ r, blocked }) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'invRecipe';
          row.dataset.recipe = r.id;
          if (blocked) row.classList.add('blocked');
          row.disabled = blocked !== null || this.progress !== null;

          const icon = document.createElement('img');
          icon.className = 'invRecipeIcon';
          const url = this.icons.get(r.out);
          if (url) icon.src = url;
          icon.alt = '';

          const text = document.createElement('span');
          text.className = 'invRecipeText';
          const title = document.createElement('span');
          title.className = 'invRecipeName';
          title.textContent = `${t(`item.${r.out}`)}${r.count > 1 ? ` ×${r.count}` : ''}`;
          const needs = document.createElement('span');
          needs.className = 'invRecipeNeeds';
          // Each ingredient shows held against required, so a shortfall is visible
          // without opening anything else.
          needs.textContent = r.needs
            .map((nd) => `${t(`item.${nd.id}`)} ${inv.count(nd.id)}/${nd.count}`)
            .join(' · ');
          text.append(title, needs);

          const tag = document.createElement('span');
          tag.className = 'invRecipeTag';
          tag.textContent = blocked === 'bench' ? t('inv.needBench') : r.bench ? t('inv.bench') : t('inv.hand');

          const bar = document.createElement('span');
          bar.className = 'invBar';
          const fill = document.createElement('span');
          fill.className = 'invBarFill';
          bar.appendChild(fill);

          row.append(icon, text, tag, bar);
          row.addEventListener('click', () => this.begin(r));
          return row;
        }),
      );
    }

    // --- The player ---
    this.drawFace();
    if (this.hint) this.hint.textContent = this.atBench ? t('inv.atBench') : t('inv.noBench');
    // How full the bag is, which is the one number the grid cannot show by itself.
    const slots = document.getElementById('invSlots');
    if (slots) slots.textContent = `${inv.used()} / ${SLOTS}`;
    const who = document.getElementById('invWho');
    if (who) who.textContent = savedName();
    this.drawBars();
  }

  private begin(r: Recipe): void {
    if (this.progress) return;
    if (RECIPES.indexOf(r) < 0) return;
    const now = performance.now();
    this.progress = { recipe: r, from: now, until: now + r.seconds * 1000 };
    this.draw();
  }
}
