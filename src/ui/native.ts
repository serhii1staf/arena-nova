/**
 * Thin wrapper around the Tauri APIs.
 *
 * The same bundle ships to the browser and to the native shell, so every call
 * here degrades gracefully: in a plain browser `isNative()` is false and the
 * window/update helpers simply do nothing. Tauri modules are imported lazily so
 * the web build never pays for code it can't use.
 */

interface PhysicalPoint {
  x: number;
  y: number;
}

interface NativeWindowLike {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  setFullscreen(v: boolean): Promise<void>;
  isFullscreen(): Promise<boolean>;
  setCursorGrab(grab: boolean): Promise<void>;
  setCursorVisible(visible: boolean): Promise<void>;
  setCursorPosition(position: PhysicalPoint): Promise<void>;
  outerPosition(): Promise<PhysicalPoint>;
  /** Origin of the client area, which is what the cursor centre must be based on. */
  innerPosition(): Promise<PhysicalPoint>;
  innerSize(): Promise<{ width: number; height: number }>;
}

export interface PendingUpdate {
  version: string;
  /** Opaque handle from the updater plugin. */
  handle: unknown;
}

/** True when running inside the Tauri shell rather than a browser tab. */
export function isNative(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

let cachedWindow: NativeWindowLike | null = null;

/**
 * Returns a handle for controlling the native window. It resolves lazily on
 * first use; until the module has loaded, calls are queued as no-ops.
 */
export function nativeWindow(): NativeWindowLike | null {
  if (!isNative()) return null;
  if (cachedWindow) return cachedWindow;
  // Kick off the load; the first click may be a no-op, subsequent ones work.
  void import('@tauri-apps/api/window')
    .then((m) => {
      cachedWindow = m.getCurrentWindow() as unknown as NativeWindowLike;
    })
    .catch(() => {
      /* plugin unavailable */
    });
  return cachedWindow;
}

let PhysicalPositionCtor: (new (x: number, y: number) => PhysicalPoint) | null = null;

/** Eagerly warm up the window handle so the first menu click responds. */
export async function prepareNative(): Promise<void> {
  if (!isNative() || cachedWindow) return;
  try {
    const m = await import('@tauri-apps/api/window');
    cachedWindow = m.getCurrentWindow() as unknown as NativeWindowLike;
    const dpi = await import('@tauri-apps/api/dpi');
    PhysicalPositionCtor = dpi.PhysicalPosition as unknown as new (
      x: number,
      y: number,
    ) => PhysicalPoint;
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Native mouse capture
// ---------------------------------------------------------------------------
// WebView2 has no way to hide Chromium's "press Esc to show your cursor" banner
// (confirmed by Microsoft), and that banner is what makes the native build feel
// like a browser. So on desktop we skip the Pointer Lock API entirely: the OS
// cursor is hidden and confined to the window, and we recentre it whenever it
// drifts, which gives unlimited mouse travel with no browser UI at all.

let captureActive = false;
let warpPending = false;
let windowCentre: PhysicalPoint | null = null;
/**
 * When the outstanding warp stops being expected, as a `performance.now()` stamp.
 *
 * A deadline rather than a counter. A counter only goes back down when a landing
 * is positively identified, so any landing that is missed — coalesced by the OS,
 * or arriving a little outside the tolerance — left it permanently above zero, and
 * from then on every mouse event near the middle of the window was discarded as a
 * warp. The view would gradually stop responding in exactly the region the cursor
 * spends most of its time. A deadline cannot leak in either direction: an
 * unclaimed warp simply stops being expected.
 */
let warpExpectedUntil = 0;

/** How long a warp stays expected. Comfortably longer than the IPC round trip. */
const WARP_GRACE_MS = 250;

/** Hides and confines the OS cursor. Safe to call repeatedly. */
export async function beginNativeMouseCapture(): Promise<void> {
  const win = cachedWindow;
  if (!isNative() || !win || captureActive) return;
  captureActive = true;
  try {
    await win.setCursorVisible(false);
    await win.setCursorGrab(true);
    await recentreNativeCursor(true);
  } catch {
    captureActive = false;
  }
}

/** Restores the cursor so the player can use the menu. */
export async function endNativeMouseCapture(): Promise<void> {
  const win = cachedWindow;
  if (!isNative() || !win || !captureActive) return;
  captureActive = false;
  try {
    await win.setCursorGrab(false);
    await win.setCursorVisible(true);
  } catch {
    /* ignore */
  }
}

export function isNativeMouseCaptured(): boolean {
  return captureActive;
}

/**
 * Warps the cursor back to the middle of the window. Throttled to one in-flight
 * request, and the window geometry is cached briefly, so this stays cheap enough
 * to call from mouse-move handling.
 */
export async function recentreNativeCursor(force = false): Promise<void> {
  const win = cachedWindow;
  if (!win || !PhysicalPositionCtor) return;
  if (warpPending && !force) return;
  warpPending = true;
  try {
    // The target comes from the DOM, not from the window API.
    //
    // `screenX/screenY` are the viewport's own position on the desktop and
    // `innerWidth/innerHeight` its size, both in CSS pixels; scaling by the
    // device pixel ratio gives the physical point `setCursorPosition` expects.
    //
    // This replaced `innerPosition() + innerSize()/2`, which was wrong for a
    // windowed app and only *looked* right in fullscreen — there the window
    // origin is (0,0), so any error in the origin cancels out. That is precisely
    // the reported symptom: the camera turned freely in fullscreen and jammed in
    // a window. Reading the DOM also needs no IPC and no capability, so it can
    // neither be denied nor go stale between frames.
    const ratio = window.devicePixelRatio || 1;
    windowCentre = {
      x: Math.round((window.screenX + window.innerWidth / 2) * ratio),
      y: Math.round((window.screenY + window.innerHeight / 2) * ratio),
    };
    // Announce the warp *before* it happens. Moving the OS cursor generates a
    // real WM_MOUSEMOVE, and because this path deliberately avoids Pointer Lock
    // there is nothing to distinguish it from the player's own movement — so the
    // input layer has to be told to expect it and throw it away.
    warpExpectedUntil = performance.now() + WARP_GRACE_MS;
    await win.setCursorPosition(new PhysicalPositionCtor(windowCentre.x, windowCentre.y));
  } catch {
    warpExpectedUntil = 0;
    /* window moved or permission missing — ignore */
  } finally {
    warpPending = false;
  }
}

/**
 * Claims one expected warp-induced mouse move.
 *
 * Without this the camera could not turn at all in the native build: every warp
 * fed a large delta pointing back to the centre, so the accumulated yaw was
 * pinned to wherever the cursor happened to sit inside the window. Pushing right
 * hit the margin and got snapped back — which is why it read as "the camera keeps
 * twisting to the left".
 */
export function claimCursorWarp(): boolean {
  if (!hasPendingCursorWarp()) return false;
  warpExpectedUntil = 0;
  return true;
}

/** True when a warp has been issued and its mouse event has not arrived yet. */
export function hasPendingCursorWarp(): boolean {
  return performance.now() < warpExpectedUntil;
}

/** Invalidate the cached window centre (call when the window moves/resizes). */
export function invalidateWindowCentre(): void {
  windowCentre = null;
}

// ---------------------------------------------------------------------------
// Frame pacing
// ---------------------------------------------------------------------------

/**
 * Stores the frame-pacing choice for the *next* launch. Uncapping needs Chromium
 * flags that can only be set before the webview starts, so this can't take effect
 * immediately — the caller should tell the player a restart is required.
 */
export async function setNativeFpsMode(mode: 'vsync' | 'unlimited'): Promise<void> {
  if (!isNative()) return;
  try {
    const core = await import('@tauri-apps/api/core');
    await core.invoke('set_fps_mode', { mode });
  } catch {
    /* command unavailable — the in-engine limiter still applies */
  }
}

// ---------------------------------------------------------------------------
// Fullscreen
// ---------------------------------------------------------------------------

/** Toggles real fullscreen: the OS window natively, the Fullscreen API on web. */
export async function toggleFullscreen(): Promise<boolean> {
  const win = cachedWindow;
  if (isNative() && win) {
    try {
      const now = await win.isFullscreen();
      await win.setFullscreen(!now);
      invalidateWindowCentre();
      return !now;
    } catch {
      return false;
    }
  }
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return false;
    }
    await document.documentElement.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}

/** Looks for a newer release. Returns null when already current. */
export async function checkForUpdate(): Promise<PendingUpdate | null> {
  if (!isNative()) return null;
  const mod = await import('@tauri-apps/plugin-updater');
  const update = await mod.check();
  if (!update) return null;
  return { version: update.version, handle: update };
}

/** Downloads and installs a pending update, then relaunches the app. */
export async function installUpdate(
  pending: PendingUpdate,
  onProgress?: (percent: number) => void,
): Promise<void> {
  if (!isNative()) return;
  const update = pending.handle as {
    downloadAndInstall(cb?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void): Promise<void>;
  };
  let total = 0;
  let received = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data?.contentLength ?? 0;
      onProgress?.(0);
    } else if (event.event === 'Progress') {
      received += event.data?.chunkLength ?? 0;
      if (total > 0) onProgress?.(Math.min(100, Math.round((received / total) * 100)));
    } else if (event.event === 'Finished') {
      onProgress?.(100);
    }
  });
  const process = await import('@tauri-apps/plugin-process');
  await process.relaunch();
}
