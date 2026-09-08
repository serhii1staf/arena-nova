import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  DoubleSide,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

interface Disposable {
  dispose(): void;
}

export interface DragonBuild {
  group: Group;
  update(elapsed: number, dt: number): void;
  dispose(): void;
}

function paint(geo: BufferGeometry, c: Color): BufferGeometry {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new BufferAttribute(arr, 3));
  return geo;
}

/** A membranous wing: a webbed triangle fan with finger struts along the top. */
function buildWingGeometry(span: number, chord: number, membrane: Color, bone: Color): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Membrane: a scalloped sheet spanning outward along +X.
  const seg = 4;
  const verts: number[] = [];
  for (let i = 0; i < seg; i++) {
    const x0 = (i / seg) * span;
    const x1 = ((i + 1) / seg) * span;
    // Trailing edge sweeps back and tapers toward the tip.
    const c0 = chord * (1 - (i / seg) * 0.55);
    const c1 = chord * (1 - ((i + 1) / seg) * 0.55);
    const scallop = 0.18 * chord;
    verts.push(x0, 0, 0, x1, 0, 0, x0, -0.04, c0);
    verts.push(x1, 0, 0, x1, -0.04, c1, x0, -0.04, c0);
    // Scalloped notch between fingers for a bat-wing silhouette.
    verts.push(x1, -0.04, c1, x1, -0.02, c1 - scallop, x0, -0.04, c0);
  }
  const membraneGeo = new BufferGeometry();
  const mVerts = new Float32Array(verts);
  membraneGeo.setAttribute('position', new BufferAttribute(mVerts, 3));
  // The struts below come from cone geometries that carry `uv`; every geometry in
  // a merge must share the same attribute set, so give the membrane UVs too.
  const mUv = new Float32Array((mVerts.length / 3) * 2);
  for (let i = 0; i < mVerts.length / 3; i++) {
    mUv[i * 2] = mVerts[i * 3]! / Math.max(span, 1e-4);
    mUv[i * 2 + 1] = mVerts[i * 3 + 2]! / Math.max(chord, 1e-4);
  }
  membraneGeo.setAttribute('uv', new BufferAttribute(mUv, 2));
  membraneGeo.computeVertexNormals();
  parts.push(paint(membraneGeo, membrane));

  // Leading-edge bone + finger struts.
  const arm = new ConeGeometry(0.12, span, 5);
  arm.rotateZ(-Math.PI / 2);
  arm.translate(span / 2, 0, 0);
  parts.push(paint(arm, bone));
  for (let i = 1; i <= seg; i++) {
    const x = (i / seg) * span;
    const c = chord * (1 - (i / seg) * 0.55);
    const finger = new ConeGeometry(0.06, c, 4);
    finger.rotateX(-Math.PI / 2);
    finger.translate(x, -0.02, c / 2);
    parts.push(paint(finger, bone));
  }

  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()), false);
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * Dragon
 * ------
 * A procedural low-poly dragon that soars a lazy circuit over the island: body
 * bobs with the wingbeat, wings flap and feather, the neck and tail undulate,
 * and it banks into its turns. Purely cosmetic life for the sky.
 */
