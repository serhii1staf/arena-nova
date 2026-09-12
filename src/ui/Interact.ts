/**
 * Interact
 * --------
 * One prompt under the crosshair, and one key that answers it.
 *
 * There is exactly one thing E does at any moment, so there is exactly one place that
 * decides what that is. The alternative — a door prompt owned by the hotbar and a
 * pickup prompt owned by something else — puts two labels on screen at once the moment
 * you stand next to both, and gives two listeners a claim on the same keypress.
 *
 * The scene decides, because the scene is the only thing that knows what is nearby. It
 * writes the label each frame and asks whether the key was pressed; this module owns
 * the element and the listener and nothing else.
 */

let hint: HTMLElement | null = null;
let shown = '';
let pressed = false;
let wired = false;

export function initInteract(): void {
  if (wired) return;
  wired = true;
  hint = document.getElementById('interactHint');
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyE' || e.repeat) return;
    const target = e.target as HTMLElement | null;
    if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
    // Only claimed when something is actually on offer, so E stays free for anything
    // else to use when there is nothing in reach.
    if (shown === '') return;
    e.preventDefault();
    pressed = true;
  });
}

/** Sets the label, or clears it with `null`. Safe to call every frame. */
export function setPrompt(text: string | null): void {
  const next = text ?? '';
  if (next === shown) return;
  shown = next;
  if (!hint) return;
  hint.textContent = next;
  hint.hidden = next === '';
}

/** True once per press. The caller acts on it and it is forgotten. */
export function consumeUse(): boolean {
  const p = pressed;
  pressed = false;
  return p;
}
