import {
  BoxGeometry,
  BufferAttribute,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  type BufferGeometry,
  Vector3,
} from 'three';

interface Disposable {
  dispose(): void;
}

export interface LocomotionState {
  speed01: number;
  grounded: boolean;
  phase: number;
  /**
   * Signed vertical speed, m/s. Optional so a caller that has no meaningful
   * value can leave it out; the rig then treats airborne as falling, which is
   * the safe reading. Without it the jump clip is unreachable, because
   * `grounded` alone cannot tell rising from falling.
   */
  vy?: number;
}

/**
 * CharacterModel
 * --------------
 * A hand-built, low-poly hooded ranger (no external assets). Flat shading gives
 * it crisp, "modelled" facets rather than soft blobs. Limbs hang from real joint
 * pivots so walk / run / jump / idle are driven procedurally, and a curved cloak
 * sways with movement. The model faces −Z locally; the root yaw turns it to face
 * the travel direction.
 */
export class CharacterModel {
  readonly object = new Group();

  private readonly body = new Group();
  private readonly root = new Group();
  private readonly armL = new Group();
  private readonly armR = new Group();
  private readonly foreArmL = new Group();
  private readonly foreArmR = new Group();
  private readonly legL = new Group();
  private readonly legR = new Group();
  private readonly shinL = new Group();
  private readonly shinR = new Group();
  private readonly cloak = new Group();

  private readonly geos: BufferGeometry[] = [];
  private readonly mats: Disposable[] = [];
  private idleTime = 0;

  // ---- Cloak cloth simulation ----
  private static readonly CLOAK_COLS = 15;
  private static readonly CLOAK_ROWS = 11;
  /** Cloth is simulated at a fixed 60 Hz regardless of render frame rate. */
  private static readonly CLOTH_STEP = 1 / 60;
  private clothAccumulator = 0;
  private cloakRest = new Float32Array(0);
  private cloakCurrent = new Float32Array(0);
  private cloakPrev = new Float32Array(0);
  private cloakGeo: BufferGeometry | null = null;
  private readonly prevWorldPos = new Vector3();
  private prevYaw = 0;
  private firstUpdate = true;
  private static readonly scratchWind = new Vector3();
  /** Elbow/hand colliders (model-local) that push the cloak from inside. */
  private readonly limbColliders = [
    { x: 0, y: 0, z: 0, r: 0.12 }, // left elbow
    { x: 0, y: 0, z: 0, r: 0.12 }, // left hand
    { x: 0, y: 0, z: 0, r: 0.12 }, // right elbow
    { x: 0, y: 0, z: 0, r: 0.12 }, // right hand
  ];

