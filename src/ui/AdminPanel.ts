import { gameSession } from '../net/session.ts';
import type { Engine } from '../core/Engine.ts';
import { GameConfig } from '../config.ts';
import { SKINS, saveSkin, savedSkin } from '../player/skins.ts';
import { t } from './i18n.ts';
import { adminOverrides, resetAdminOverrides } from '../player/adminState.ts';

/**
 * AdminPanel
 * ----------
 * Toggled with P, and only by the holder of the reserved name.
 *
 * The gate is the server's word, delivered in `welcome`. Nothing here asks the
 * client whether it is an admin, because a client-side flag is a suggestion rather
 * than a permission — anybody can set one in a console.
 *
 * What these commands can and cannot do is worth being clear about. They change
 * local state: how fast you move, whether gravity applies to you, how large you
 * are, what time of day it is on your screen. Position is published to the room, so
 * other players do see an admin flying — they see the resulting movement. Anything
 * that would have to change the *world* for everyone (weather, time of day for the
 * whole room) is local only, because the world is generated identically on every
 * client and the server has nothing authoritative to say about it yet. That is a
 * real limit of the current architecture, not an oversight, and it is where the
 * work goes when the game grows a shared story.
 */

interface Command {
  id: string;
  /** i18n key for the label. */
  key: string;
  /** Present for toggles, so the button can show its state. */
  isOn?: () => boolean;
  run: () => void;
}

/** Where the flight and scale state lives, so several commands can share it. */
interface AdminState {
  flying: boolean;
  speed: number;
  scale: number;
  noclip: boolean;
  /** Which weather pin is active, so the buttons can show which one is on. */
  weather: 'auto' | 'snow' | 'dusting' | 'rain';
}

export class AdminPanel {
  private readonly engine: Engine;
  private readonly panel: HTMLElement | null;
  private readonly list: HTMLElement | null;
  private allowed = false;
  private open = false;
  private commands: Command[] = [];

  private readonly state: AdminState = {
    flying: false,
    speed: 1,
    scale: 1,
    noclip: false,
    weather: 'auto',
  };

  constructor(engine: Engine) {
    this.engine = engine;
    this.panel = document.getElementById('admin');
    this.list = document.getElementById('adminList');
    this.commands = this.build();

    // The server decides. It may say so a second time, later, once a reserved name
    // has actually been claimed — which is why this is a subscription and not a
    // one-off read.
    gameSession().onAdminChange((admin) => {
      this.allowed = admin;
      if (!admin) this.setOpen(false);
    });
  }

  /** True when the panel may be opened at all. */
  get available(): boolean {
    return this.allowed;
  }

  toggle(): void {
    if (!this.allowed) return;
    this.setOpen(!this.open);
  }

  private setOpen(open: boolean): void {
    this.open = open && this.allowed;
    this.panel?.classList.toggle('on', this.open);
    this.panel?.setAttribute('aria-hidden', this.open ? 'false' : 'true');
    if (this.open) this.render();
  }

  /**
   * Pushes the current state into the shared overrides. Called every frame and
   * cheap: four assignments. Everything is inert unless the server granted rights,
   * so losing them takes effect on the next frame with no extra bookkeeping.
   */
  applyTo(): void {
    if (!this.allowed) {
      resetAdminOverrides();
      return;
    }
    adminOverrides.speedMultiplier = this.state.speed;
    adminOverrides.flying = this.state.flying;
    adminOverrides.bodyScale = this.state.scale;
    adminOverrides.noclip = this.state.noclip;
  }

  private render(): void {
    if (!this.list) return;
    const rows = this.commands.map((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = c.isOn?.() ? 'adminBtn active' : 'adminBtn';
      btn.textContent = t(c.key as Parameters<typeof t>[0]);
      btn.addEventListener('click', () => {
        c.run();
        this.render();
      });
      return btn;
    });
    this.list.replaceChildren(...rows);
  }

  private get scene(): {
    dayNight?: {
      t01: number;
      forceWeather?: (s: { rain: number; snow: number; cover: number } | null) => void;
      weatherForced?: boolean;
    };
    setCameraZoom?: (d: number) => void;
  } | null {
    return (this.engine.scenes.current ?? null) as never;
  }

  /**
   * Pins the weather, or releases it. A no-op in the lobby, which has no sky of its
   * own — optional-chained rather than guarded, so the panel does not need to know
   * which scene it is in.
   */
  private setWeather(state: { rain: number; snow: number; cover: number } | null): void {
    this.scene?.dayNight?.forceWeather?.(state);
  }

