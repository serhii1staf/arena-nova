import { Vector2, type IUniform, type MeshStandardMaterial } from 'three';

/**
 * Wind
 * ----
 * A single global wind state shared by every material that sways. Direction and
 * strength drift over time and gusts roll through, so the whole world moves
 * together instead of each patch of grass doing its own thing.
 *
 * Materials opt in via `applyWindSway`, which injects a vertex-shader snippet.
 * Because all of them reference the *same* uniform objects, updating the wind is
 * one assignment per frame no matter how much foliage is on screen.
 */
export class Wind {
  /** Seconds since start, driving all oscillation. */
  readonly uTime: IUniform<number> = { value: 0 };
  /** xy = wind direction × strength. */
  readonly uWind: IUniform<Vector2> = { value: new Vector2(1, 0.35) };
  /** Extra multiplier during a gust. */
  readonly uGust: IUniform<number> = { value: 0 };

  private baseAngle = 0.6;
  private gustTimer = 6;
  private gustStrength = 0;

  /** Current wind direction, for particles and other systems. */
  readonly direction = new Vector2(1, 0.35);

  update(dt: number, elapsed: number): void {
    this.uTime.value = elapsed;

    // The prevailing direction wanders slowly.
    this.baseAngle += Math.sin(elapsed * 0.037) * dt * 0.12;
    const strength = 0.55 + Math.sin(elapsed * 0.13) * 0.25;

    // Gusts: short bursts with quiet gaps between them.
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      this.gustTimer = 5 + Math.random() * 9;
      this.gustStrength = 0.6 + Math.random() * 0.8;
    }
    this.gustStrength = Math.max(0, this.gustStrength - dt * 0.55);
    this.uGust.value = this.gustStrength;

    const total = strength * (1 + this.gustStrength * 0.7);
    this.direction.set(Math.cos(this.baseAngle), Math.sin(this.baseAngle));
    this.uWind.value.copy(this.direction).multiplyScalar(total);
  }

  /**
   * Makes a material's geometry bend with the wind.
   *
   * `stiffness` scales how much the top of the mesh moves: grass ≈ 1, a heavy
   * tree canopy ≈ 0.12. `pivotHeight` is the local Y above which bending starts,
   * so trunks stay planted while crowns move.
   */
  applyWindSway(
    material: MeshStandardMaterial,
    stiffness: number,
    pivotHeight = 0,
    instanced = true,
  ): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.uniforms.uWind = this.uWind;
      shader.uniforms.uGust = this.uGust;
      shader.uniforms.uStiffness = { value: stiffness };
      shader.uniforms.uPivot = { value: pivotHeight };

      // Instanced meshes carry their world position in the instance matrix; a
      // plain mesh uses its model matrix. Either way we need a per-object offset
      // so neighbouring plants aren't in perfect sync.
      const originExpr = instanced
        ? 'vec2(instanceMatrix[3].x, instanceMatrix[3].z)'
        : 'vec2(modelMatrix[3].x, modelMatrix[3].z)';

      shader.vertexShader =
        `uniform float uTime;
         uniform vec2 uWind;
         uniform float uGust;
         uniform float uStiffness;
         uniform float uPivot;
        ` +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           {
             vec2 origin = ${originExpr};
             // Phase offset per plant, plus a travelling wave so gusts visibly
             // roll across the landscape rather than hitting everything at once.
             float phase = origin.x * 0.35 + origin.y * 0.27;
             float wave = sin(uTime * 1.6 + phase) + 0.5 * sin(uTime * 3.1 + phase * 1.7);
             float height = max(0.0, transformed.y - uPivot);
             float amount = height * height * uStiffness * 0.045 * (1.0 + uGust);
             transformed.xz += uWind * wave * amount;
           }`,
        );
    };
    material.customProgramCacheKey = () => `wind-${stiffness}-${pivotHeight}-${instanced ? 'i' : 'm'}`;
  }
}
