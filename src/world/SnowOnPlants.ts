import type { MeshStandardMaterial } from 'three';
import { snowUniforms, SNOW_GLSL, SNOW_UNIFORM_DECL } from './SnowState.ts';

/**
 * SnowOnPlants
 * ------------
 * Puts the lying snow onto the vegetation, so grass and leaves go white with the
 * ground instead of standing green in a snowfield.
 *
 * This is a *composition* over whatever the material already does in
 * `onBeforeCompile`, not a replacement. The wind owns that hook on every plant
 * material and assigns it outright, so writing a second one would throw the sway
 * away — and the symptom would be "the wind stopped working", which points nowhere
 * near here. Chaining keeps both, in a fixed order, whoever is applied first.
 *
 * The coverage itself is not decided here: it comes from the shared `snowAt` in
 * `SnowState`, the same function and the same uniforms the ground uses. That is the
 * whole point — two copies of a snowline drift apart, and the drift is visible.
 */

/**
 * How far up a plant snow reaches, as a fraction of its own height above the ground
 * it stands on, in metres.
 *
 * Snow lands on top of foliage rather than coating it evenly: a grass blade is white
 * at the tip and green at the base, and the stems under a bush stay dark. Anything
 * else reads as the plant having been painted.
 *
 * It has to be measured against the *short* plants, not the tall ones. This was
 * 1.5 m, chosen for how a tree looks — and a grass tuft is about 0.3 m tall, so the
 * ramp barely left the floor across its entire height and the grass stayed green in
 * a white field, which is the bug this was written to fix in the first place. At
 * 0.35 m the tufts and the clumps whiten properly, and height still does the work
 * on anything larger.
 */
const SETTLE_HEIGHT = 0.35;

/** Fresh snow on foliage, a touch cooler than on the ground: it is thinner there. */
const SNOW_ON_LEAF = 'vec3( 0.86, 0.90, 0.96 )';

export function applySnowToPlants(material: MeshStandardMaterial): void {
  const previous = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    // Whatever was there first — the wind, in practice — runs unchanged.
    previous?.call(material, shader, renderer);

    Object.assign(shader.uniforms, snowUniforms);

    // The world position and how high this vertex sits above the plant's own base.
    //
    // `transformed` is used rather than `position` because the wind has already bent
    // it by this point, so the snow follows a blade that is leaning instead of
    // sitting where the blade would have been in still air.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vSnowWorld;\nvarying float vSnowUp;\nvarying float vSnowFace;',
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
        {
          vec4 snowWorld = modelMatrix * vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            snowWorld = modelMatrix * instanceMatrix * vec4( transformed, 1.0 );
          #endif
          vSnowWorld = snowWorld.xyz;
          // Height above the instance's own origin, which for every one of these
          // layers is planted on the ground — so this is height above the ground
          // without needing to sample it.
          vSnowUp = transformed.y;
          // How much this surface faces the sky, carried on its own varying.
          //
          // three's \`vNormal\` cannot be used: every one of these materials is
          // flat-shaded, and for flat shading three does not declare that varying at
          // all — it derives the normal from screen-space derivatives instead. Reading
          // it fails to compile, which is exactly what happened, and the error names
          // an unrelated chunk further down the file.
          vec3 snowN = normal;
          #ifdef USE_INSTANCING
            snowN = mat3( instanceMatrix ) * snowN;
          #endif
          vSnowFace = normalize( mat3( modelMatrix ) * snowN ).y;
        }
        #include <project_vertex>
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vSnowWorld;
        varying float vSnowUp;
        varying float vSnowFace;
        ${SNOW_UNIFORM_DECL}
        ${SNOW_GLSL}
        `,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        {
          // The *world* test asks for straight up, always. A blade of grass has no
          // meaningful face of its own — the clumps are single-sided cards leaning in
          // every direction — so using their real normals would make half of every
          // clump shed snow for no reason a player could see.
          float lying = snowAt( vSnowWorld, vec3( 0.0, 1.0, 0.0 ) );
          // Thicker towards the top of the plant, nothing right at the base.
          float settle = lying * smoothstep( 0.0, ${SETTLE_HEIGHT.toFixed(2)}, vSnowUp );
          // Upward-facing surfaces collect more. Kept well above zero at the bottom
          // of the range so the grass cards — whose normals point sideways — still
          // whiten; this is a weighting, not a gate.
          settle *= 0.55 + 0.45 * max( vSnowFace, 0.0 );
          if ( settle > 0.0 ) {
            diffuseColor.rgb = mix( diffuseColor.rgb, ${SNOW_ON_LEAF}, settle );
          }
        }
        `,
      )
      // Snow is rough, and says so after the base roughness has been decided.
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = mix(
          roughnessFactor,
          0.94,
          snowAt( vSnowWorld, vec3( 0.0, 1.0, 0.0 ) ) *
            smoothstep( 0.0, ${SETTLE_HEIGHT.toFixed(2)}, vSnowUp ) * 0.8
        );
        `,
      );
  };

  // Forces a fresh program. Materials built before this was applied would otherwise
  // keep their cached shader, and the snow would appear only after some unrelated
  // change happened to invalidate it.
  material.needsUpdate = true;
}
