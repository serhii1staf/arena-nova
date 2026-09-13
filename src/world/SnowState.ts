import { Vector2, type IUniform, type Texture } from 'three';
import { WORLD } from './WorldGen.ts';
import type { SnowTrackMap } from './SnowTracks.ts';

/**
 * SnowState
 * ---------
 * The lying snow, as uniforms shared by every material that has to know about it,
 * plus the one piece of shader maths that decides where it settles.
 *
 * Shaped like `Wind`, and for the same reason: several unrelated materials need the
 * same answer, and they must not each have their own copy of it. The ground and the
 * vegetation disagreeing about where the snowline is would be visible as green grass
 * standing in white fields — which is exactly what the first version of this looked
 * like, because only the terrain knew.
 *
 * Because every material references the *same* uniform objects, publishing a new
 * depth is four assignments for the whole world however much of it is on screen.
 */

/**
 * Where the fresh-snow line sits with the barest cover, and where it reaches when
 * cover is total, in metres.
 *
 * The ceiling is the permanent snow line: a dusting only freshens ground that is
 * white anyway, which is what a light fall on a range actually does. The floor is
 * just above the sea, so a long hard winter can bring snow all the way down — and
 * because the shader interpolates between the two, everything in between happens on
 * its own, in the right order, with the summits going first.
 */
export const SNOW_CEILING = WORLD.snowLine;
export const SNOW_FLOOR = WORLD.waterLevel + 6;

/**
 * Where snow lies whatever the weather is doing, in metres.
 *
 * The summits are white all year, and until now they were not: every gram of snow in the world
 * was weather-driven, so on a clear day `snowAt` returned zero everywhere and the peaks were
 * carrying nothing but the `snow` biome's pale rock texture. Which is why walking on a mountain
 * top left no tracks — there was no snow there to leave them in, only a colour.
 *
 * A little below `WORLD.snowLine` so the band the biome already calls snow is properly covered
 * rather than starting exactly where the rock texture changes; the two lining up perfectly is
 * what makes a snowline look drawn on.
 */
export const SNOW_PERMANENT = WORLD.snowLine - 18;
/** Metres over which the permanent cap fades in. Wide, so a summit is not a hard ring. */
const PERMANENT_RAMP = 58;

export interface SnowUniforms {
  uSnowCover: IUniform<number>;
  uTrackOrigin: IUniform<Vector2>;
  uTrackExtent: IUniform<number>;
  uTrackMap: IUniform<Texture | null>;
}

/** The one set. Module-level because there is only ever one sky. */
export const snowUniforms: SnowUniforms = {
  uSnowCover: { value: 0 },
  uTrackOrigin: { value: new Vector2() },
  uTrackExtent: { value: 1 },
  uTrackMap: { value: null },
};

/**
 * Publishes the depth and the tracks map. Cheap enough to call every frame.
 *
 * `cover` is not a depth in metres: it is how far down the range the snowline has
 * crept, and the shader turns that into coverage per fragment from the fragment's
 * own height and slope. That is why one scalar covers a whole mountain range with no
 * texture, no second pass and no streaming work.
 */
export function setSnowState(cover: number, tracks: SnowTrackMap | null): void {
  snowUniforms.uSnowCover.value = Math.min(1, Math.max(0, cover));
  if (tracks) {
    snowUniforms.uTrackMap.value = tracks.texture;
    snowUniforms.uTrackOrigin.value.copy(tracks.origin);
    snowUniforms.uTrackExtent.value = tracks.extent;
  }
}

/** Uniform declarations, for a fragment shader that wants `snowAt`. */
export const SNOW_UNIFORM_DECL = /* glsl */ `
  uniform float uSnowCover;
  uniform vec2 uTrackOrigin;
  uniform float uTrackExtent;
  uniform sampler2D uTrackMap;
`;

/**
 * `snowAt(world, up)` — how much snow is lying at a point, 0..1.
 *
 * Three inputs, all read from the surface itself rather than stored anywhere.
 * Height, because snow settles at altitude first and the line creeps down as more
 * falls. Slope, because snow does not cling to a cliff — that is why real mountains
 * show bare rock on their faces and white on their shoulders, and it is most of what
 * makes a covering read as snow rather than as white paint. And the tracks map, so
 * walking through it leaves it behind.
 *
 * Shared as a string because the alternative is two copies drifting apart. The
 * vegetation passes a straight-up normal, since a blade of grass has no meaningful
 * face of its own.
 */
export const SNOW_GLSL = /* glsl */ `
  float snowAt( vec3 world, vec3 up ) {
    // The permanent cap. Independent of the weather, because the summits are white all year —
    // and because without it there was no snow to walk in on a clear day, and so no tracks.
    float lying = smoothstep(
      ${SNOW_PERMANENT.toFixed(1)},
      ${(SNOW_PERMANENT + PERMANENT_RAMP).toFixed(1)},
      world.y
    );

    // Fresh fall on top, which is what walks the line down the range as cover builds. The two
    // are combined with a max rather than added: two sources of snow in one place is still snow,
    // and adding them made a summit in a storm clip to flat white.
    if ( uSnowCover > 0.001 ) {
      float snowHeight = mix( ${SNOW_CEILING.toFixed(1)}, ${SNOW_FLOOR.toFixed(1)}, uSnowCover );
      lying = max( lying, smoothstep( snowHeight, snowHeight + 42.0, world.y ) );
    }

    // Snow holds to about 50 degrees and sheds above that. Deliberately not called
    // "flat": that is an interpolation qualifier in GLSL ES 3.0 and using it as an
    // identifier fails to compile.
    float holds = smoothstep( 0.62, 0.86, up.y );
    lying *= holds;

    // Broken up so a covering has a shape. Without this the snowline is a clean
    // contour ring around every hill, which is the one thing that never happens
    // outdoors — wind strips ridges and fills hollows.
    float drift =
      sin( world.x * 0.021 ) * cos( world.z * 0.019 ) * 0.5 +
      sin( world.x * 0.006 + world.z * 0.008 ) * 0.5;
    lying = clamp( lying + drift * 0.16 * ( 1.0 - uSnowCover ), 0.0, 1.0 );

    // Nothing further to do where nothing lies, and this is also the early-out that the
    // weather check used to provide.
    if ( lying <= 0.0 ) return 0.0;

    // Tracks, in world space around the player, so a footprint has to be looked up
    // rather than baked — the ground it sits on may be streamed away and rebuilt.
    vec2 uv = ( world.xz - uTrackOrigin ) / uTrackExtent + 0.5;
    if ( all( greaterThan( uv, vec2( 0.0 ) ) ) && all( lessThan( uv, vec2( 1.0 ) ) ) ) {
      float trodden = texture2D( uTrackMap, uv ).r;
      // Compressed rather than erased: a boot pushes snow aside and exposes what is
      // underneath, it does not clear the ground.
      lying *= 1.0 - trodden * 0.82;
    }
    return lying;
  }
`;
