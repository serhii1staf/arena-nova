/**
 * Where the multiplayer server lives.
 *
 * The same build runs from three very different origins — a public https host, a
 * local dev server, and a `tauri://` origin inside the desktop app — and only the
 * first one can derive the socket URL from the page it was served by. The other
 * two fall back to the deployed Worker, which is also what makes the native app
 * and the browser meet in the same room.
 */

import { isNative } from '../ui/native.ts';

/** The deployed Worker. Same origin serves the game and the rooms. */
const PUBLIC_HOST = 'arena-nova.odi44972.workers.dev';

/** Rooms are named, so sharing a name is how friends end up together. */
export const DEFAULT_ROOM = 'main';

function servedOverHttp(): boolean {
  const p = location.protocol;
  return p === 'https:' || p === 'http:';
}

/**
 * True when the page is not being served by anything that could also host the
 * rooms.
 *
 * The desktop app is the reason this is not just a protocol check: Tauri v2 on
 * Windows serves the app over `http://tauri.localhost`, so it looks like an
 * ordinary web origin. Treating it as one made the native build dial
 * `ws://tauri.localhost/ws` — itself — and silently fail, which is why players in
 * the app could never see each other while the browser worked fine.
 */
function cannotHostRooms(): boolean {
  if (isNative()) return true;
  if (!servedOverHttp()) return true;
  const h = location.hostname;
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '[::1]' ||
    h === '' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local')
  );
}

/**
 * WebSocket URL for a room. Honours `?room=` in the address bar so two browser
 * tabs can be put in different rooms for testing.
 */
export function roomSocketUrl(room?: string): string {
  let name = room;
  if (!name && servedOverHttp()) {
    name = new URLSearchParams(location.search).get('room') ?? undefined;
  }
  const target = (name ?? DEFAULT_ROOM).slice(0, 40);

  // Desktop app, file://, or a dev server — none of them host rooms, so use the
  // public Worker. That is also what puts the app and the browser in one room.
  if (cannotHostRooms()) {
    return `wss://${PUBLIC_HOST}/ws?room=${encodeURIComponent(target)}`;
  }

  // Served by the Worker itself: talk to the same origin.
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws?room=${encodeURIComponent(target)}`;
}

/** A short, human-readable default name so players are distinguishable. */
export function defaultPlayerName(): string {
  try {
    const saved = localStorage.getItem('arena.playerName');
    if (saved) return saved;
  } catch {
    /* storage unavailable */
  }
  const n = `Player-${Math.floor(Math.random() * 9000 + 1000)}`;
  try {
    localStorage.setItem('arena.playerName', n);
  } catch {
    /* ignore */
  }
  return n;
}
