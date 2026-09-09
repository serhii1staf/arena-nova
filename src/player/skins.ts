/**
 * The character library.
 *
 * One list, shared by the picker UI, the local avatar and the network — so a skin
 * id means the same thing to everyone and other players see the character you
 * actually chose. Ids go over the wire, so they are short and stable; renaming one
 * would silently fall back to the default for anybody on an older build, which is
 * why `resolveSkin` never throws.
 *
 * Models are loaded on demand and cached per file, so switching characters costs
 * one download the first time and nothing afterwards.
 */

export interface Skin {
  id: string;
  /** Shown in the menu. Kept short so the grid stays tidy. */
  label: string;
  /** Path under `public/models/`. */
  file: string;
}

export const SKINS: readonly Skin[] = [
  // The default deliberately points at the documented drop-in slot rather than a
  // second copy of the same mesh: replacing character.glb still swaps this entry,
  // and the repo does not carry the file twice.
  { id: 'captain', label: 'Captain', file: 'character.glb' },
  { id: 'anne', label: 'Anne', file: 'characters/anne.glb' },
  { id: 'henry', label: 'Henry', file: 'characters/henry.glb' },
  { id: 'mako', label: 'Mako', file: 'characters/mako.glb' },
  { id: 'sharky', label: 'Sharky', file: 'characters/sharky.glb' },
  { id: 'skeleton', label: 'Skeleton', file: 'characters/skeleton.glb' },
  { id: 'headless', label: 'Headless', file: 'characters/skeleton-headless.glb' },
];

export const DEFAULT_SKIN = SKINS[0]!.id;

const STORAGE_KEY = 'arena.skin';

/** Never throws and never returns null: an unknown id degrades to the default. */
export function resolveSkin(id: string | undefined): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS[0]!;
}

/** Path the loader should fetch for a skin id, relative to the document. */
export function skinModelPath(id: string | undefined): string {
  return `models/${resolveSkin(id).file}`;
}

export function savedSkin(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && SKINS.some((s) => s.id === v)) return v;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_SKIN;
}

export function saveSkin(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, resolveSkin(id).id);
  } catch {
    /* ignore */
  }
}
