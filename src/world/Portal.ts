import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  ShaderMaterial,
  TorusGeometry,
  Vector3,
} from 'three';

interface Disposable {
  dispose(): void;
}

export interface PortalBuild {
  group: Group;
  /** Advance the swirl animation. */
  update(elapsed: number): void;
  /** True when a point is inside the activation volume. */
  contains(x: number, y: number, z: number): boolean;
  dispose(): void;
}

const PORTAL_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * A swirling energy vortex: polar-warped fractal noise spiralling into a bright
 * core, with a soft rim. Written as a shader so it animates for free on the GPU.
 */
const PORTAL_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  // Three octaves is plenty for a swirling vortex and keeps the fill cost low
  // (this shader can cover a lot of screen when you walk up to the portal).
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise(p);
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 c = vUv * 2.0 - 1.0;
    // Elliptical mask: the portal is taller than wide.
    float r = length(vec2(c.x, c.y * 0.92));
    if (r > 1.0) discard;

    float ang = atan(c.y, c.x);
    // Spiral coordinates: angle shifts with radius and time → vortex.
    vec2 sp = vec2(ang / 3.14159 * 2.0 + r * 2.4 - uTime * 0.35, r * 3.0 - uTime * 0.6);
    float n = fbm(sp * 2.2);

    // Bright core, filaments in the mid-field, soft feathered rim.
    float core = smoothstep(0.55, 0.0, r);
    float rim = smoothstep(1.0, 0.72, r);
    float filaments = smoothstep(0.35, 0.95, n) * rim;

    vec3 col = mix(uColorA, uColorB, clamp(n * 1.3, 0.0, 1.0));
    col += vec3(0.9, 1.0, 0.85) * core * 1.5;
    float alpha = clamp(core * 0.95 + filaments * 0.85, 0.0, 1.0) * rim;
    gl_FragColor = vec4(col, alpha);
  }
`;

/**
 * Builds a portal: a stone arch, a glowing vortex surface and a light that
 * spills onto the surroundings. `facing` is the yaw the portal plane faces.
 */
export function buildPortal(opts: {
  position: Vector3;
  width: number;
  height: number;
  facing: number;
  colorA?: Color;
  colorB?: Color;
  withArch?: boolean;
  /** Adds an opaque slab right behind the vortex so nothing shows through. */
  withBacking?: boolean;
}): PortalBuild {
  const group = new Group();
  group.name = 'Portal';
  const disposables: Disposable[] = [];
  const track = <T extends Disposable>(d: T): T => (disposables.push(d), d);

  const { position, width, height, facing } = opts;
  const colorA = opts.colorA ?? new Color(0.15, 0.75, 0.55);
  const colorB = opts.colorB ?? new Color(0.55, 1.0, 0.7);

  const uniforms = {
    uTime: { value: 0 },
    uColorA: { value: colorA },
    uColorB: { value: colorB },
  };

  const surfaceGeo = track(new PlaneGeometry(width, height));
  const surfaceMat = track(
    new ShaderMaterial({
      uniforms,
      vertexShader: PORTAL_VERT,
      fragmentShader: PORTAL_FRAG,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      toneMapped: false,
    }),
  );
  const surface = new Mesh(surfaceGeo, surfaceMat);
  surface.position.copy(position);
  surface.rotation.y = facing;
  group.add(surface);

  // Opaque backing: without it you look "through" the portal into empty space.
  if (opts.withBacking) {
    const backGeo = track(new PlaneGeometry(width * 1.6, height * 1.25));
    const backMat = track(
      new MeshStandardMaterial({
        color: new Color(0.04, 0.05, 0.05),
        roughness: 1,
        metalness: 0,
        side: DoubleSide,
      }),
    );
    const back = new Mesh(backGeo, backMat);
    // Just behind the vortex, along the portal's facing normal.
    back.position.set(
      position.x + Math.sin(facing) * 0.35,
      position.y,
      position.z + Math.cos(facing) * 0.35,
    );
    back.rotation.y = facing;
    group.add(back);
  }

  // Stone arch framing the vortex.
  if (opts.withArch !== false) {
    const archMat = track(
      new MeshStandardMaterial({
        color: new Color(0.32, 0.36, 0.32),
        roughness: 0.95,
        metalness: 0,
        flatShading: true,
      }),
    );
    const ring = track(new TorusGeometry(Math.max(width, height) * 0.52, 0.22, 6, 26));
    const arch = new Mesh(ring, archMat);
    arch.position.copy(position);
    arch.rotation.y = facing;
    arch.scale.set(width / Math.max(width, height), height / Math.max(width, height), 1);
    arch.castShadow = true;
    group.add(arch);
  }

  // Glow spill.
  const light = new PointLight(colorB, 26, 18, 2);
  light.position.set(position.x, position.y, position.z);
  group.add(light);

  const halfW = width * 0.5;
  const halfH = height * 0.5;
  const contains = (x: number, y: number, z: number): boolean => {
    // Distance along the portal's normal and across its face.
    const dx = x - position.x;
    const dz = z - position.z;
    const nx = Math.sin(facing);
    const nz = Math.cos(facing);
    const along = Math.abs(dx * nx + dz * nz); // through the plane
    const across = Math.abs(dx * nz - dz * nx); // sideways on the plane
    return along < 1.3 && across < halfW && Math.abs(y - position.y) < halfH + 0.6;
  };

  const update = (elapsed: number): void => {
    uniforms.uTime.value = elapsed;
    light.intensity = 22 + Math.sin(elapsed * 2.3) * 6;
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

  return { group, update, contains, dispose };
}