  constructor() {
    const tunic = this.mat(0.22, 0.36, 0.26);
    const cloak = this.mat(0.14, 0.26, 0.2);
    const hood = this.mat(0.17, 0.29, 0.22);
    const wrap = this.mat(0.2, 0.32, 0.25); // cloth wrappings (arms, head)
    const leather = this.mat(0.26, 0.19, 0.12);
    const dark = this.mat(0.05, 0.06, 0.06);
    cloak.side = DoubleSide; // the curved cape must show both faces
    // Smooth-shaded so the simulated cloth doesn't show hard facet banding.
    cloak.flatShading = false;
    cloak.roughness = 0.95;

    this.object.add(this.body);
    this.body.add(this.root);

    // --- Torso ---
    this.root.add(this.box(tunic, 0.34, 0.24, 0.24, 0, 0.98, 0)); // pelvis
    this.root.add(this.box(leather, 0.37, 0.07, 0.26, 0, 1.08, 0)); // belt
    this.root.add(this.box(tunic, 0.32, 0.28, 0.23, 0, 1.22, 0)); // waist
    this.root.add(this.box(tunic, 0.44, 0.34, 0.25, 0, 1.45, 0)); // chest

    // --- Head: fully wrapped. No skin is ever visible: the head is a cloth
    // shell with a bandana band and a dark void where the face would be. In
    // multiplayer every other player therefore sees an anonymous figure. ---
    this.root.add(this.cyl(wrap, 0.09, 0.1, 0.12, 0, 1.66, 0)); // neck wrap
    const skull = new Mesh(this.geo(new SphereGeometry(0.155, 12, 10)), wrap);
    skull.position.set(0, 1.81, 0);
    skull.scale.set(1, 1.1, 1.06);
    this.root.add(skull);
    // Bandana: a broad wrap over the crown plus a band across the brow, so the
    // whole head is covered in cloth from every angle.
    const crownWrap = new Mesh(this.geo(new SphereGeometry(0.168, 12, 8, 0, Math.PI * 2, 0, 1.5)), leather);
    crownWrap.position.set(0, 1.83, 0);
    crownWrap.scale.set(1.02, 1.05, 1.04);
    this.root.add(crownWrap);
    const band = new Mesh(this.geo(new CylinderGeometry(0.172, 0.176, 0.1, 12)), leather);
    band.position.set(0, 1.8, 0);
    band.rotation.x = 0.07;
    this.root.add(band);
    // Knot and two trailing tails at the back.
    this.root.add(this.box(leather, 0.07, 0.07, 0.07, 0, 1.81, 0.165));
    for (const [ox, tilt] of [
      [0.03, -0.32],
      [-0.035, -0.46],
    ] as Array<[number, number]>) {
      const tail = this.box(leather, 0.05, 0.26, 0.025, ox, 1.69, 0.2);
      tail.rotation.x = tilt;
      tail.rotation.z = ox * 3;
      this.root.add(tail);
    }
    // Dark face void, recessed so it reads as shadow under the hood.
    this.root.add(this.box(dark, 0.135, 0.1, 0.04, 0, 1.8, -0.135));
    // Hood over the top of the head.
    const hoodMesh = new Mesh(this.geo(new SphereGeometry(0.185, 12, 10)), hood);
    hoodMesh.position.set(0, 1.85, 0.025);
    hoodMesh.scale.set(1, 1.0, 1.05);
    this.root.add(hoodMesh);

    // --- Pauldrons (tucked in so the cloak can cover them) ---
    this.root.add(this.box(leather, 0.16, 0.11, 0.22, 0.24, 1.55, 0));
    this.root.add(this.box(leather, 0.16, 0.11, 0.22, -0.24, 1.55, 0));

    // --- Arms (cloth-wrapped forearms, gloved hands — no skin) ---
    this.setupArm(this.armL, this.foreArmL, tunic, wrap, leather, 0.26);
    this.setupArm(this.armR, this.foreArmR, tunic, wrap, leather, -0.26);
    this.root.add(this.armL, this.armR);

    // --- Legs ---
    this.setupLeg(this.legL, this.shinL, tunic, leather, 0.11);
    this.setupLeg(this.legR, this.shinR, tunic, leather, -0.11);
    this.root.add(this.legL, this.legR);

    // --- Full enveloping cloak (simulated cloth) ---
    this.buildCloak(cloak);
    this.root.add(this.cloak);

    this.object.traverse((o) => {
      o.castShadow = true;
    });
  }

  /**
   * A long mantle that wraps the whole body: a curved sheet spanning ~250° of a
   * cone around the figure, open at the front. Vertices are simulated each frame
   * (see `simulateCloak`) so it trails and billows with movement.
   */
  private buildCloak(mat: MeshStandardMaterial): void {
    const geo = new PlaneGeometry(1, 1, CharacterModel.CLOAK_COLS - 1, CharacterModel.CLOAK_ROWS - 1);
    this.geo(geo);
    const rest = new Float32Array(CharacterModel.CLOAK_COLS * CharacterModel.CLOAK_ROWS * 3);
    // Nearly a full wrap (~330°): the mantle encircles the whole body with only
    // a narrow parting at the front, so the arms move *underneath* the cloth.
    const arc = Math.PI * 1.85;
    for (let r = 0; r < CharacterModel.CLOAK_ROWS; r++) {
      const v = r / (CharacterModel.CLOAK_ROWS - 1); // 0 shoulders → 1 hem
      for (let c = 0; c < CharacterModel.CLOAK_COLS; c++) {
        const u = c / (CharacterModel.CLOAK_COLS - 1); // 0..1 across the arc
        const ang = Math.PI + (u - 0.5) * arc; // centred on the back (+Z)
        // Ragged, scalloped hem instead of a clean circular skirt.
        const ragged = 1 + Math.sin(u * Math.PI * 7.5) * 0.05;
        const hemLift = v * v * Math.abs(Math.cos(u * Math.PI * 4.5)) * 0.1;
        const y = 1.78 - v * 1.2 + hemLift; // from above the shoulders to mid-calf
        // Wide over the shoulders, then a roomy bell so swinging arms have space
        // under the cloth instead of poking through it.
        const shoulderFlare = Math.pow(1 - v, 2.4) * 0.16;
        const radius = (0.34 + v * 0.22 + shoulderFlare) * ragged;
        const i = (r * CharacterModel.CLOAK_COLS + c) * 3;
        rest[i] = Math.sin(ang) * radius;
        rest[i + 1] = y;
        rest[i + 2] = Math.cos(ang) * radius * -1; // back = +Z
      }
    }
    this.cloakRest = rest;
    this.cloakCurrent = Float32Array.from(rest);
    this.cloakPrev = Float32Array.from(rest);
    geo.setAttribute('position', new BufferAttribute(this.cloakCurrent, 3));
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    this.cloakGeo = geo;
    this.cloak.add(mesh);
  }

