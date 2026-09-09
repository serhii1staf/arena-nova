/**
 * Central, engine-wide tunables. Keeping these in one place makes it trivial to
 * balance visuals vs. performance without hunting through the codebase.
 */

export const GameConfig = {
  /** Fixed simulation step (seconds). Logic runs at a stable 60 Hz regardless
   *  of render frame rate, which keeps physics/movement deterministic. */
  fixedStep: 1 / 60,

  /** Never simulate more than this many seconds in a single frame. Prevents the
   *  "spiral of death" when a tab is backgrounded then refocused. */
  maxFrameDelta: 0.1,

  camera: {
    fov: 68,
    near: 0.1,
    far: 400,
  },

  player: {
    eyeHeight: 1.68,
    radius: 0.35,
    walkSpeed: 4.2,
    sprintSpeed: 7.6,
    acceleration: 42,
    damping: 10,
    jumpSpeed: 6.4,
    gravity: 20,
    /**
     * Downhill ground-following. `groundSnapSlope` is a gradient: the body may be
     * pulled back down by this multiple of the distance it travelled horizontally
     * in the step, which keeps it planted on slopes up to about 58°. `groundSnapMin`
     * is the fixed allowance that carries it down a stair tread while walking slowly.
     */
    groundSnapSlope: 1.6,
    groundSnapMin: 0.25,
    /** Grace period before the animation layer accepts that the body is airborne. */
    coyoteTime: 0.11,
    mouseSensitivity: 0.0022,
    touchLookSensitivity: 0.005,
    /** Third-person camera: max orbit distance (0 = first person) and zoom speed. */
    cameraMaxDistance: 6.5,
    cameraZoomSpeed: 0.9,
  },

  /** World bounds used for the lobby "arena" and soft collision walls. */
  world: {
    halfWidth: 26, // X extent (half)
    halfDepth: 40, // Z extent (half)
    ceilingHeight: 34,
  },
} as const;

export type GameConfigType = typeof GameConfig;
