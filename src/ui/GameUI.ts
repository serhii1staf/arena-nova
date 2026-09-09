import type { Engine } from '../core/Engine.ts';
import type { QualityTier } from '../core/QualityManager.ts';
import { SettingsStore, type FpsMode } from './Settings.ts';
import {
  checkForUpdate,
  installUpdate,
  isNative,
  nativeWindow,
  toggleFullscreen,
} from './native.ts';
import { applyTranslations, getLang, onLangChange, setLang, t, type Lang } from './i18n.ts';
import { SKINS, savedSkin, saveSkin } from '../player/skins.ts';

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
  private hintTimer: number | null = null;

  constructor(engine: Engine) {
    this.engine = engine;
    this.settings = new SettingsStore(engine);
    this.settings.applyAll();
    applyTranslations();
    this.wireStartScreen();
    this.wirePauseMenu();
    this.wireSettings();
    this.wireUpdates();
    this.wireFullscreen();
    this.showVersion();
    // Anything with dynamic text has to be refreshed when the language changes.
    onLangChange(() => this.refreshDynamicText());
  }

  /** Re-renders strings that aren't plain `data-i18n` labels. */
  private refreshDynamicText(): void {
    const btn = $<HTMLButtonElement>('btnPlay');
    if (btn) btn.textContent = btn.disabled ? t('start.loading') : t('start.play');
    const hint = $('startHint');
    if (hint && !this.started) hint.textContent = btn?.disabled ? t('start.preparing') : t('start.ready');
    const hudHint = $('hint');
    if (hudHint) {
      hudHint.textContent = this.engine.input.isTouch ? t('hud.hintTouch') : t('hud.hintDesktop');
    }
    this.showVersion();
  }

  // ---------------------------------------------------------------- start ----

  /** Enable the Play button once the world is built. */
  markReady(): void {
    const btn = $<HTMLButtonElement>('btnPlay');
    const hint = $('startHint');
    if (btn) {
      btn.disabled = false;
      btn.textContent = t('start.play');
      delete btn.dataset.i18n; // now driven by refreshDynamicText
    }
    if (hint) {
      hint.textContent = t('start.ready');
      delete hint.dataset.i18n;
    }
  }

  /** Shows a localised loading step on the start screen. */
  setLoadingStatus(key: 'start.preparing' | 'start.growing'): void {
    const hint = $('startHint');
    if (!hint) return;
    hint.dataset.i18n = key;
    hint.textContent = t(key);
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
    this.scheduleHintFade();
  }

  /**
   * The control hint is only useful for the first few seconds; leaving it on
   * screen permanently just clutters the view. It fades out on its own and comes
   * back briefly whenever the player returns from the menu.
   */
  private scheduleHintFade(): void {
    const hint = $('hint');
    if (!hint) return;
    if (this.hintTimer !== null) window.clearTimeout(this.hintTimer);
    hint.style.opacity = '1';
    this.hintTimer = window.setTimeout(() => {
      if (!this.paused) hint.style.opacity = '0';
    }, 9000);
  }

  get hasStarted(): boolean {
    return this.started;
  }

  get isPaused(): boolean {
    return this.paused;
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
      // Hand the cursor back so it can reach the menu (native capture or lock).
      this.engine.input.releasePointerLock();
    } else {
      $('settings')?.classList.remove('open');
      this.engine.input.requestPointerLock();
      this.scheduleHintFade();
    }
  }

  // ------------------------------------------------------------- settings ----

  /** F11 toggles real fullscreen, both natively and on the web. */
  private wireFullscreen(): void {
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'F11') return;
      e.preventDefault(); // stop the webview's own fullscreen handling
      void toggleFullscreen();
    });
    $('btnFullscreen')?.addEventListener('click', () => void toggleFullscreen());
  }

  private wireSettings(): void {
    const v = this.settings.values;

    const skin = $<HTMLSelectElement>('setSkin');
    const skinNote = $('skinNote');
    if (skin) {
      skin.replaceChildren(
        ...SKINS.map((s) => {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.label;
          return opt;
        }),
      );
      skin.value = savedSkin();
      skin.addEventListener('change', () => {
        // The avatar and the network session both listen for this, so the change
        // is applied on the spot rather than waiting for the next area to load.
        saveSkin(skin.value);
        if (skinNote) {
          skinNote.textContent = t('skin.applied');
          skinNote.classList.add('on');
          window.setTimeout(() => skinNote.classList.remove('on'), 2200);
        }
      });
    }

    const lang = $<HTMLSelectElement>('setLang');
    if (lang) {
      lang.value = getLang();
      lang.addEventListener('change', () => setLang(lang.value as Lang));
    }

    const fps = $<HTMLSelectElement>('setFps');
    const fpsNote = $('fpsNote');
    if (fps) {
      fps.value = v.fpsMode;
      fps.addEventListener('change', () => {
        const needsRestart = this.settings.setFpsMode(fps.value as FpsMode);
        if (fpsNote) {
          fpsNote.textContent = needsRestart ? t('fps.restart') : '';
          fpsNote.classList.toggle('on', needsRestart);
        }
      });
    }

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

    // Static messages keep their data-i18n so a language switch re-translates
    // them; interpolated ones can't, so they're set as plain text.
    const setStatus = (
      key: Parameters<typeof t>[0],
      vars?: Record<string, string | number>,
    ): void => {
      if (vars) delete status.dataset.i18n;
      else status.dataset.i18n = key;
      status.textContent = t(key, vars);
    };

    if (!isNative()) {
      setStatus('upd.webBuild');
      btn.disabled = true;
      return;
    }

    let pending: Awaited<ReturnType<typeof checkForUpdate>> = null;

    const showAvailable = (version: string): void => {
      setStatus('upd.available', { version });
      status.classList.add('available');
      dot?.classList.add('on');
      btn.textContent = t('upd.install');
      delete btn.dataset.i18n;
    };

    btn.addEventListener('click', () => {
      if (pending) {
        // Second press installs what we found.
        setStatus('upd.downloading');
        btn.disabled = true;
        void installUpdate(pending, (pct) => {
          setStatus('upd.downloadingPct', { pct });
        }).catch((err: unknown) => {
          setStatus('upd.failed', { error: (err as Error).message });
          btn.disabled = false;
        });
        return;
      }

      setStatus('upd.checking');
      btn.disabled = true;
      void checkForUpdate()
        .then((update) => {
          btn.disabled = false;
          if (!update) {
            setStatus('upd.upToDate');
            status.classList.remove('available');
            dot?.classList.remove('on');
            return;
          }
          pending = update;
          showAvailable(update.version);
        })
        .catch((err: unknown) => {
          btn.disabled = false;
          setStatus('upd.checkFailed', { error: (err as Error).message });
        });
    });

    // Quiet check on launch so the indicator can light up on its own.
    void checkForUpdate()
      .then((update) => {
        if (!update) return;
        pending = update;
        showAvailable(update.version);
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
