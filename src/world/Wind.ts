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
  /** Where the current gust is heading. `gustStrength` eases toward this. */
  private gustTarget = 0;

  /** Current wind direction, for particles and other systems. */
  readonly direction = new Vector2(1, 0.35);

  update(dt: number, elapsed: number): void {
    this.uTime.value = elapsed;

    // The prevailing direction wanders slowly.
    this.baseAngle += Math.sin(elapsed * 0.037) * dt * 0.12;
    const strength = 0.55 + Math.sin(elapsed * 0.13) * 0.25;

    // Gusts: short bursts with quiet gaps between them.
    //
    // The strength eases toward a target instead of being assigned outright.
    // A hard assignment multiplied the sway amplitude of every plant in the
    // world on a single frame, so the whole forest visibly snapped into motion
    // at the same instant — which read as a glitch, not as weather.
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      this.gustTimer = 5 + Math.random() * 9;
      this.gustTarget = 0.6 + Math.random() * 0.8;
    }
    // Rise over roughly half a second, then fall away slowly.
    const rate = this.gustTarget > this.gustStrength ? 2.2 : 0.55;
    this.gustStrength += (this.gustTarget - this.gustStrength) * Math.min(1, dt * rate * 1.6);
    this.gustTarget = Math.max(0, this.gustTarget - dt * rate * 0.5);
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
         attribute float aSway;
        ` +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           {
             vec2 origin = ${originExpr};
             vec2 dir = normalize(uWind + vec2(1e-5));

             // Two scales of phase. The coarse one runs *along* the wind at a
             // ~140 m wavelength, so a gust is a band that visibly travels across
             // the landscape; the fine one decorrelates neighbouring plants so a
             // stand of trees doesn't move as one rigid block.
             float travel = dot(origin, dir);
             float coarse = travel * 0.045 - uTime * 1.1;
             float fine = origin.x * 0.31 + origin.y * 0.24;
             float wave = sin(uTime * 1.6 + fine) + 0.5 * sin(uTime * 3.1 + fine * 1.7);

             // The gust arrives as a moving front rather than as a global
             // multiplier. Multiplying every plant's amplitude at once was why
             // the whole forest snapped into motion on the same frame.
             float front = 0.45 + 0.55 * (0.5 + 0.5 * sin(coarse));
             float gust = uGust * front;

             // Compliance: how far above the anchor point this vertex is, times
             // how willing the material is to bend. Trunks carry a low aSway, so
             // the crown moves and the pole underneath barely does.
             float height = max(0.0, transformed.y - uPivot);
             float amount = aSway * height * height * uStiffness * 0.045 * (1.0 + gust);
             // Bounded so a tall tree can't fling its canopy metres sideways.
             amount = min(amount, 1.4);
             transformed.xz += uWind * wave * amount;
           }`,
        );
    };
    material.customProgramCacheKey = () => `wind-${stiffness}-${pivotHeight}-${instanced ? 'i' : 'm'}`;
  }
}
