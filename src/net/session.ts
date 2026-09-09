import { NetworkManager } from './NetworkManager.ts';
import { defaultPlayerName, roomSocketUrl } from './endpoint.ts';
import { onSkinChange, savedSkin } from '../player/skins.ts';

/**
 * The one network session for the whole game.
 *
 * It has to outlive scenes. Each scene used to own its own `NetworkManager`, so
 * stepping through the portal tore the socket down and built a new one — you
 * dropped out of the room on every transition and nobody in the open world could
 * see anybody. The session is therefore module-level, and scenes borrow it.
 */
let shared: NetworkManager | null = null;
let connecting = false;
let unsubscribeSkin: (() => void) | null = null;

export function gameSession(): NetworkManager {
  if (!shared) {
    shared = new NetworkManager();
    // Re-announce when the player picks a different character, so the room sees
    // the change straight away. `join` is the same message used at connect time
    // and the server treats it as an identity update, so no new protocol is
    // needed and a client that never changes skin behaves exactly as before.
    unsubscribeSkin = onSkinChange((id) => {
      if (shared?.isOnline) shared.join(defaultPlayerName(), id);
    });
  }
  return shared;
}

/**
 * Connects once, idempotently. Deliberately not awaited by callers: the game must
 * be playable on the first frame whether or not the server can be reached, and a
 * failure just leaves the offline transport in place.
 */
export function ensureConnected(): void {
  const net = gameSession();
  if (connecting || net.isOnline) return;
  connecting = true;
  void net
    .connect(roomSocketUrl())
    .then(() => net.join(defaultPlayerName(), savedSkin()))
    .catch(() => {
      /* offline or unreachable — carry on single-player */
    })
    .finally(() => {
      connecting = false;
    });
}

/** Only for teardown of the whole game, not for scene switches. */
export function disposeSession(): void {
  unsubscribeSkin?.();
  unsubscribeSkin = null;
  shared?.dispose();
  shared = null;
  connecting = false;
}