  private mat(r: number, g: number, b: number): MeshStandardMaterial {
    const m = new MeshStandardMaterial({
      color: new Color(r, g, b),
      roughness: 0.85,
      metalness: 0,
      flatShading: true,
    });
    this.mats.push(m);
    return m;
  }

  private geo<T extends BufferGeometry>(g: T): T {
    this.geos.push(g);
    return g;
  }

  private box(m: MeshStandardMaterial, w: number, h: number, d: number, x: number, y: number, z: number): Mesh {
    const mesh = new Mesh(this.geo(new BoxGeometry(w, h, d)), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    return mesh;
  }

  private cyl(m: MeshStandardMaterial, rt: number, rb: number, h: number, x: number, y: number, z: number): Mesh {
    const mesh = new Mesh(this.geo(new CylinderGeometry(rt, rb, h, 8)), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    return mesh;
  }

  private capsule(m: MeshStandardMaterial, r: number, len: number, y: number): Mesh {
    const mesh = new Mesh(this.geo(new CapsuleGeometry(r, len, 3, 6)), m);
    mesh.position.set(0, y, 0);
    mesh.castShadow = true;
    return mesh;
  }

  private setupArm(
    shoulder: Group,
    fore: Group,
    tunic: MeshStandardMaterial,
    skin: MeshStandardMaterial,
    leather: MeshStandardMaterial,
    x: number,
  ): void {
    shoulder.position.set(x, 1.5, 0);
    shoulder.add(this.capsule(tunic, 0.07, 0.26, -0.16));
    fore.position.set(0, -0.32, 0);
    fore.add(this.capsule(skin, 0.058, 0.24, -0.14));
    fore.add(this.box(leather, 0.11, 0.12, 0.1, 0, -0.32, 0)); // hand/glove
    shoulder.add(fore);
  }

  private setupLeg(
    hip: Group,
    shin: Group,
    tunic: MeshStandardMaterial,
    leather: MeshStandardMaterial,
    x: number,
  ): void {
    hip.position.set(x, 0.9, 0);
    hip.add(this.capsule(tunic, 0.09, 0.32, -0.2));
    shin.position.set(0, -0.44, 0);
    shin.add(this.capsule(leather, 0.078, 0.3, -0.18));
    // Boot toe points along −Z (the model's forward), matching the face.
    shin.add(this.box(leather, 0.15, 0.13, 0.3, 0, -0.4, -0.07));
    hip.add(shin);
  }

  private static ease(node: Object3D, target: number, dt: number): void {
    node.rotation.x = MathUtils.lerp(node.rotation.x, target, Math.min(1, dt * 12));
  }

  /**
   * Recomputes where the elbows and hands currently are, in the character's
   * local space, from the arm joint angles. The cloth uses these as colliders,
   * which is what makes the arms visibly move *under* the mantle.
   */
  private updateLimbColliders(): void {
    const UPPER = 0.32;
    const FORE = 0.32;
    const shoulderY = 1.5;
    let n = 0;
    for (const [shoulder, fore, sx] of [
      [this.armL, this.foreArmL, 0.26],
      [this.armR, this.foreArmR, -0.26],
    ] as Array<[Group, Group, number]>) {
      const a = shoulder.rotation.x;
      // Elbow: rotate the upper-arm vector (0,−UPPER,0) about X by `a`.
      const ey = shoulderY - Math.cos(a) * UPPER;
      const ez = -Math.sin(a) * UPPER;
      const elbow = this.limbColliders[n++]!;
      elbow.x = sx;
      elbow.y = ey;
      elbow.z = ez;
      // Hand: continue from the elbow with the forearm's added flexion.
      const b = a + fore.rotation.x;
      const hand = this.limbColliders[n++]!;
      hand.x = sx;
      hand.y = ey - Math.cos(b) * FORE;
      hand.z = ez - Math.sin(b) * FORE;
    }
  }

  /**
   * Verlet-style cloth pass in the character's local space. The top row is
   * pinned to the shoulders; lower rows swing under gravity, inertia from
   * movement/turning, and a light breeze, then get pulled back toward their rest
   * shape (so the mantle keeps its silhouette) and pushed out of the body.
   */
  private simulateCloak(localWind: Vector3, turnRate: number, dt: number, time: number): void {
    const cols = CharacterModel.CLOAK_COLS;
    const rows = CharacterModel.CLOAK_ROWS;
    const cur = this.cloakCurrent;
    const prev = this.cloakPrev;
    const rest = this.cloakRest;
    const step = Math.min(dt, 1 / 30);

    for (let r = 1; r < rows; r++) {
      const v = r / (rows - 1);
      const stiffness = 0.22 - v * 0.14; // hem is looser than the shoulders
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 3;
        // Inertia.
        let vx = (cur[i]! - prev[i]!) * 0.86;
        let vy = (cur[i + 1]! - prev[i + 1]!) * 0.86;
        let vz = (cur[i + 2]! - prev[i + 2]!) * 0.86;
        prev[i] = cur[i]!;
        prev[i + 1] = cur[i + 1]!;
        prev[i + 2] = cur[i + 2]!;

        // Forces: gravity + movement drag + turn swing + breeze flutter.
        const flutter = Math.sin(time * 6 + r * 0.9 + c * 0.7) * 0.02 * v;
        vy -= 5.2 * step * step;
        vx += (localWind.x * 0.4 + turnRate * 0.5) * v * step;
        vz += localWind.z * 0.5 * v * step;
        vx += flutter * step * 10;

        let nx = cur[i]! + vx;
        let ny = cur[i + 1]! + vy;
        let nz = cur[i + 2]! + vz;

        // Pull back toward the rest silhouette.
        nx += (rest[i]! - nx) * stiffness;
        ny += (rest[i + 1]! - ny) * (stiffness + 0.25);
        nz += (rest[i + 2]! - nz) * stiffness;

        // Keep the cloth off the body without forcing a rigid cone: the torso is
        // wide at the top, the legs are narrow, so the limit tapers downward.
        const radial = Math.hypot(nx, nz);
        const minR = 0.24 - v * 0.08;
        if (radial < minR && radial > 1e-4) {
          const k = minR / radial;
          nx *= k;
          nz *= k;
        }

        // Push the cloth out around the elbows and hands, so a swinging arm
        // visibly bulges the mantle from underneath instead of clipping it.
        for (const lc of this.limbColliders) {
          const dx = nx - lc.x;
          const dy = ny - lc.y;
          const dz = nz - lc.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < lc.r * lc.r && d2 > 1e-6) {
            const d = Math.sqrt(d2);
            const push = (lc.r - d) / d;
            nx += dx * push;
            ny += dy * push * 0.35; // mostly sideways, keeps the drape
            nz += dz * push;
          }
        }

        // Never sink through the ground.
        if (ny < 0.1) ny = 0.1;

        cur[i] = nx;
        cur[i + 1] = ny;
        cur[i + 2] = nz;
      }
    }

    if (this.cloakGeo) {
      const attr = this.cloakGeo.attributes.position as BufferAttribute;
      attr.needsUpdate = true;
      this.cloakGeo.computeVertexNormals();
    }
  }