export function buildDragon(center: Vector3, radius: number, altitude: number): DragonBuild {
  const group = new Group();
  group.name = 'Dragon';
  const disposables: Disposable[] = [];
  const track = <T extends Disposable>(d: T): T => (disposables.push(d), d);

  const scaleDark = new Color(0.16, 0.2, 0.24);
  const scaleMid = new Color(0.24, 0.3, 0.32);
  const membrane = new Color(0.34, 0.26, 0.3);
  const bone = new Color(0.2, 0.22, 0.22);
  const horn = new Color(0.62, 0.58, 0.5);

  const mat = track(
    new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.08,
      flatShading: true,
      side: DoubleSide,
    }),
  );

  const body = new Group();
  group.add(body);

  // --- Torso: tapered chain of faceted segments (nose −Z, tail +Z) ---
  {
    const parts: BufferGeometry[] = [];
    const segs = 5;
    for (let i = 0; i < segs; i++) {
      const t = i / (segs - 1);
      const r = 0.85 - Math.abs(t - 0.35) * 0.9;
      const seg = new IcosahedronGeometry(Math.max(0.28, r), 0);
      seg.scale(1, 0.85, 1.25);
      seg.translate(0, 0, -1.4 + i * 1.05);
      parts.push(paint(seg, i % 2 ? scaleDark : scaleMid));
    }
    const merged = track(mergeGeometries(parts.map((p) => p.toNonIndexed()), false));
    for (const p of parts) p.dispose();
    const torso = new Mesh(merged, mat);
    torso.castShadow = true;
    body.add(torso);
  }

  // --- Neck + head (segments animated for undulation) ---
  const neckSegments: Mesh[] = [];
  {
    const geo = track(
      (() => {
        const g = new IcosahedronGeometry(0.42, 0);
        g.scale(1, 0.9, 1.3);
        return paint(g, scaleMid);
      })(),
    );
    for (let i = 0; i < 4; i++) {
      const seg = new Mesh(geo, mat);
      const t = i / 3;
      seg.position.set(0, 0.1 + t * 0.5, -1.9 - i * 0.66);
      seg.scale.setScalar(1 - t * 0.28);
      seg.castShadow = true;
      neckSegments.push(seg);
      body.add(seg);
    }

    // Head with jaw and horns.
    const headParts: BufferGeometry[] = [];
    const skull = new IcosahedronGeometry(0.42, 0);
    skull.scale(0.9, 0.8, 1.5);
    headParts.push(paint(skull, scaleMid));
    const snout = new ConeGeometry(0.24, 0.9, 5);
    snout.rotateX(-Math.PI / 2);
    snout.translate(0, -0.06, -0.85);
    headParts.push(paint(snout, scaleMid));
    for (const sx of [-1, 1]) {
      const h = new ConeGeometry(0.09, 0.75, 4);
      h.rotateX(0.5);
      h.translate(sx * 0.2, 0.32, 0.3);
      headParts.push(paint(h, horn));
    }
    const headGeo = track(mergeGeometries(headParts.map((p) => p.toNonIndexed()), false));
    for (const p of headParts) p.dispose();
    const head = new Mesh(headGeo, mat);
    head.position.set(0, 0.72, -4.6);
    head.castShadow = true;
    neckSegments.push(head);
    body.add(head);
  }

  // --- Tail ---
  const tailSegments: Mesh[] = [];
  {
    const geo = track(
      (() => {
        const g = new IcosahedronGeometry(0.36, 0);
        g.scale(1, 0.85, 1.35);
        return paint(g, scaleDark);
      })(),
    );
    for (let i = 0; i < 6; i++) {
      const seg = new Mesh(geo, mat);
      const t = i / 5;
      seg.position.set(0, 0, 3.4 + i * 0.72);
      seg.scale.setScalar(1 - t * 0.7);
      seg.castShadow = true;
      tailSegments.push(seg);
      body.add(seg);
    }
    // Tail fin.
    const fin = track(paint(new PlaneGeometry(0.9, 1.5), membrane));
    const finMesh = new Mesh(fin, mat);
    finMesh.rotation.y = Math.PI / 2;
    finMesh.position.set(0, 0.1, 7.9);
    body.add(finMesh);
  }

  // --- Wings ---
  const wingGeo = track(buildWingGeometry(5.6, 3.2, membrane, bone));
  const wingL = new Group();
  const wingR = new Group();
  {
    // Shoulder joints sit *inside* the torso silhouette and the wing root starts
    // slightly overlapped, so the wings stay attached through the whole flap.
    const jointGeo = track(
      (() => {
        const g = new IcosahedronGeometry(0.34, 0);
        return paint(g, scaleMid);
      })(),
    );
    for (const sx of [1, -1]) {
      const joint = new Mesh(jointGeo, mat);
      joint.position.set(sx * 0.62, 0.34, -0.2);
      joint.castShadow = true;
      body.add(joint);
    }

    const meshL = new Mesh(wingGeo, mat);
    meshL.castShadow = true;
    meshL.position.x = -0.18; // overlap the shoulder so there's never a gap
    wingL.add(meshL);
    wingL.position.set(0.62, 0.34, -0.2);
    const meshR = new Mesh(wingGeo, mat);
    meshR.castShadow = true;
    meshR.scale.x = -1; // mirror
    meshR.position.x = 0.18;
    wingR.add(meshR);
    wingR.position.set(-0.62, 0.34, -0.2);
    body.add(wingL, wingR);
  }

  // --- Dorsal spines ---
  {
    const parts: BufferGeometry[] = [];
    for (let i = 0; i < 12; i++) {
      const t = i / 11;
      const spine = new ConeGeometry(0.09, 0.5 + Math.sin(t * Math.PI) * 0.45, 4);
      spine.translate(0, 0.7 - t * 0.1, -2.2 + i * 0.78);
      parts.push(paint(spine, horn));
    }
    const merged = track(mergeGeometries(parts.map((p) => p.toNonIndexed()), false));
    for (const p of parts) p.dispose();
    const spines = new Mesh(merged, mat);
    body.add(spines);
  }

  const pos = new Vector3();
  const update = (elapsed: number, _dt: number): void => {
    // Flight path: a slow circle with gentle altitude drift.
    const speed = 0.075;
    const a = elapsed * speed;
    pos.set(
      center.x + Math.cos(a) * radius,
      center.y + altitude + Math.sin(elapsed * 0.22) * 9,
      center.z + Math.sin(a) * radius,
    );
    group.position.copy(pos);
    // Face along the tangent of the circle. Position is (cos a, sin a)·R, so the
    // velocity direction is (−sin a, cos a). The model's nose points −Z, which
    // after a yaw θ becomes (−sin θ, −cos θ). Solving both gives θ = π − a.
    // (The previous −a + π/2 was 90° off, which is why it flew sideways.)
    group.rotation.y = Math.PI - a;
    // Roll into the turn (applied innermost with Euler XYZ, so it's a true bank)
    // and pitch gently with the climb/descent.
    group.rotation.z = 0.3;
    group.rotation.x = Math.cos(elapsed * 0.22) * 0.1;

    // Wingbeat: sweep + feathering, slower at the top of the stroke.
    const beat = elapsed * 1.5;
    const flap = Math.sin(beat);
    wingL.rotation.z = -0.16 + flap * 0.72;
    wingR.rotation.z = 0.16 - flap * 0.72;
    wingL.rotation.x = Math.cos(beat) * 0.22;
    wingR.rotation.x = Math.cos(beat) * 0.22;

    // Body bobs opposite the downstroke.
    body.position.y = -flap * 0.28;

    // Neck and tail undulate with a travelling wave.
    neckSegments.forEach((seg, i) => {
      seg.position.x = Math.sin(beat * 0.5 - i * 0.5) * 0.1 * (i + 1) * 0.4;
      seg.position.y = 0.1 + (i / 3) * 0.5 + Math.sin(beat * 0.5 - i * 0.4) * 0.06;
    });
    tailSegments.forEach((seg, i) => {
      const t = i / 5;
      seg.position.x = Math.sin(beat * 0.6 - i * 0.55) * 0.5 * t;
      seg.position.y = Math.cos(beat * 0.6 - i * 0.55) * 0.28 * t;
    });
  };

  const dispose = (): void => {
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    disposables.length = 0;
  };

  return { group, update, dispose };
}
