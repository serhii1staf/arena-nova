import { Vector2 } from 'three';
import {
  beginNativeMouseCapture,
  endNativeMouseCapture,
  claimCursorWarp,
  hasPendingCursorWarp,
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

  /** How close to the middle a move must land to be read as our own warp. */
  private static readonly WARP_LANDING_TOLERANCE = 64;
  /** Last cursor position, for measuring native-capture deltas ourselves. */
  private readonly lastPointer = new Vector2();
  private haveLastPointer = false;
  /** A warp has been asked for; the next move is its landing, not the player's. */
  private awaitingWarpLanding = false;
  /** True while the accumulated look delta came from a touch drag. */
  private lookFromTouch = false;

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
   * True only for devices with *no* precise pointer at all.
   *
   * `isTouch` is not a usable test for "should we capture the mouse": a laptop
   * with a touchscreen, or a Windows precision touchpad, reports touch points
   * while still being driven by a pointer. Gating capture on `isTouch` meant
   * mouse capture was never started on those machines, so every mouse move was
   * dropped by `onMouseMove` and looking around fell back to whatever the touch
   * handlers picked up — which is why turning behaved so strangely on the laptop.
   */
  private get pointerIsCoarseOnly(): boolean {
    if (!this.isTouch) return false;
    return typeof matchMedia === 'function' ? !matchMedia('(any-pointer: fine)').matches : true;
  }

  /**
   * Begins mouse capture. On desktop the OS cursor is hidden and confined by the
   * native shell (no Pointer Lock, so Chromium never shows its "press Esc"
   * banner); in a browser we fall back to the Pointer Lock API.
   */
  requestPointerLock(): void {
    if (this.pointerIsCoarseOnly) return;
    this.captureWanted = true;
    if (this.peeking) return; // Tab is held — stay released until it comes up
    if (isNative()) {
      this.nativeCapture = true;
      this.locked = true;
      this.haveLastPointer = false;
      this.awaitingWarpLanding = false;
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
    this.haveLastPointer = false;
    this.awaitingWarpLanding = false;
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

    if (!this.nativeCapture) {
      // Pointer Lock: the cursor does not move, and `movementX/Y` is the raw
      // device delta. Nothing to correct.
      this.lookFromTouch = false;
      this.lookDelta.x += e.movementX;
      this.lookDelta.y += e.movementY;
      return;
    }

    // Native capture has no Pointer Lock, so the cursor really travels across the
    // window and has to be warped back before it reaches an edge and stops
    // producing movement at all.
    //
    // The delta is measured from the previous event position rather than taken
    // from `movementX/Y`. Those are computed against the browser's own record of
    // where the cursor was, which a warp invalidates in a way we cannot observe:
    // the correction leaked into the accumulated look and pulled the view back
    // the way it came. It shows up worst with a touchpad, where movement arrives
    // as a long stream of small deltas and so crosses the warp margin over and
    // over — pushing right, the view crawled left.
    const px = e.clientX;
    const py = e.clientY;
    const hadPrevious = this.haveLastPointer;
    const dx = px - this.lastPointer.x;
    const dy = py - this.lastPointer.y;
    this.lastPointer.set(px, py);
    this.haveLastPointer = true;

    // Swallow the event the warp itself produced: resync the reference position
    // and emit nothing. Identified either by being the first event after a warp
    // was requested, or by landing near the centre while one is still in flight —
    // the first alone is not enough, because a real move can arrive while the warp
    // is still on its way, and the second alone misses a warp that happens to land
    // where a real movement would have.
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (this.awaitingWarpLanding || hasPendingCursorWarp()) {
      const nearCentre =
        Math.abs(px - w * 0.5) < Input.WARP_LANDING_TOLERANCE &&
        Math.abs(py - h * 0.5) < Input.WARP_LANDING_TOLERANCE;
      if (this.awaitingWarpLanding || nearCentre) {
        this.awaitingWarpLanding = false;
        claimCursorWarp();
        return;
      }
    }

    if (hadPrevious) {
      this.lookFromTouch = false;
      this.lookDelta.x += dx;
      this.lookDelta.y += dy;
    }

    // Two margins, because the warp is an async round-trip while mouse input is
    // not. The outer one is a hard stop: the cursor is confined to the window, so
    // once it is pressed against the frame the OS reports no more movement and the
    // view simply stops turning. Moving fast could cross a single small margin and
    // hit the wall before the warp landed — so past the outer margin the throttle
    // is bypassed and a warp is forced.
    const offCentre = Math.max(
      Math.abs(px - w * 0.5) / (w * 0.5),
      Math.abs(py - h * 0.5) / (h * 0.5),
    );
    if (offCentre > 0.72) {
      this.awaitingWarpLanding = true;
      void recentreNativeCursor(true);
    } else if (offCentre > 0.5) {
      this.awaitingWarpLanding = true;
      void recentreNativeCursor();
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
        this.lookFromTouch = true;
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

  /**
   * Whether the pending look delta came from a finger rather than a pointer.
   *
   * Sensitivity has to follow the input that produced the delta, not the device
   * it might have come from. Touch sensitivity is more than twice the mouse
   * figure, and picking it from `isTouch` meant a laptop with a touchscreen
   * applied it to mouse movement too, making the view whip around.
   */
  get lookCameFromTouch(): boolean {
    return this.lookFromTouch;
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