  update(pos: Vector3, yaw: number, s: LocomotionState, dt: number): void {
    // --- Cloth drivers: world velocity → local space, plus turn rate ---
    if (this.firstUpdate) {
      this.prevWorldPos.copy(pos);
      this.prevYaw = yaw;
      this.firstUpdate = false;
    }
    const safeDt = Math.max(dt, 1e-4);
    CharacterModel.scratchWind
      .set(pos.x - this.prevWorldPos.x, 0, pos.z - this.prevWorldPos.z)
      .multiplyScalar(-1 / safeDt); // drag opposes motion
    this.prevWorldPos.copy(pos);
    // Rotate world drag into the character's local frame.
    const cy = Math.cos(-yaw);
    const sy = Math.sin(-yaw);
    const wx = CharacterModel.scratchWind.x * cy - CharacterModel.scratchWind.z * sy;
    const wz = CharacterModel.scratchWind.x * sy + CharacterModel.scratchWind.z * cy;
    CharacterModel.scratchWind.set(wx, 0, wz);
    let dYaw = yaw - this.prevYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this.prevYaw = yaw;
    const turnRate = MathUtils.clamp(dYaw / safeDt, -6, 6);

    this.object.position.copy(pos);
    this.object.rotation.y = yaw;
    this.idleTime += dt;

    // Joint convention: limbs hang along −Y and the model faces −Z, so a
    // POSITIVE rotation.x swings a limb FORWARD and a negative one backward.
    if (!s.grounded) {
      // Airborne: lead leg drives forward, trailing leg tucks, arms come up in
      // front (never behind — that used to push them through the cloak).
      CharacterModel.ease(this.legL, 0.55, dt);
      CharacterModel.ease(this.legR, -0.2, dt);
      CharacterModel.ease(this.shinL, -0.35, dt);
      CharacterModel.ease(this.shinR, -0.95, dt);
      CharacterModel.ease(this.armL, 0.5, dt);
      CharacterModel.ease(this.armR, 0.72, dt);
      CharacterModel.ease(this.foreArmL, 0.85, dt);
      CharacterModel.ease(this.foreArmR, 1.0, dt);
      this.body.position.y = MathUtils.lerp(this.body.position.y, 0.02, Math.min(1, dt * 8));
    } else if (s.speed01 > 0.05) {
      const p = s.phase;
      const amp = 0.42 + s.speed01 * 0.62;

      // Thighs swing symmetrically; the knee only bends while the leg trails,
      // lifting the heel behind — how a real stride reads.
      const thighL = Math.sin(p) * amp;
      const thighR = Math.sin(p + Math.PI) * amp;
      this.legL.rotation.x = thighL;
      this.legR.rotation.x = thighR;
      this.shinL.rotation.x = -0.05 - Math.max(0, -thighL) * 1.25;
      this.shinR.rotation.x = -0.05 - Math.max(0, -thighR) * 1.25;

      // Arms counter-swing. The backswing is limited so the hands stay clear of
      // the cloak instead of passing through it.
      const swingL = Math.sin(p + Math.PI) * amp * 0.75;
      const swingR = Math.sin(p) * amp * 0.75;
      this.armL.rotation.x = swingL > 0 ? swingL : swingL * 0.5;
      this.armR.rotation.x = swingR > 0 ? swingR : swingR * 0.5;
      // Elbows flex forward, more on the forward swing.
      this.foreArmL.rotation.x = 0.28 + Math.max(0, swingL) * 0.7;
      this.foreArmR.rotation.x = 0.28 + Math.max(0, swingR) * 0.7;

      this.body.position.y = Math.abs(Math.sin(p)) * 0.05 * (0.6 + s.speed01);
    } else {
      const b = Math.sin(this.idleTime * 1.6);
      CharacterModel.ease(this.legL, 0, dt);
      CharacterModel.ease(this.legR, 0, dt);
      CharacterModel.ease(this.shinL, -0.05, dt);
      CharacterModel.ease(this.shinR, -0.05, dt);
      CharacterModel.ease(this.armL, 0.08 + b * 0.03, dt);
      CharacterModel.ease(this.armR, 0.08 - b * 0.03, dt);
      CharacterModel.ease(this.foreArmL, 0.24, dt);
      CharacterModel.ease(this.foreArmR, 0.24, dt);
      this.body.position.y = b * 0.012;
    }

    // Cloth runs last, once this frame's arm pose is known, so the mantle reacts
    // to the limbs moving underneath it rather than lagging a frame behind.
    //
    // It is stepped at a fixed rate rather than once per rendered frame: the pass
    // rebuilds vertex normals and re-uploads the buffer, so at a few hundred FPS
    // it would burn CPU for motion nobody can see — and the simulation would
    // behave differently depending on frame rate.
    this.clothAccumulator += dt;
    const step = CharacterModel.CLOTH_STEP;
    let steps = 0;
    while (this.clothAccumulator >= step && steps < 2) {
      this.updateLimbColliders();
      this.simulateCloak(CharacterModel.scratchWind, turnRate, step, this.idleTime);
      this.clothAccumulator -= step;
      steps++;
    }
    // If we fell far behind (tab was hidden), drop the backlog instead of
    // catching up with a burst of expensive steps.
    if (this.clothAccumulator > step * 4) this.clothAccumulator = 0;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
