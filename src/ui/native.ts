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
let centreValidUntil = 0;

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
    const now = performance.now();
    if (!windowCentre || now > centreValidUntil) {
      const [pos, size] = await Promise.all([win.outerPosition(), win.innerSize()]);
      windowCentre = {
        x: Math.round(pos.x + size.width / 2),
        y: Math.round(pos.y + size.height / 2),
      };
      centreValidUntil = now + 1000; // re-measure at most once a second
    }
    await win.setCursorPosition(new PhysicalPositionCtor(windowCentre.x, windowCentre.y));
  } catch {
    /* window moved or permission missing — ignore */
  } finally {
    warpPending = false;
  }
}

/** Invalidate the cached window centre (call when the window moves/resizes). */
export function invalidateWindowCentre(): void {
  windowCentre = null;
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
