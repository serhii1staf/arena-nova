import { Engine } from './core/Engine.ts';
import { LobbyScene } from './scenes/LobbyScene.ts';
import { ExteriorScene } from './scenes/ExteriorScene.ts';
import { GameUI } from './ui/GameUI.ts';
import { invalidateWindowCentre, prepareNative } from './ui/native.ts';
import { applyTranslations, t } from './ui/i18n.ts';

/**
 * Bootstraps the game: builds the engine, loads the lobby while the start screen
 * is up, then hands control to GameUI (start screen → play → Escape menu).
 */

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

const app = $('app');
const hint = $('hint');
const stats = $('stats');
const fade = $('fade');

/*
 * Transition indicator. Revealed only once the image has actually decoded, so a
 * missing or broken file leaves the plain dark screen instead of a broken-image
 * icon. It sits inside #fade and inherits its opacity, so it appears and
 * disappears with the screen without a second animation to keep in sync.
 */
const fadeIcon = $<HTMLImageElement>('fadeIcon');
if (fadeIcon) {
  const reveal = (): void => fadeIcon.classList.add('ready');
  if (fadeIcon.complete && fadeIcon.naturalWidth > 0) reveal();
  else {
    fadeIcon.addEventListener('load', reveal, { once: true });
    fadeIcon.addEventListener('error', () => fadeIcon.remove(), { once: true });
  }
}

function fail(message: string): void {
  const hintEl = $('startHint');
  const btn = $<HTMLButtonElement>('btnPlay');
  if (hintEl) {
    delete hintEl.dataset.i18n;
    hintEl.textContent = message;
    hintEl.style.color = '#ff9b9b';
  }
  if (btn) {
    delete btn.dataset.i18n;
    btn.textContent = t('start.unavailable');
    btn.disabled = true;
  }
  console.error('[Arena Nova]', message);
}

async function boot(): Promise<void> {
  applyTranslations();

  if (!app) {
    fail(t('err.container'));
    return;
  }

  // Fail early and clearly if the browser has no WebGL.
  try {
    const probe = document.createElement('canvas');
    if (!(probe.getContext('webgl2') ?? probe.getContext('webgl'))) {
      fail(t('err.noWebgl'));
      return;
    }
  } catch {
    fail(t('err.noWebgl'));
    return;
  }

  // The native mouse-capture helpers need the window handle ready before play.
  await prepareNative();
  // Moving or resizing invalidates the cached centre used for cursor warping.
  window.addEventListener('resize', invalidateWindowCentre);

  let engine: Engine;
  try {
    engine = new Engine({
      container: app,
      onStats: (text) => {
        if (stats) stats.textContent = text;
      },
      onTransition: (phase) => {
        if (!fade) return;
        if (phase === 'out') fade.classList.add('on');
        else requestAnimationFrame(() => fade.classList.remove('on'));
      },
    });
  } catch (err) {
    fail(`Renderer init failed: ${(err as Error).message}`);
    return;
  }

  engine.registerScene('lobby', () => new LobbyScene());
  engine.registerScene('exterior', () => new ExteriorScene());

  const ui = new GameUI(engine);
  ui.setLoadingStatus('start.growing');

  try {
    // Yield once so the start screen paints before the heavy world build.
    await new Promise((r) => setTimeout(r, 30));
    await engine.start('lobby');
  } catch (err) {
    fail(`Failed to build the world: ${(err as Error).message}`);
    console.error(err);
    return;
  }

  ui.markReady();

  if (hint) {
    const key = engine.input.isTouch ? 'hud.hintTouch' : 'hud.hintDesktop';
    hint.dataset.i18n = key;
    hint.textContent = t(key);
  }

  // Clicking the canvas re-captures the mouse after the menu closes.
  app.addEventListener('click', () => {
    if (ui.hasStarted && !ui.isPaused) engine.input.requestPointerLock();
  });

  // Alt-tabbing away should hand the cursor back to the OS.
  window.addEventListener('blur', () => {
    if (engine.input.locked) engine.input.releasePointerLock();
  });

  // Expose a small surface for the console and the automated smoke test.
  (window as unknown as { arena?: unknown }).arena = {
    engine,
    ui,
    get scene() {
      return engine.scenes.current;
    },
  };

}

void boot();
