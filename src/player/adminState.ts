/**
 * The admin movement overrides, in one shared place.
 *
 * A module-level singleton rather than a value threaded through the engine and
 * both scenes: the panel writes it, the controller reads it, and nothing in
 * between has any business knowing it exists. Threading it through would mean
 * changing the engine context, the scene interface and every scene to carry
 * something only two files use.
 *
 * Everything here defaults to inert, so a session with no admin behaves exactly as
 * it did before and the controller pays one comparison per field.
 *
 * These are deliberately *local* effects. Position is published to the room, so
 * others do see an admin flying — they see the movement it produces. Nothing here
 * changes the world for anyone else, because the world is generated identically on
 * every client and the server has nothing authoritative to say about it yet.
 */
export interface AdminOverrides {
  /** Multiplies walk and sprint speed. */
  speedMultiplier: number;
  /** Suspends gravity and ground contact. */
  flying: boolean;
  /** Visual scale of the body. */
  bodyScale: number;
  /** Walls and props stop pushing back. */
  noclip: boolean;
}

export const adminOverrides: AdminOverrides = {
  speedMultiplier: 1,
  flying: false,
  bodyScale: 1,
  noclip: false,
};

/** Returns everything to normal. Used when admin rights are lost or revoked. */
export function resetAdminOverrides(): void {
  adminOverrides.speedMultiplier = 1;
  adminOverrides.flying = false;
  adminOverrides.bodyScale = 1;
  adminOverrides.noclip = false;
}
