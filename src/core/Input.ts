import { Vector2 } from 'three';
import {
  beginNativeMouseCapture,
  endNativeMouseCapture,
  isNative,
  recentreNativeCursor,
} from '../ui/native.ts';

/**
 * Input
 * -----
 * Unifies desktop (keyboard + pointer-lock mouse) and mobile (dual-touch:
 * left-half virtual stick for movement, right-half drag to look, quick tap to
 * jump) into a single, frame-consumable state. The rest of the engine never
 * touches raw DOM events.
 */
export class Input {
  /** Movement intent, normalised. x = strafe (+right), y = forward (+forward). */
  readonly move = new Vector2();
  /** Accumulated look delta since last consume. x = yaw, y = pitch (radians-ish). */
  private readonly lookDelta = new Vector2();

  sprint = false;
  private jumpQueued = false;
  locked = false;
  /** Player-configurable look-speed multiplier (see the settings menu). */
  lookSensitivityScale = 1;
  /** True when the native shell (not the browser) owns the cursor. */
  private nativeCapture = false;
  /** The game wants the mouse captured (i.e. playing, menu closed). */
  private captureWanted = false;
  /** Tab is held down, so the cursor is temporarily handed back. */
  private peeking = false;

  private readonly keys = new Set<string>();
  private readonly el: HTMLElement;

  // Touch tracking.
  private moveTouchId: number | null = null;
  private lookTouchId: number | null = null;
  private readonly moveOrigin = new Vector2();
  private readonly lookLast = new Vector2();
  private lookTouchMoved = 0;
  private lookTouchStart = 0;

  // Mouse-wheel zoom (first ↔ third person).
  private wheelDelta = 0;

  private readonly bound: {
    keydown: (e: KeyboardEvent) => void;
    keyup: (e: KeyboardEvent) => void;
    mousemove: (e: MouseEvent) => void;
    wheel: (e: WheelEvent) => void;
    lockChange: () => void;
    touchstart: (e: TouchEvent) => void;
    touchmove: (e: TouchEvent) => void;
    touchend: (e: TouchEvent) => void;
  };

  constructor(el: HTMLElement) {
    this.el = el;
    this.bound = {
      keydown: this.onKeyDown.bind(this),
      keyup: this.onKeyUp.bind(this),
      mousemove: this.onMouseMove.bind(this),
      wheel: this.onWheel.bind(this),
      lockChange: this.onLockChange.bind(this),
      touchstart: this.onTouchStart.bind(this),
      touchmove: this.onTouchMove.bind(this),
      touchend: this.onTouchEnd.bind(this),
    };

    window.addEventListener('keydown', this.bound.keydown);
    window.addEventListener('keyup', this.bound.keyup);
    document.addEventListener('mousemove', this.bound.mousemove);
    document.addEventListener('pointerlockchange', this.bound.lockChange);
    el.addEventListener('wheel', this.bound.wheel, { passive: false });

    el.addEventListener('touchstart', this.bound.touchstart, { passive: false });
    el.addEventListener('touchmove', this.bound.touchmove, { passive: false });
    el.addEventListener('touchend', this.bound.touchend, { passive: false });
    el.addEventListener('touchcancel', this.bound.touchend, { passive: false });
  }

