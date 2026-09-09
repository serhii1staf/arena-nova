import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  IcosahedronGeometry,
  LatheGeometry,
  type MeshStandardMaterial,
  Shape,
  ExtrudeGeometry,
  type Texture,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three';

/**
 * Low-level, reusable geometry builders for the procedural cathedral.
 * Everything here returns a BufferGeometry positioned in local space; the
 * assembler (Cathedral) places, merges or instances them.
 */

/** Points of a pointed (gothic) arch, left spring → apex → right spring. */
export function pointedArchPoints(
  halfSpan: number,
  rise: number,
  yBase: number,
  segments = 16,
): Vector2[] {
  const pts: Vector2[] = [];
  // Left half: quadratic Bézier from spring to apex.
  const l0 = new Vector2(-halfSpan, yBase);
  const l1 = new Vector2(-halfSpan, yBase + rise);
  const l2 = new Vector2(0, yBase + rise);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const it = 1 - t;
    pts.push(
      new Vector2(
        it * it * l0.x + 2 * it * t * l1.x + t * t * l2.x,
        it * it * l0.y + 2 * it * t * l1.y + t * t * l2.y,
      ),
    );
  }
  // Right half mirrors the left (skip the shared apex point).
  const r0 = new Vector2(0, yBase + rise);
  const r1 = new Vector2(halfSpan, yBase + rise);
  const r2 = new Vector2(halfSpan, yBase);
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const it = 1 - t;
    pts.push(
      new Vector2(
        it * it * r0.x + 2 * it * t * r1.x + t * t * r2.x,
        it * it * r0.y + 2 * it * t * r1.y + t * t * r2.y,
      ),
    );
  }
  return pts;
}

/**
 * A fluted column with a flared base and capital, generated as a lathe.
 * The profile subtly swells (entasis) for a classical, hand-built feel.
 */
export function buildColumnGeometry(height: number, radius: number): BufferGeometry {
  const p: Vector2[] = [];
  const baseH = height * 0.08;
  const capH = height * 0.09;
  const shaftH = height - baseH - capH;

  p.push(new Vector2(0, 0));
  p.push(new Vector2(radius * 1.55, 0)); // plinth
  p.push(new Vector2(radius * 1.5, baseH * 0.4));
  p.push(new Vector2(radius * 1.18, baseH)); // top of base
  // Shaft with slight entasis.
  const shaftSteps = 6;
  for (let i = 0; i <= shaftSteps; i++) {
    const t = i / shaftSteps;
    const y = baseH + t * shaftH;
    const swell = Math.sin(t * Math.PI) * 0.04;
    p.push(new Vector2(radius * (1 - t * 0.12 + swell), y));
  }
  // Capital.
  p.push(new Vector2(radius * 1.05, baseH + shaftH + capH * 0.35));
  p.push(new Vector2(radius * 1.5, baseH + shaftH + capH * 0.72));
  p.push(new Vector2(radius * 1.62, baseH + shaftH + capH));
  p.push(new Vector2(0, baseH + shaftH + capH));

  const geo = new LatheGeometry(p, 20);
  geo.computeVertexNormals();
  return geo;
}

/**
 * A rounded stone rib following a pointed arch, swept as a tube. Lives in the
 * XY plane (z = 0); rotate/position it at the call site.
 */
export function buildArchRibGeometry(span: number, rise: number, tubeRadius: number): BufferGeometry {
  const pts2d = pointedArchPoints(span / 2, rise, 0, 14);
  const pts3d = pts2d.map((v) => new Vector3(v.x, v.y, 0));
  const curve = new CatmullRomCurve3(pts3d, false, 'catmullrom', 0.4);
  const geo = new TubeGeometry(curve, 60, tubeRadius, 8, false);
  return geo;
}

/**
 * A vaulted ceiling shell: a pointed-arch "band" cross-section extruded along
 * Z. Produces a continuous stone vault spanning the nave.
 */
