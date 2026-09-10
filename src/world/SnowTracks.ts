import { CanvasTexture, LinearFilter, Texture, Vector2 } from 'three';

/**
 * SnowTracks
 * ----------
 * A single-channel map of how trodden the snow is, in world space, around the
 * player. The terrain shader looks it up per fragment and compresses the lying
 * snow where the map says someone has walked.
 *
 * Drawn on a 2D canvas and uploaded, not rendered on the GPU. That decision is
 * worth defending, because a scrolling render target is the usual answer: it would
 * mean a second framebuffer, a stamp shader, a blit shader and a ping-pong pair to
 * scroll without reading and writing the same texture — a few hundred lines and
 * two extra draws every frame. What it would buy is throughput, and there is
 * nothing to throughput here. A walking player produces about two footprints a
 * second. The work per print is one radial gradient into a 256x256 canvas, and the
 * upload is a quarter of a megabyte that only happens on frames where something
 * actually changed, throttled so a sprint cannot queue more than one per frame.
 *
 * The map scrolls with the player instead of being re-anchored, because
 * re-anchoring throws away the tracks. Scrolling is done by drawing the canvas
 * onto itself through a scratch copy, and only ever by a whole number of texels,
 * so a track never smears or drifts against the ground it was left on.
 *
 * Resolution is the one number that matters: 256 texels over 64 m is 25 cm per
 * texel, which is about the width of a boot. Finer than that and prints stop
 * being legible at the distance you actually see them from; coarser and a single
 * step covers several texels and the trail turns into a smear.
 */

/** Metres across. Comfortably beyond the distance a print is legible from. */
const EXTENT = 64;
/** Texels per side. 25 cm each at the extent above. */
const SIZE = 256;
/**
 * How much a footprint compresses the snow directly under it, 0..1.
 *
 * Not 1. A boot pushes snow aside and packs what is left; it does not clear the
 * ground. Prints also deepen where they overlap, which is what turns a path
 * walked twice into a visibly worn line rather than a series of marks.
 */
const PRINT_STRENGTH = 0.55;
/** Radius of one print, in metres. A boot plus the snow it displaces. */
const PRINT_RADIUS = 0.34;
/**
 * How fast fresh snowfall fills tracks back in, as a fraction per second at full
 * snowfall. Slow: a trail that healed in seconds would never be seen from the
 * ridge it was walked up.
 */
const REFILL_RATE = 0.06;

export interface SnowTrackMap {
  texture: Texture;
  /** World XZ the map is centred on. */
  readonly origin: Vector2;
  /** Metres across. */
  readonly extent: number;
  /**
   * Records a footfall at a world position. Ignored when it lands outside the
   * map, which cannot normally happen — the map follows the player.
   */
  stamp(x: number, z: number): void;
  /**
   * Keeps the map under the player and heals tracks as snow falls. `snowfall` is
   * 0..1. Uploads at most one texture per call, and only when something changed.
   */
  update(x: number, z: number, snowfall: number, frameDelta: number): void;
  /**
   * Mean trodden value across the map, 0..1. For diagnostics only, and on demand
   * only: it reads the canvas back, which is far too expensive for a frame loop
   * but is the one measurement that proves a print actually landed rather than
   * that a function was called.
   */
  coverage(): number;
  dispose(): void;
}

export function createSnowTracks(): SnowTrackMap | null {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) return null;

  // Black is untrodden. Only the red channel is read, but a greyscale canvas
  // keeps the scratch blit and the fade trivially correct.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SIZE, SIZE);

  const scratch = document.createElement('canvas');
  scratch.width = SIZE;
  scratch.height = SIZE;
  const scratchCtx = scratch.getContext('2d');
  if (!scratchCtx) return null;

  const texture = new CanvasTexture(canvas);
  // Linear, so a print's edge is smooth rather than a staircase of texels, and no
  // mips: the map is read at roughly one texel per fragment near the player and
  // a mip chain would only blur the prints away.
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;

  const origin = new Vector2(0, 0);
  const perMetre = SIZE / EXTENT;
  let dirty = false;
  /** Fade owed but not yet applied, so a slow refill is not lost to rounding. */
  let pendingFade = 0;

  /** Canvas pixel for a world position. */
  const toPixel = (x: number, z: number): { px: number; pz: number } => ({
    px: (x - origin.x) * perMetre + SIZE * 0.5,
    pz: (z - origin.y) * perMetre + SIZE * 0.5,
  });

  const stamp = (x: number, z: number): void => {
    const { px, pz } = toPixel(x, z);
    const r = PRINT_RADIUS * perMetre;
    if (px < -r || pz < -r || px > SIZE + r || pz > SIZE + r) return;

    // Soft-edged, and additive via `lighter` so overlapping prints deepen instead
    // of replacing each other — that is what makes a path emerge from footsteps.
    const g = ctx.createRadialGradient(px, pz, 0, px, pz, Math.max(1.2, r));
    const peak = Math.round(PRINT_STRENGTH * 255);
    g.addColorStop(0, `rgb(${peak},${peak},${peak})`);
    g.addColorStop(0.55, `rgb(${Math.round(peak * 0.6)},${Math.round(peak * 0.6)},${Math.round(peak * 0.6)})`);
    g.addColorStop(1, 'rgb(0,0,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, pz, Math.max(1.2, r), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    dirty = true;
  };

  /** Shifts the map by whole texels so it stays centred on the player. */
  const scroll = (dxTexels: number, dzTexels: number): void => {
    scratchCtx.clearRect(0, 0, SIZE, SIZE);
    scratchCtx.drawImage(canvas, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);
    // Ground that has just come into range has never been walked on, so the
    // vacated strip is left black rather than wrapped around — wrapping would
    // paste the tracks from the far side of the map onto fresh ground.
    ctx.drawImage(scratch, -dxTexels, -dzTexels);
    dirty = true;
  };

  const update = (x: number, z: number, snowfall: number, frameDelta: number): void => {
    // Recentre in whole texels only. A fractional shift would resample the whole
    // map every frame, and a track would visibly crawl across the ground it was
    // left on as the error accumulated.
    const dxTexels = Math.round((x - origin.x) * perMetre);
    const dzTexels = Math.round((z - origin.y) * perMetre);
    if (dxTexels !== 0 || dzTexels !== 0) {
      scroll(dxTexels, dzTexels);
      origin.set(origin.x + dxTexels / perMetre, origin.y + dzTexels / perMetre);
    }

    // Snowfall fills tracks in. Accumulated rather than applied per frame: at a
    // light fall the per-frame alpha rounds to nothing at 8 bits, so the fade
    // would silently never happen.
    if (snowfall > 0.02) {
      pendingFade += snowfall * REFILL_RATE * frameDelta;
      if (pendingFade > 0.012) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `rgba(0,0,0,${Math.min(0.5, pendingFade)})`;
        ctx.fillRect(0, 0, SIZE, SIZE);
        pendingFade = 0;
        dirty = true;
      }
    }

    // One upload per call at most, and none at all on a frame where nothing moved
    // and nobody stepped.
    if (dirty) {
      texture.needsUpdate = true;
      dirty = false;
    }
  };

  const coverage = (): number => {
    const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i]!;
    return sum / (SIZE * SIZE) / 255;
  };

  return {
    texture,
    origin,
    extent: EXTENT,
    stamp,
    update,
    coverage,
    dispose: () => {
      texture.dispose();
      canvas.width = 0;
      canvas.height = 0;
      scratch.width = 0;
      scratch.height = 0;
    },
  };
}