  get isTouch(): boolean {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  /**
   * Begins mouse capture. On desktop the OS cursor is hidden and confined by the
   * native shell (no Pointer Lock, so Chromium never shows its "press Esc"
   * banner); in a browser we fall back to the Pointer Lock API.
   */
  requestPointerLock(): void {
    if (this.isTouch) return;
    this.captureWanted = true;
    if (this.peeking) return; // Tab is held — stay released until it comes up
    if (isNative()) {
      this.nativeCapture = true;
      this.locked = true;
      document.documentElement.classList.add('mouse-captured');
      void beginNativeMouseCapture();
      return;
    }
    if (!this.locked) void this.el.requestPointerLock?.();
  }

  /** Ends mouse capture (menu opened, window lost focus…). */
  releasePointerLock(): void {
    this.captureWanted = false;
    this.stopCapture();
  }

  /** Drops capture without forgetting that the game wants it back. */
  private stopCapture(): void {
    document.documentElement.classList.remove('mouse-captured');
    if (isNative()) {
      this.nativeCapture = false;
      this.locked = false;
      void endNativeMouseCapture();
      return;
    }
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private onLockChange(): void {
    if (isNative()) return; // native capture tracks its own state
    this.locked = document.pointerLockElement === this.el;
  }

  private onKeyDown(e: KeyboardEvent): void {
    this.keys.add(e.code);
    if (e.code === 'Space') {
      this.jumpQueued = true;
      e.preventDefault();
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.sprint = true;

    // Hold Tab to peek: the cursor comes back so you can reach anything on
    // screen, and movement input is dropped until it's released.
    if (e.code === 'Tab') {
      e.preventDefault();
      if (!this.peeking) {
        this.peeking = true;
        this.stopCapture();
      }
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.sprint = false;

    if (e.code === 'Tab') {
      e.preventDefault();
      this.peeking = false;
      // Re-capture only if the game still wants it (not paused).
      if (this.captureWanted) this.requestPointerLock();
    }
  }

  /** True while Tab is held (cursor visible, look/move suspended). */
  get isPeeking(): boolean {
    return this.peeking;
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.locked) return;
    this.lookDelta.x += e.movementX;
    this.lookDelta.y += e.movementY;

    // Native capture has no pointer lock, so the cursor really travels across
    // the window. Warp it back to the middle before it reaches an edge and stops
    // producing movement deltas.
    if (this.nativeCapture) {
      const marginX = window.innerWidth * 0.28;
      const marginY = window.innerHeight * 0.28;
      if (
        e.clientX < marginX ||
        e.clientX > window.innerWidth - marginX ||
        e.clientY < marginY ||
        e.clientY > window.innerHeight - marginY
      ) {
        void recentreNativeCursor();
      }
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.wheelDelta += e.deltaY;
  }

  // ---- Touch ----
  private onTouchStart(e: TouchEvent): void {
    e.preventDefault();
    const halfW = window.innerWidth * 0.5;
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < halfW && this.moveTouchId === null) {
        this.moveTouchId = t.identifier;
        this.moveOrigin.set(t.clientX, t.clientY);
      } else if (this.lookTouchId === null) {
        this.lookTouchId = t.identifier;
        this.lookLast.set(t.clientX, t.clientY);
        this.lookTouchMoved = 0;
        this.lookTouchStart = performance.now();
      }
    }
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.moveTouchId) {
        const dx = t.clientX - this.moveOrigin.x;
        const dy = t.clientY - this.moveOrigin.y;
        const radius = 60;
        const nx = Math.max(-1, Math.min(1, dx / radius));
        const ny = Math.max(-1, Math.min(1, dy / radius));
        this.move.set(nx, -ny); // screen-down is backward
        this.sprint = this.move.length() > 0.85;
      } else if (t.identifier === this.lookTouchId) {
        this.lookDelta.x += t.clientX - this.lookLast.x;
        this.lookDelta.y += t.clientY - this.lookLast.y;
        this.lookTouchMoved += Math.abs(t.clientX - this.lookLast.x) + Math.abs(t.clientY - this.lookLast.y);
        this.lookLast.set(t.clientX, t.clientY);
      }
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.moveTouchId) {
        this.moveTouchId = null;
        this.move.set(0, 0);
        this.sprint = false;
      } else if (t.identifier === this.lookTouchId) {
        // A short, near-stationary tap counts as a jump.
        const dt = performance.now() - this.lookTouchStart;
        if (dt < 220 && this.lookTouchMoved < 12) this.jumpQueued = true;
        this.lookTouchId = null;
      }
    }
  }

  /** Compute the desktop movement vector from currently-held keys. */
  private readKeyboardMove(): void {
    if (this.moveTouchId !== null) return; // touch owns movement
    if (this.peeking) {
      // Cursor is handed back while Tab is held; freeze movement so the player
      // doesn't keep walking while looking at something.
      this.move.set(0, 0);
      this.sprint = false;
      return;
    }
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    this.move.set(x, y);
    if (this.move.lengthSq() > 1) this.move.normalize();
  }

  /** Returns and clears the accumulated look delta for this frame. */
  consumeLook(out: Vector2): Vector2 {
    out.copy(this.lookDelta);
    this.lookDelta.set(0, 0);
    return out;
  }

  /** Returns true once per queued jump. */
  consumeJump(): boolean {
    if (this.jumpQueued) {
      this.jumpQueued = false;
      return true;
    }
    return false;
  }

  /** Returns and clears accumulated wheel delta (for camera zoom). */
  consumeWheel(): number {
    const w = this.wheelDelta;
    this.wheelDelta = 0;
    return w;
  }

  /** Call once per frame before reading state. */
  update(): void {
    this.readKeyboardMove();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.bound.keydown);
    window.removeEventListener('keyup', this.bound.keyup);
    document.removeEventListener('mousemove', this.bound.mousemove);
    document.removeEventListener('pointerlockchange', this.bound.lockChange);
    this.el.removeEventListener('wheel', this.bound.wheel);
    this.el.removeEventListener('touchstart', this.bound.touchstart);
    this.el.removeEventListener('touchmove', this.bound.touchmove);
    this.el.removeEventListener('touchend', this.bound.touchend);
    this.el.removeEventListener('touchcancel', this.bound.touchend);
  }
}
