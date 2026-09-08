import type { Engine } from '../core/Engine.ts';
import type { QualityTier } from '../core/QualityManager.ts';
import { SettingsStore } from './Settings.ts';
import { checkForUpdate, installUpdate, isNative, nativeWindow } from './native.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

/**
 * GameUI
 * ------
 * Owns everything outside the 3D canvas: the start screen, the Escape pause
 * overlay (blurred, with the world still visible behind it), the settings panel,
 * the update check, and the custom window buttons used when the native shell runs
 * without an OS title bar.
 */
export class GameUI {
  private readonly engine: Engine;
  private readonly settings: SettingsStore;
  private paused = false;
  private started = false;
  private lastEscapeAt = 0;

  constructor(engine: Engine) {
    this.engine = engine;
    this.settings = new SettingsStore(engine);
    this.settings.applyAll();
    this.wireStartScreen();
    this.wirePauseMenu();
    this.wireSettings();
    this.wireUpdates();
    this.showVersion();
  }

  // ---------------------------------------------------------------- start ----

  /** Enable the Play button once the world is built. */
  markReady(): void {
    const btn = $<HTMLButtonElement>('btnPlay');
    const hint = $('startHint');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Play';
    }
    if (hint) hint.textContent = 'Click Play to enter the sanctuary';
  }

  setLoadingStatus(text: string): void {
    const hint = $('startHint');
    if (hint) hint.textContent = text;
  }

  private wireStartScreen(): void {
    const btn = $<HTMLButtonElement>('btnPlay');
    btn?.addEventListener('click', () => this.play());
  }

  private play(): void {
    if (this.started) return;
    this.started = true;
    $('start')?.classList.add('hidden');
    $('hud')?.classList.add('visible');
    // The click that started the game also satisfies the audio-unlock gesture.
    this.engine.audio.unlock();
    // Give the fade a moment, then capture the mouse.
    window.setTimeout(() => this.engine.input.requestPointerLock(), 320);
  }

  get hasStarted(): boolean {
    return this.started;
  }

  // ---------------------------------------------------------------- pause ----

  private wirePauseMenu(): void {
    // Escape does double duty: browsers use it to release pointer lock, and the
    // player expects it to toggle the menu. Escape is therefore always
    // authoritative (so the menu is reachable even if the lock never engaged),
    // and the lock-release event is ignored for a short window afterwards so the
    // two paths can't fight each other.
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape' || !this.started) return;
      e.preventDefault();
      this.lastEscapeAt = performance.now();
      this.setPaused(!this.paused);
    });

    document.addEventListener('pointerlockchange', () => {
      // Losing the lock any other way (alt-tab, clicking away) also pauses.
      if (!this.started || this.engine.input.locked || this.paused) return;
      if (performance.now() - this.lastEscapeAt < 400) return; // Escape already handled it
      this.setPaused(true);
    });

    $('btnResume')?.addEventListener('click', () => this.setPaused(false));
    $('btnSettings')?.addEventListener('click', () => {
      $('settings')?.classList.toggle('open');
    });

    // Native window buttons (hidden in the browser, where the OS provides them).
    if (isNative()) {
      $('winControls')?.classList.add('on');
      $('winMin')?.addEventListener('click', () => void nativeWindow()?.minimize());
      $('winMax')?.addEventListener('click', () => void nativeWindow()?.toggleMaximize());
      $('winClose')?.addEventListener('click', () => void nativeWindow()?.close());
    }
  }

  private setPaused(on: boolean): void {
    this.paused = on;
    $('pause')?.classList.toggle('open', on);
    const hint = $('hint');
    if (hint) hint.style.opacity = on ? '0' : '1';
    if (on) {
      // Release the mouse so the cursor can reach the menu.
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      $('settings')?.classList.remove('open');
      this.engine.input.requestPointerLock();
    }
  }

  // ------------------------------------------------------------- settings ----

  private wireSettings(): void {
    const v = this.settings.values;

    const quality = $<HTMLSelectElement>('setQuality');
    if (quality) {
      quality.value = v.quality;
      quality.addEventListener('change', () => {
        this.settings.setQuality(quality.value as QualityTier);
      });
    }

    const bindSlider = (
      id: string,
      valId: string,
      initial: number,
      toDisplay: (raw: number) => string,
      onChange: (raw: number) => void,
    ): void => {
      const input = $<HTMLInputElement>(id);
      const label = $(valId);
      if (!input) return;
      input.value = String(initial);
      if (label) label.textContent = toDisplay(initial);
      input.addEventListener('input', () => {
        const raw = Number(input.value);
        if (label) label.textContent = toDisplay(raw);
        onChange(raw);
      });
    };

    bindSlider('setMusic', 'valMusic', Math.round(v.music * 100), (r) => `${r}%`, (r) =>
      this.settings.setMusic(r / 100),
    );
    bindSlider('setSfx', 'valSfx', Math.round(v.sfx * 100), (r) => `${r}%`, (r) =>
      this.settings.setSfx(r / 100),
    );
    bindSlider(
      'setSens',
      'valSens',
      Math.round(v.sensitivity * 100),
      (r) => (r / 100).toFixed(2),
      (r) => this.settings.setSensitivity(r / 100),
    );
    bindSlider('setFov', 'valFov', Math.round(v.fov), (r) => String(r), (r) =>
      this.settings.setFov(r),
    );
  }

  // -------------------------------------------------------------- updates ----

  private wireUpdates(): void {
    const btn = $<HTMLButtonElement>('btnUpdate');
    const status = $('updateStatus');
    const dot = $('updateDot');
    if (!btn || !status) return;

    if (!isNative()) {
      status.textContent = 'Updates: web build is always current';
      btn.disabled = true;
      return;
    }

    let pending: Awaited<ReturnType<typeof checkForUpdate>> = null;

    btn.addEventListener('click', () => {
      if (pending) {
        // Second press installs what we found.
        status.textContent = 'Downloading update…';
        btn.disabled = true;
        void installUpdate(pending, (pct) => {
          status.textContent = `Downloading update… ${pct}%`;
        }).catch((err: unknown) => {
          status.textContent = `Update failed: ${(err as Error).message}`;
          btn.disabled = false;
        });
        return;
      }

      status.textContent = 'Checking…';
      btn.disabled = true;
      void checkForUpdate()
        .then((update) => {
          btn.disabled = false;
          if (!update) {
            status.textContent = 'Updates: you are up to date';
            status.classList.remove('available');
            dot?.classList.remove('on');
            return;
          }
          pending = update;
          status.textContent = `Update available: v${update.version}`;
          status.classList.add('available');
          dot?.classList.add('on');
          btn.textContent = 'Install & restart';
        })
        .catch((err: unknown) => {
          btn.disabled = false;
          status.textContent = `Check failed: ${(err as Error).message}`;
        });
    });

    // Quiet check on launch so the indicator can light up on its own.
    void checkForUpdate()
      .then((update) => {
        if (!update) return;
        pending = update;
        status.textContent = `Update available: v${update.version}`;
        status.classList.add('available');
        dot?.classList.add('on');
        btn.textContent = 'Install & restart';
      })
      .catch(() => {
        /* offline or no endpoint yet — stay quiet */
      });
  }

  private showVersion(): void {
    const el = $('version');
    if (el) el.textContent = `v${__APP_VERSION__}${isNative() ? '' : ' · web'}`;
  }
}
