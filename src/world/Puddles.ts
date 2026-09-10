import {
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  type Texture,
  Vector3,
} from 'three';
import { surfaceGroundHeightAt, surfaceHeightAt, surfaceSlopeAt, WORLD } from './WorldGen.ts';

/**
 * Puddles
 * -------
 * Standing water left by the rain: flat patches that reflect the sky, with a ring
 * of damp ground around each one.
 *
 * The reflection is an environment lookup, not a second view of the scene.
 * Rendering the world again into a texture — a mirror, a cube camera, a planar
 * reflector — is the obvious way to reflect the trees, and it doubles the cost of
 * every frame to do it. This world is streamed and already close to its triangle
 * budget, so that spend would have to come out of the draw distance, and the low
 * tier would lose the most while gaining the least. Instead each puddle samples
 * the sky texture along the reflected view vector, weights it by Fresnel and
 * ripples the surface normal: one draw call for every puddle on screen, no render
 * targets, and the thing the eye actually looks for in water — a bright sky, the
 * sun's glow, and movement — is all there. What it cannot show is the reflection
 * of anything on the ground, and at these sizes and viewing angles that is a
 * trade worth making.
 *
 * Placement is the other half of the illusion. Water collects in flat ground, so
 * candidates are rejected on `surfaceSlopeAt`, and the patch is sized from the
 * measured slope — the flatter the ground, the wider the puddle it can hold. The
 * height comes from `surfaceGroundHeightAt` (the surface as *drawn*, not the
 * analytic field) sampled at the centre and around the rim, and the quad sits on
 * the highest of those, so it can never end up buried in the hillside it lies on.
 */

export interface PuddleField {
  mesh: InstancedMesh;
  /**
   * `wetness` is 0..1 and fades the whole field; below a threshold nothing is
   * drawn or updated at all. `rain` drives how hard the surface is disturbed, so
   * water that is still falling ripples and water that is drying goes glassy.
   * `tint` is the sky's own tint, so a reflection dims after sunset with the sky.
   */
  update(centre: Vector3, elapsed: number, wetness: number, rain: number, tint: Color): void;
  dispose(): void;
}