export function buildVaultGeometry(
  width: number,
  springH: number,
  ridgeH: number,
  length: number,
  thickness: number,
): BufferGeometry {
  const halfSpan = width / 2;
  const rise = ridgeH - springH;
  const inner = pointedArchPoints(halfSpan, rise, springH, 20);
  const outer = pointedArchPoints(halfSpan + thickness, rise + thickness, springH, 20);

  const shape = new Shape();
  // Outer contour left→right over the top.
  shape.moveTo(outer[0]!.x, outer[0]!.y);
  for (let i = 1; i < outer.length; i++) shape.lineTo(outer[i]!.x, outer[i]!.y);
  // Back along the inner contour right→left, forming a closed band.
  for (let i = inner.length - 1; i >= 0; i--) shape.lineTo(inner[i]!.x, inner[i]!.y);
  shape.closePath();

  const geo = new ExtrudeGeometry(shape, {
    depth: length,
    bevelEnabled: false,
    steps: 1,
  });
  // Extrude grows +Z; center it on the origin along Z.
  geo.translate(0, 0, -length / 2);
  geo.computeVertexNormals();
  return geo;
}

/** A box translated so its center sits at (cx, cy, cz). */
export function boxAt(
  w: number,
  h: number,
  d: number,
  cx: number,
  cy: number,
  cz: number,
): BufferGeometry {
  const geo = new BoxGeometry(w, h, d);
  geo.translate(cx, cy, cz);
  return geo;
}

/** A thin, tall pointed-arch window frame (as a mergeable band). */
export function buildWindowArchGeometry(
  width: number,
  totalHeight: number,
  frame: number,
  depth: number,
): BufferGeometry {
  const halfSpan = width / 2;
  const springH = totalHeight - halfSpan; // apex forms a natural point
  const rise = halfSpan;
  const inner = pointedArchPoints(halfSpan - frame, rise, springH, 14);
  const outer = pointedArchPoints(halfSpan, rise, springH, 14);

  const shape = new Shape();
  shape.moveTo(-halfSpan, 0);
  shape.lineTo(-halfSpan, springH);
  for (const pt of outer) shape.lineTo(pt.x, pt.y);
  shape.lineTo(halfSpan, 0);
  shape.lineTo(halfSpan - frame, 0);
  shape.lineTo(halfSpan - frame, springH);
  for (let i = inner.length - 1; i >= 0; i--) shape.lineTo(inner[i]!.x, inner[i]!.y);
  shape.lineTo(-halfSpan + frame, springH);
  shape.lineTo(-halfSpan + frame, 0);
  shape.closePath();

  const geo = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
  geo.translate(0, 0, -depth / 2);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Assigns triplanar-style UVs so a tiling texture keeps a *uniform* world-space
 * density regardless of how big or stretched a face is. Fixes the "smeared
 * texture" look on large walls, floors, the vault and stairs.
 *
 * The projection axis is chosen **per triangle**, not per vertex. Choosing it per
 * vertex is fine for axis-aligned boxes, where all three vertices of a face agree
 * — but on anything faceted, like a boulder, neighbouring vertices pick different
 * axes and the UVs then interpolate between two unrelated projections across the
 * face. That shows up as bright smeared bands running through the surface.
 *
 * Per-face projection needs each triangle to own its vertices, so it only applies
 * to non-indexed geometry. Indexed input keeps the per-vertex path: its vertices
 * are shared between faces, so there is no single correct axis for them anyway.
 */
export function applyTriplanarUV(geo: BufferGeometry, tilesPerUnit = 0.35): BufferGeometry {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal!;
  const count = pos.count;
  const uv = new Float32Array(count * 2);

  /** Projects one vertex using an axis picked from the supplied normal. */
  const project = (i: number, nx: number, ny: number, nz: number): void => {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    let u: number;
    let v: number;
    if (nx >= ny && nx >= nz) {
      u = pz;
      v = py;
    } else if (ny >= nx && ny >= nz) {
      u = px;
      v = pz;
    } else {
      u = px;
      v = py;
    }
    uv[i * 2] = u * tilesPerUnit;
    uv[i * 2 + 1] = v * tilesPerUnit;
  };

  if (!geo.index && count % 3 === 0) {
    // Per-face: average the triangle's vertex normals, pick one axis, apply it to
    // all three vertices so the UVs stay planar across the whole face.
    for (let t = 0; t < count; t += 3) {
      const ax = nor.getX(t) + nor.getX(t + 1) + nor.getX(t + 2);
      const ay = nor.getY(t) + nor.getY(t + 1) + nor.getY(t + 2);
      const az = nor.getZ(t) + nor.getZ(t + 1) + nor.getZ(t + 2);
      const nx = Math.abs(ax);
      const ny = Math.abs(ay);
      const nz = Math.abs(az);
      project(t, nx, ny, nz);
      project(t + 1, nx, ny, nz);
      project(t + 2, nx, ny, nz);
    }
  } else {
    for (let i = 0; i < count; i++) {
      project(i, Math.abs(nor.getX(i)), Math.abs(nor.getY(i)), Math.abs(nor.getZ(i)));
    }
  }

  geo.setAttribute('uv', new BufferAttribute(uv, 2));
  return geo;
}

/** Rescales a lathe's existing UVs so a cylindrical surface tiles evenly. */
export function scaleLatheUV(
  geo: BufferGeometry,
  radius: number,
  height: number,
  tilesPerUnit = 0.35,
): BufferGeometry {
  const uvAttr = geo.attributes.uv as BufferAttribute | undefined;
  if (!uvAttr) return geo;
  const uScale = 2 * Math.PI * radius * tilesPerUnit;
  const vScale = height * tilesPerUnit;
  for (let i = 0; i < uvAttr.count; i++) {
    uvAttr.setXY(i, uvAttr.getX(i) * uScale, uvAttr.getY(i) * vScale);
  }
  uvAttr.needsUpdate = true;
  return geo;
}

/**
 * A believable, irregular boulder: an icosphere pushed around by layered
 * value noise. Deterministic per `seed` so the scene is stable. Replaces the
 * old cube "rubble".
 */
export function buildRockGeometry(seed: number, detail = 2): BufferGeometry {
  const geo = new IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;
  const v = new Vector3();
  const hash = (x: number, y: number, z: number): number => {
    let h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 0.137) * 43758.5453;
    h -= Math.floor(h);
    return h;
  };
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    // A few octaves of directional noise for lumpy but rounded rock.
    const n =
      0.28 * Math.sin(v.x * 3.1 + seed) +
      0.2 * Math.cos(v.y * 4.7 + seed * 1.7) +
      0.16 * Math.sin(v.z * 5.9 + seed * 2.3) +
      0.12 * (hash(v.x * 2, v.y * 2, v.z * 2) - 0.5);
    const r = 1 + n * 0.45;
    // Flatten the base a touch so rocks sit on the ground.
    const flat = v.y < -0.3 ? 0.7 : 1;
    v.multiplyScalar(r);
    v.y *= flat;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  applyTriplanarUV(geo, 0.5);
  return geo;
}

