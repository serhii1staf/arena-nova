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
const OWNER_KEY = 'arena.owner';

/** Longest name the UI can lay out, and what the server clamps to. */
export const MAX_NAME = 18;

/**
 * A stable per-install token, used only to prove continuity of *this* install
 * across reconnects.
 *
 * The reserved name is meant to stay with whoever claimed it, which means the
 * server has to recognise that claimant again on a later connection. It used to
 * remember the connection id, which is generated fresh for every socket — so the
 * name could be claimed exactly once per room, ever, and after that even its
 * owner was refused. This is the missing half: something that survives a reload.
 *
 * It is not a password and it is not asked for. It identifies an install, and it
 * only ever matters for the one reserved name; every other name is first-come and
 * ignores it entirely.
 */
export function ownerToken(): string {
  try {
    const existing = localStorage.getItem(OWNER_KEY);
    // Length-checked rather than merely present: the value has to be long enough
    // to be worth treating as an identity, and this also rejects anything left
    // over from an earlier, shorter scheme.
    if (existing && existing.length >= 32) return existing;
  } catch {
    /* storage unavailable */
  }
  const fresh = mintToken();
  try {
    localStorage.setItem(OWNER_KEY, fresh);
  } catch {
    /* ignore: a session with no storage simply cannot hold the reserved name */
  }
  return fresh;
}

const ADMIN_PASS_KEY = 'arena.adminPass';

/**
 * The admin password this install will present, or an empty string.
 *
 * Stored locally so it is typed once rather than on every launch, which is what
 * makes it usable at all — it is long by design. It is only ever *sent*: nothing
 * reads it back to decide anything, because a client deciding its own rights is a
 * suggestion rather than a permission. The server compares it against a secret it
 * alone holds and answers in `welcome`.
 */
export function adminPassword(): string {
  try {
    return localStorage.getItem(ADMIN_PASS_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Saves the password, or clears it when given something blank. */
export function saveAdminPassword(raw: string): void {
  const clean = raw.trim();
  try {
    if (clean) localStorage.setItem(ADMIN_PASS_KEY, clean);
    else localStorage.removeItem(ADMIN_PASS_KEY);
  } catch {
    /* storage unavailable — the password simply will not persist */
  }
}

/** 32 hex characters, from the platform CSPRNG where there is one. */
function mintToken(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID().replace(/-/g, '') + c.randomUUID().replace(/-/g, '');
  }
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(24);
    c.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Last resort. Weak, and only reached on a platform with no crypto at all.
  let out = '';
  while (out.length < 48) out += Math.random().toString(16).slice(2);
  return out.slice(0, 48);
}

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
