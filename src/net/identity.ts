/**
 * Who the player is.
 *
 * One place, because the name is entered on the start screen, saved locally,
 * announced to the room, and shown back in the player list — four consumers that
 * would otherwise each have their own idea of what a valid name is.
 *
 * Names are sanitised on the way in as well as on the server. The server is the
 * one that matters for safety, but doing it here too means the player sees the
 * name they will actually get rather than being silently corrected later.
 */

const STORAGE_KEY = 'arena.name';

/** Longest name the UI can lay out, and what the server clamps to. */
export const MAX_NAME = 18;

const listeners = new Set<(name: string) => void>();

/**
 * Strips anything that would break a label or impersonate another player:
 * control characters, and runs of whitespace collapsed to single spaces.
 */
export function sanitiseName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

/** A friendly default so an empty field still produces something usable. */
export function suggestName(): string {
  return `Wanderer ${Math.floor(1000 + Math.random() * 9000)}`;
}

export function savedName(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v) {
      const clean = sanitiseName(v);
      if (clean) return clean;
    }
  } catch {
    /* storage unavailable */
  }
  return '';
}

/** Returns the stored name, or a generated one when nothing is stored yet. */
export function playerName(): string {
  return savedName() || suggestName();
}

export function saveName(raw: string): string {
  const clean = sanitiseName(raw) || suggestName();
  const previous = savedName();
  try {
    localStorage.setItem(STORAGE_KEY, clean);
  } catch {
    /* ignore */
  }
  if (clean !== previous) {
    for (const fn of [...listeners]) {
      try {
        fn(clean);
      } catch (err) {
        console.warn(`[identity] listener failed: ${String((err as Error)?.message ?? err)}`);
      }
    }
  }
  return clean;
}

export function onNameChange(fn: (name: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
