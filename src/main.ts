import { Engine } from './core/Engine.ts';
import { LobbyScene } from './scenes/LobbyScene.ts';
import { ExteriorScene } from './scenes/ExteriorScene.ts';
import { GameUI } from './ui/GameUI.ts';
import { prepareNative } from './ui/native.ts';

/**
 * Bootstraps the game: builds the engine, loads the lobby while the start screen
 * is up, then hands control to GameUI (start screen → play → Escape menu).
 */

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

const app = $('app');
const hint = $('hint');
const stats = $('stats');
const fade = $('fade');

function fail(message: string): void {
  const hintEl = $('startHint');
  const btn = $<HTMLButtonElement>('btnPlay');
  if (hintEl) {
    hintEl.textContent = message;
    hintEl.style.color = '#ff9b9b';
  }
  if (btn) {
    btn.textContent = 'Unavailable';
    btn.disabled = true;
  }
  console.error('[Arena Nova]', message);
}

async function boot(): Promise<void> {
  if (!app) {
    fail('Missing #app container.');
    return;
  }

  // Fail early and clearly if the browser has no WebGL.
  try {
    const probe = document.createElement('canvas');
    if (!(probe.getContext('webgl2') ?? probe.getContext('webgl'))) {
      fail('WebGL is not available on this system.');
      return;
    }
  } catch {
    fail('WebGL is not available on this system.');
    return;
  }

  void prepareNative();

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
  ui.setLoadingStatus('Growing the moss…');

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

  const isTouch = engine.input.isTouch;
  if (hint) {
    hint.textContent = isTouch
      ? 'Left: move · Right: look · Tap: jump · enter the portal to travel'
      : 'WASD · Shift sprint · Space jump · Scroll: 3rd person · Esc: menu';
  }

  // Clicking the canvas re-captures the mouse after the menu closes.
  app.addEventListener('click', () => {
    if (ui.hasStarted) engine.input.requestPointerLock();
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