  private build(): Command[] {
    const s = this.state;
    const cfg = GameConfig.player;
    const nudgeTime = (delta: number): void => {
      const dn = this.scene?.dayNight;
      if (dn) dn.t01 = (dn.t01 + delta + 1) % 1;
    };

    return [
      // ---- Movement ----
      { id: 'fly', key: 'admin.fly', isOn: () => s.flying, run: () => (s.flying = !s.flying) },
      {
        id: 'noclip',
        key: 'admin.noclip',
        isOn: () => s.noclip,
        run: () => (s.noclip = !s.noclip),
      },
      { id: 'speed2', key: 'admin.speed2', isOn: () => s.speed === 2, run: () => (s.speed = 2) },
      { id: 'speed4', key: 'admin.speed4', isOn: () => s.speed === 4, run: () => (s.speed = 4) },
      { id: 'speed8', key: 'admin.speed8', isOn: () => s.speed === 8, run: () => (s.speed = 8) },
      { id: 'speed1', key: 'admin.speed1', isOn: () => s.speed === 1, run: () => (s.speed = 1) },
      // ---- Size ----
      { id: 'grow', key: 'admin.grow', run: () => (s.scale = Math.min(4, s.scale * 1.35)) },
      { id: 'shrink', key: 'admin.shrink', run: () => (s.scale = Math.max(0.25, s.scale / 1.35)) },
      { id: 'sizeReset', key: 'admin.sizeReset', isOn: () => s.scale === 1, run: () => (s.scale = 1) },
      // ---- Time ----
      { id: 'dawn', key: 'admin.dawn', run: () => this.setTime(0.25) },
      { id: 'noon', key: 'admin.noon', run: () => this.setTime(0.5) },
      { id: 'dusk', key: 'admin.dusk', run: () => this.setTime(0.76) },
      { id: 'night', key: 'admin.night', run: () => this.setTime(0.02) },
      { id: 'timeFwd', key: 'admin.timeFwd', run: () => nudgeTime(0.04) },
      // ---- Weather ----
      // Pinned rather than nudged: weather is a slow function of time, biome and
      // altitude, so "make it snow" has to hold the state still or nothing visible
      // happens for minutes.
      {
        id: 'snowHeavy',
        key: 'admin.snowHeavy',
        isOn: () => this.scene?.dayNight?.weatherForced === true && s.weather === 'snow',
        run: () => {
          s.weather = 'snow';
          this.setWeather({ rain: 0, snow: 1, cover: 0.95 });
        },
      },
      {
        id: 'snowLight',
        key: 'admin.snowLight',
        isOn: () => this.scene?.dayNight?.weatherForced === true && s.weather === 'dusting',
        run: () => {
          s.weather = 'dusting';
          this.setWeather({ rain: 0, snow: 0.35, cover: 0.3 });
        },
      },
      {
        id: 'rainHeavy',
        key: 'admin.rainHeavy',
        isOn: () => this.scene?.dayNight?.weatherForced === true && s.weather === 'rain',
        run: () => {
          s.weather = 'rain';
          this.setWeather({ rain: 0.95, snow: 0, cover: 0 });
        },
      },
      {
        id: 'weatherAuto',
        key: 'admin.weatherAuto',
        isOn: () => this.scene?.dayNight?.weatherForced !== true,
        run: () => {
          s.weather = 'auto';
          this.setWeather(null);
        },
      },
      // ---- View ----
      { id: 'zoomOut', key: 'admin.zoomOut', run: () => this.scene?.setCameraZoom?.(cfg.cameraMaxDistance) },
      { id: 'firstPerson', key: 'admin.firstPerson', run: () => this.scene?.setCameraZoom?.(0) },
      // ---- World ----
      { id: 'toLobby', key: 'admin.toLobby', run: () => this.engine.requestScene('lobby') },
      { id: 'toWorld', key: 'admin.toWorld', run: () => this.engine.requestScene('exterior') },
      { id: 'nextSkin', key: 'admin.nextSkin', run: () => this.cycleSkin() },
      // ---- Diagnostics ----
      {
        id: 'stats',
        key: 'admin.stats',
        isOn: () => document.getElementById('stats')?.style.display !== 'none',
        run: () => {
          const el = document.getElementById('stats');
          if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
        },
      },
    ];
  }

  private setTime(t01: number): void {
    const dn = this.scene?.dayNight;
    if (dn) dn.t01 = t01;
  }

  private cycleSkin(): void {
    const current = savedSkin();
    const index = SKINS.findIndex((k) => k.id === current);
    saveSkin(SKINS[(index + 1) % SKINS.length]!.id);
  }
}
