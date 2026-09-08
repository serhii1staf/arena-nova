/**
 * Thin wrapper around the Tauri APIs.
 *
 * The same bundle ships to the browser and to the native shell, so every call
 * here degrades gracefully: in a plain browser `isNative()` is false and the
 * window/update helpers simply do nothing. Tauri modules are imported lazily so
 * the web build never pays for code it can't use.
 */

interface NativeWindowLike {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  setFullscreen(v: boolean): Promise<void>;
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

/** Eagerly warm up the window handle so the first menu click responds. */
export async function prepareNative(): Promise<void> {
  if (!isNative() || cachedWindow) return;
  try {
    const m = await import('@tauri-apps/api/window');
    cachedWindow = m.getCurrentWindow() as unknown as NativeWindowLike;
  } catch {
    /* ignore */
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