/**
 * Samples a tiling texture as a true triplanar blend, in object space, instead of
 * through the geometry's UV attribute.
 *
 * Baked triplanar UVs (see `applyTriplanarUV`) are fine on flat, axis-aligned
 * surfaces, but on a faceted shape like a boulder every facet picks a different
 * projection axis and the UVs become discontinuous at each edge. A discontinuity
 * makes the GPU's screen-space UV derivatives explode, so it selects a much
 * coarser mip level for that row of pixels — which shows up as a thin dark line
 * traced around every facet.
 *
 * Blending three projections per fragment, weighted by the surface normal, has no
 * seams at all. It costs three texture reads instead of one, which is why it is
 * reserved for the handful of materials that actually need it.
 */
export function applyTriplanarTexture(
  material: MeshStandardMaterial,
  map: Texture,
  tilesPerUnit = 0.7,
): void {
  // `map` still has to be assigned so three compiles the USE_MAP path and binds
  // the sampler; the injected code replaces how it is read, not whether it exists.
  material.map = map;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTriScale = { value: tilesPerUnit };

    shader.vertexShader =
      `varying vec3 vTriPos;
       varying vec3 vTriNormal;
      ` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vTriPos = position;
         vTriNormal = normal;`,
      );

    shader.fragmentShader =
      `uniform float uTriScale;
       varying vec3 vTriPos;
       varying vec3 vTriNormal;
      ` +
      shader.fragmentShader.replace(
        '#include <map_fragment>',
        `{
           // Weights biased hard toward the dominant axis, so the blend band is
           // narrow and the texture stays crisp on flat-ish faces.
           vec3 bw = abs(normalize(vTriNormal));
           bw = pow(bw, vec3(6.0));
           bw /= max(1e-4, bw.x + bw.y + bw.z);
           vec2 uvX = vTriPos.zy * uTriScale;
           vec2 uvY = vTriPos.xz * uTriScale;
           vec2 uvZ = vTriPos.xy * uTriScale;
           vec4 tri = texture2D(map, uvX) * bw.x
                    + texture2D(map, uvY) * bw.y
                    + texture2D(map, uvZ) * bw.z;
           diffuseColor *= tri;
         }`,
      );
  };
  material.customProgramCacheKey = () => `triplanar-${tilesPerUnit}`;
}