const VERT = /* glsl */ `
  attribute float aSeed;

  varying vec2 vUv;
  varying vec3 vWorld;
  varying float vSeed;

  void main() {
    vUv = uv;
    vSeed = aSeed;

    vec4 local = vec4(position, 1.0);
    // Applied by hand: this is a bare ShaderMaterial, so none of three's vertex
    // chunks are here to do it. The attribute itself is declared by the renderer
    // whenever the object is an InstancedMesh.
    #ifdef USE_INSTANCING
      local = instanceMatrix * local;
    #endif

    vec4 world = modelMatrix * local;
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uSky;
  uniform vec3 uTint;
  uniform vec3 uWater;
  uniform float uAmount;
  uniform float uRipple;
  uniform float uTime;

  varying vec2 vUv;
  varying vec3 vWorld;
  varying float vSeed;

  #define RECIP_PI2 0.15915494
  #define RECIP_PI 0.31830989

  void main() {
    vec2 c = vUv * 2.0 - 1.0;
    float r = length(c);
    if (r > 1.0) discard;

    // Irregular outline. A ring of perfect circles reads as decals; a couple of
    // harmonics around the rim is enough to break that up.
    float ang = atan(c.y, c.x);
    float s = vSeed * 6.283;
    float rim = 0.74 + 0.07 * sin(ang * 3.0 + s) + 0.045 * sin(ang * 5.0 - s * 1.7);

    // Two zones: the water itself, and the damp ground it has soaked into.
    float water = smoothstep(rim, rim - 0.16, r);
    float damp = 1.0 - smoothstep(rim, 1.0, r);

    // Ripples. Two crossing wave trains, differentiated analytically so the
    // surface normal comes out without a normal map or a second texture fetch.
    vec2 w = vWorld.xz;
    float chop = 0.05 + uRipple * 0.16;
    float dhdx =
      cos(w.x * 3.3 + uTime * 2.6) + 0.7 * cos((w.x + w.y) * 5.7 - uTime * 3.9);
    float dhdz =
      cos(w.y * 2.9 - uTime * 2.2) + 0.7 * cos((w.x - w.y) * 5.1 + uTime * 4.3);
    vec3 n = normalize(vec3(-dhdx * chop, 1.0, -dhdz * chop));

    vec3 view = normalize(vWorld - cameraPosition);
    vec3 refl = reflect(view, n);
    // A ripple can tilt the reflected ray below the horizon, where the sky
    // texture holds ground haze; folding it back up keeps the puddle looking at
    // the sky instead of flashing dark bands as the waves pass.
    refl.y = abs(refl.y);
    vec2 skyUv = vec2(
      atan(refl.z, refl.x) * RECIP_PI2 + 0.5,
      asin(clamp(refl.y, -1.0, 1.0)) * RECIP_PI + 0.5
    );
    vec3 sky = texture2D(uSky, skyUv).rgb * uTint;

    // Fresnel: almost a mirror at a grazing angle, mostly dark water looking
    // straight down into it. This is what makes a puddle read as a hole with the
    // sky in it rather than as a light-coloured sticker on the ground.
    float f = pow(1.0 - max(0.0, dot(-view, n)), 4.0);
    vec3 wet = mix(uWater, sky, mix(0.09, 0.94, f));

    vec3 color = mix(uWater, wet, water);
    // The damp ring only darkens what is under it; the water is nearly opaque.
    float alpha = mix(damp * 0.24, mix(0.72, 0.95, f), water) * uAmount;
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/** Steepest ground that can hold water at all. Roughly four degrees. */
const MAX_SLOPE = 0.075;
/** Widest half-extent of a patch, in metres. */
const MAX_RADIUS = 2.5;
/** How much relief across the patch is tolerated before the spot is rejected. */
const MAX_RELIEF = 0.16;
/** Candidate spots tried per placement before giving up until the next frame. */
const TRIES = 7;
/** Placements allowed per frame, so a long walk never spikes the frame. */
const RECYCLE_PER_FRAME = 3;

/** Dark, slightly cool water. Also the colour the damp ring darkens toward. */
const WATER = new Color(0.052, 0.062, 0.072);
/** What the reflection tint is lifted toward once the sky itself goes dark. */
const PALE = new Color(0.8, 0.85, 0.92);

export function createPuddles(count: number, sky: Texture, extent = 42): PuddleField {
  // A unit quad lying flat, scaled per instance. Two triangles each: even the
  // ultra tier's whole field is a few dozen triangles in one draw call.
  const geometry = new PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);

  const seeds = new Float32Array(count);
  const seedAttr = new InstancedBufferAttribute(seeds, 1);
  geometry.setAttribute('aSeed', seedAttr);

  const uniforms = {
    uSky: { value: sky },
    uTint: { value: new Color(1, 1, 1) },
    uWater: { value: WATER.clone() },
    uAmount: { value: 0 },
    uRipple: { value: 0 },
    uTime: { value: 0 },
  };

  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    // The patch lies a couple of centimetres above the ground it reflects; it
    // must not write depth or it would z-fight with the grass standing in it.
    depthWrite: false,
    // Must stay false: a raw ShaderMaterial asking for fog without declaring
    // three's fog uniforms and chunks makes the renderer throw every frame while
    // refreshing them. Puddles are only ever a few dozen metres away, where the
    // exponential haze is worth a fraction of a percent anyway.
    fog: false,
  });

  const mesh = new InstancedMesh(geometry, material, count);
  mesh.name = 'Puddles';
  // Instances move as the player walks, and the whole field is one draw call, so
  // there is nothing to gain from culling it and a stale bounding sphere to lose.
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.visible = false;

  // ---- Instance bookkeeping ---------------------------------------------
  const xs = new Float32Array(count);
  const zs = new Float32Array(count);
  /** 0 marks an instance with nowhere to be; it is parked at zero scale. */
  const radii = new Float32Array(count);

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  const axis = new Vector3(0, 1, 0);
  const limitSq = extent * extent;
  let seeded = false;

  const park = (i: number): void => {
    radii[i] = 0;
    matrix.makeScale(0, 0, 0);
    mesh.setMatrixAt(i, matrix);
  };

  /**
   * Puts instance `i` somewhere water would actually collect, near (nx, nz).
   * Returns false when nothing suitable was found, leaving it parked.
   */
  const place = (i: number, nx: number, nz: number, spread: number): boolean => {
    for (let t = 0; t < TRIES; t++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = spread * Math.sqrt(Math.random());
      const x = nx + Math.cos(ang) * rad;
      const z = nz + Math.sin(ang) * rad;

      const slope = surfaceSlopeAt(x, z);
      if (slope > MAX_SLOPE) continue;
      // Not on the sea. `surfaceGroundHeightAt` clamps to the shoreline, so
      // without this every square metre of ocean would look perfectly flat.
      if (surfaceHeightAt(x, z) < WORLD.waterLevel + 1.2) continue;

      // Flatter ground holds a wider pool. Also keeps the relief across the
      // patch roughly constant however steep the spot happens to be.
      const outer = Math.min(MAX_RADIUS, Math.max(0.8, 0.1 / Math.max(0.004, slope)));

      // Sample the drawn surface around the rim and sit on the highest of it.
      // The quad is flat; anchoring it to the centre height is exactly how a
      // patch ends up sunk into the hillside on its uphill side.
      const centreY = surfaceGroundHeightAt(x, z);
      let hi = centreY;
      let lo = centreY;
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2;
        const h = surfaceGroundHeightAt(x + Math.cos(a) * outer, z + Math.sin(a) * outer);
        if (h > hi) hi = h;
        if (h < lo) lo = h;
      }
      if (hi - lo > MAX_RELIEF) continue;

      xs[i] = x;
      zs[i] = z;
      radii[i] = outer;
      position.set(x, hi + 0.02, z);
      rotation.setFromAxisAngle(axis, Math.random() * Math.PI * 2);
      scale.set(outer * 2, 1, outer * 2);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(i, matrix);
      seeds[i] = Math.random();
      return true;
    }
    park(i);
    return false;
  };

  const update = (
    centre: Vector3,
    elapsed: number,
    wetness: number,
    rain: number,
    tint: Color,
  ): void => {
    // Dry ground costs nothing: no placement work, no uniform writes, no draw.
    mesh.visible = wetness > 0.04;
    if (!mesh.visible) return;

    uniforms.uTime.value = elapsed;
    uniforms.uRipple.value = Math.min(1, rain);
    // Fade in over the first stretch of wetness so a shower fills them rather
    // than snapping a field of water into existence.
    uniforms.uAmount.value = Math.min(1, Math.max(0, (wetness - 0.04) / 0.3));

    // The sky's tint dims the reflection after sunset, but never all the way to
    // black — the same problem the ground mist had. Lift toward a pale tone by
    // more the darker the sky gets, or the puddles simply disappear at night.
    const luminance = tint.r * 0.3 + tint.g * 0.6 + tint.b * 0.1;
    const lift = 0.18 + (1 - Math.min(1, luminance)) * 0.3;
    uniforms.uTint.value.copy(tint).lerp(PALE, lift);

    let moved = false;
    if (!seeded) {
      seeded = true;
      for (let i = 0; i < count; i++) place(i, centre.x, centre.z, extent * 0.9);
      moved = true;
    }

    let budget = RECYCLE_PER_FRAME;
    for (let i = 0; i < count && budget > 0; i++) {
      const dx = xs[i]! - centre.x;
      const dz = zs[i]! - centre.z;
      if (radii[i]! > 0 && dx * dx + dz * dz <= limitSq) continue;
      budget--;
      moved = true;
      if (radii[i]! > 0) {
        // Reflect through the player: the patch that fell behind reappears
        // ahead, so the ring stays populated without one ever popping into view.
        const d = Math.hypot(dx, dz) || 1;
        const s = 0.6 + Math.random() * 0.4;
        place(i, centre.x - (dx / d) * extent * s, centre.z - (dz / d) * extent * s, extent * 0.3);
      } else {
        // Parked: nowhere flat was found last time. Try a fresh patch of the
        // ring rather than the same rejected spot.
        const ang = Math.random() * Math.PI * 2;
        const rad = extent * (0.35 + Math.random() * 0.55);
        place(i, centre.x + Math.cos(ang) * rad, centre.z + Math.sin(ang) * rad, extent * 0.25);
      }
    }
    if (moved) {
      mesh.instanceMatrix.needsUpdate = true;
      seedAttr.needsUpdate = true;
    }
  };

  return {
    mesh,
    update,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
      mesh.removeFromParent();
    },
  };
}
