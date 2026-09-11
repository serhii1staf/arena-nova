import { NetworkManager } from './NetworkManager.ts';
import { roomSocketUrl } from './endpoint.ts';
import { onAdminPasswordChange, onNameChange, playerName } from './identity.ts';
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
let unsubscribeName: (() => void) | null = null;
let unsubscribeState: (() => void) | null = null;
let unsubscribePass: (() => void) | null = null;

export function gameSession(): NetworkManager {
  if (!shared) {
    shared = new NetworkManager();
    // Re-announce when the player picks a different character, so the room sees
    // the change straight away. `join` is the same message used at connect time
    // and the server treats it as an identity update, so no new protocol is
    // needed and a client that never changes skin behaves exactly as before.
    // The name is announced the same way, so editing it on the start screen or
    // later is reflected in the room without a reconnect.
    unsubscribeName = onNameChange((name) => {
      if (shared?.isOnline) shared.join(name, savedSkin());
    });
    unsubscribeSkin = onSkinChange((id) => {
      if (shared?.isOnline) shared.join(playerName(), id);
    });
    // Re-announce whenever the connection comes up, not only on the first connect.
    //
    // `ensureConnected` sends `join` once, and returns early ever after because the
    // session is already online — so a socket that dropped and came back left the
    // server holding its defaults for this player. Nothing local looked wrong,
    // because the local row is drawn from local state; it was everyone *else* who
    // saw the wrong character, which is why it read as "some players see everybody
    // wearing the same skin". Identity is cheap to repeat and the server treats a
    // second `join` as an update, so the fix is simply to stop assuming once.
    // The admin password is typed on the start screen, which is up *after* the
    // session has already connected and announced itself — so without this the
    // server never learns it and the panel never opens.
    unsubscribePass = onAdminPasswordChange(() => {
      if (shared?.isOnline) shared.join(playerName(), savedSkin());
    });
    unsubscribeState = shared.onStateChange((state) => {
      if (state === 'online') shared?.join(playerName(), savedSkin());
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
    .then(() => net.join(playerName(), savedSkin()))
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
  unsubscribeName?.();
  unsubscribeName = null;
  unsubscribeState?.();
  unsubscribeState = null;
  unsubscribePass?.();
  unsubscribePass = null;
  shared?.dispose();
  shared = null;
  connecting = false;
}
