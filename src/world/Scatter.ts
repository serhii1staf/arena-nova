import {
  type BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import {
  buildBush,
  buildFern,
  buildFlower,
  buildGrassTuft,
  buildLog,
  buildRock,
  buildTree,
  buildTreeFar,
  type TreeKind,
} from './Flora.ts';
import type { AssetManager } from '../core/AssetManager.ts';
import { applyTriplanarTexture } from './builders/geometry.ts';
import { loadGrassModels } from './GrassModels.ts';
import type { PropRegistry } from './PropRegistry.ts';
import {
  biomeStyle,
  cellRandom,
  surfaceBiomeAt,
  surfaceHeightAt,
  surfaceSlopeAt,
  WORLD,
} from './WorldGen.ts';
import type { Wind } from './Wind.ts';

/** Must match the terrain chunk size so vegetation and ground load together. */
const CHUNK = 256;
/**
 * Vegetation radii in chunks, much smaller than the terrain view distance.
 * Each extra ring costs (2r+1)² chunks of geometry, so these are the main
 * lever on both triangle count and draw calls.
 */
const GRASS_RADIUS = 1;
const DETAIL_RADIUS = 1;
const TREE_RADIUS = 2;
/** Upper bound on chunks populated per frame; the real limit is the time budget. */
const BUILD_BUDGET = 2;

/**
 * The authored grass clumps stream on their own, much finer grid.
 *
 * A clump is around seventy triangles against the procedural tuft's six, so it
 * can only be afforded close to the player — and the 256 m vegetation chunk is
 * far too coarse a unit to express "close to the player". Ring 0 of that grid is
 * the chunk you happen to be standing in, whose near edge can be a metre away, so
 * a layer confined to it would visibly stop underfoot.
 *
 * With a 96 m cell and one ring, the clumps always reach at least a full cell in
 * every direction and at most two — no edge is ever close enough to notice, and
 * the layer costs a ninth of what it would spread over the coarse grid.
 *
 * A finer grid than this is not free either: every cell is two more draw calls.
 * Nine cells is eighteen, which the draw budget has room for; a 32 m cell reaching
 * the same distance would be a hundred and sixty.
 */
const CLUMP_CELL = 96;
const CLUMP_RADIUS = 1;
/** Clump cells are a twentieth of the work of a chunk, so more fit in a frame. */
const CLUMP_BUDGET = 3;

type Layer = 'tree' | 'bush' | 'fern' | 'flower' | 'grass' | 'clump' | 'rock' | 'log';

interface Placement {
  x: number;
  y: number;
  z: number;
  scale: number;
  scaleY: number;
  rot: number;
  variant: number;
}

interface ScatterChunk {
  key: string;
  cx: number;
  cz: number;
  meshes: InstancedMesh[];
}

export interface ScatterStreamer {
  group: Group;
  update(position: Vector3): void;
  /**
   * Populate pending chunks until `deadline` (a `performance.now()` stamp).
   * `force` permits one build to start past the deadline; see `Terrain.pump`.
   */
  pump(deadline: number, force?: boolean): number;
  prime(position: Vector3, rings: number): void;
  dispose(): void;
}

/** Sampling grid spacing per layer, in metres. */
const SPACING: Record<Layer, number> = {
  tree: 23,
  bush: 13,
  fern: 12,
  flower: 12,
  /**
   * The thin tuft carpet that runs all the way out to the grass radius.
   *
   * Was 2.6 m, which put two thirds of the world's entire triangle budget into
   * single-blade tufts a couple of hundred metres away, each a pixel or two tall.
   * Widened to fund the authored clumps in the near field, where the same
   * triangles are actually visible. Divides 256 exactly.
   */
  grass: 4,
  /**
   * Authored clumps, near field only, and the number the whole frame budget turns
   * on: a clump is around seventy triangles, so this is the densest thing the
   * world draws and every tenth of a metre off it is worth tens of thousands of
   * triangles. Tuned against the measured budget, not chosen.
   */
  clump: 3.2,
  rock: 24,
  log: 52,
};

/** Which chunk radius each layer is drawn out to. */
const LAYER_RADIUS: Record<Layer, number> = {
  tree: TREE_RADIUS,
  bush: DETAIL_RADIUS,
  fern: DETAIL_RADIUS,
  flower: GRASS_RADIUS,
  grass: GRASS_RADIUS,
  // Streams on its own grid, so this is unused; kept so the record is total.
  clump: CLUMP_RADIUS,
  rock: TREE_RADIUS,
  log: DETAIL_RADIUS,
};

const FLOWER_COLOURS = [
  new Color(0.94, 0.86, 0.36),
  new Color(0.88, 0.44, 0.64),
  new Color(0.62, 0.56, 0.92),
  new Color(0.96, 0.96, 0.94),
];

const TREE_KINDS: TreeKind[] = ['jungle', 'palm', 'sakura', 'pine', 'acacia', 'dead'];

/**
 * Streams biome-appropriate vegetation around the player.
 *
 * Placement is a pure function of world coordinates (`cellRandom`), so a chunk
 * always regenerates identically — no state to save, and props line up perfectly
 * with the terrain because both read the same height field. That holds for the
 * clumps too: which grid a layer streams on is a residency question, and says
 * nothing about where anything ends up.
 *
 * Grass is two layers, not one. Authored clumps from the nature pack fill a fine
 * grid around the player and the cheap procedural tuft carries on behind them out
 * to the vegetation radius — see `CLUMP_CELL` for why the near field needs a grid
 * of its own.
 */
export function createScatter(
  assets: AssetManager,
  registry: PropRegistry,
  wind: Wind,
): ScatterStreamer {
  const group = new Group();
  group.name = 'Vegetation';

  // ---- Shared geometry pools (built once, instanced everywhere) ----
  // Two detail levels per species: full trees near the player, cheap stand-ins
  // for the outer ring where the extra triangles would be invisible.
  const treeGeos = new Map<TreeKind, BufferGeometry[]>();
  const treeGeosFar = new Map<TreeKind, BufferGeometry[]>();
  for (const kind of TREE_KINDS) {
    treeGeos.set(kind, [buildTree(kind, 11), buildTree(kind, 4242)]);
    treeGeosFar.set(kind, [buildTreeFar(kind, 11)]);
  }
  const bushGeos = [buildBush(3), buildBush(19)];
  const fernGeos = [buildFern(5), buildFern(29)];
  const flowerGeos = FLOWER_COLOURS.map((c, i) => buildFlower(7 + i * 13, c));
  const grassGeos = [buildGrassTuft(), buildGrassTuft(new Color(0.5, 0.6, 0.24))];
  const rockGeos = [buildRock(5, 1), buildRock(17, 1)];
  const logGeos = [buildLog(23)];

  // ---- Materials: one per wind stiffness group ----
  const makeMat = (stiffness: number, pivot: number): MeshStandardMaterial => {
    const m = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
      flatShading: true,
    });
    if (stiffness > 0) wind.applyWindSway(m, stiffness, pivot);
    return m;
  };
  const treeMat = makeMat(0.16, 2.5);
  const bushMat = makeMat(0.65, 0.1);
  const grassMat = makeMat(1.5, 0);

  // The clumps sway on the same wind at the same stiffness — it is the same
  // material, built by the same helper — but they are modelled as single-sided
  // blade cards leaning in every direction, so back faces have to be kept or half
  // of every clump vanishes depending on which way you walk round it. Smooth
  // rather than faceted for the same reason: the pack authored normals along each
  // blade, and flat shading would throw them away and chevron every strip.
  const clumpMat = makeMat(1.5, 0);
  clumpMat.side = DoubleSide;
  clumpMat.flatShading = false;

  // Boulders and logs get a stone texture, blended triplanar in the shader.
  //
  // Baking a projection into the UV attribute does not work on a faceted lump:
  // whichever axis each facet picks, the UVs jump at every facet edge, the GPU's
  // derivative-based mip selection blows up along that seam and samples a far
  // coarser mip — which draws a thin dark line around every facet. Blending the
  // three projections per fragment has no seam anywhere by construction.
  const rockMat = makeMat(0, 0);
  applyTriplanarTexture(rockMat, assets.stone(1).map, 0.7);

  // The clumps are not in here: they are not one of the layers the chunk builder
  // walks, they stream on their own grid.
  const layerAssets: Record<
    Exclude<Layer, 'clump'>,
    { geos: BufferGeometry[]; material: MeshStandardMaterial }
  > = {
    tree: { geos: [], material: treeMat }, // chosen per biome
    bush: { geos: bushGeos, material: bushMat },
    fern: { geos: fernGeos, material: bushMat },
    flower: { geos: flowerGeos, material: bushMat },
    grass: { geos: grassGeos, material: grassMat },
    rock: { geos: rockGeos, material: rockMat },
    log: { geos: logGeos, material: rockMat },
  };

  const loaded = new Map<string, ScatterChunk>();
  const pending = new Map<string, { cx: number; cz: number; dist: number }>();
  /** The near-field clump grid, streamed exactly like `loaded` but far finer. */
  const clumpLoaded = new Map<string, ScatterChunk>();
  const clumpPending = new Map<string, { cx: number; cz: number; dist: number }>();

  /**
   * The authored clumps. They arrive asynchronously, so the near field is built
   * from the procedural tufts until they land and rebuilt once they do — building
   * the world is not allowed to wait on a download, and if the pack is missing
   * altogether the tufts simply stay.
   *
   * `clumpGeos` is the only thing that changes: the grid, the placement and the
   * material are the same either way.
   */
  let clumpGeos: BufferGeometry[] = grassGeos;
  let torndown = false;
  void loadGrassModels().then((set) => {
    if (torndown || !set) return;
    const geos = (['Grass_Small', 'Grass_Large'] as const)
      .map((n) => set.geometry(n))
      .filter((g): g is BufferGeometry => g !== null);
    if (geos.length === 0) return;
    clumpGeos = geos;
    // Throw away the cells standing on the stand-in geometry. `update` puts them
    // straight back on the queue and `pump` rebuilds them over the next couple of
    // frames, which is a flicker at worst and only ever happens once.
    for (const cell of [...clumpLoaded.values()]) dropChunk(cell, clumpLoaded);
  });

  /**
   * Which of `clumpGeos` a placement gets.
   *
   * Weighted rather than split evenly: the large clump is nearly twice the
   * triangles of the small one, and a field of mostly small clumps with the
   * occasional large one both costs less and looks more like grass than an even
   * mix of two sizes. `variant` is 0..3, so this is one large in four.
   */
  const clumpPick = (p: Placement): number => (p.variant === 0 ? 1 : 0);
  // Namespaced, because this string is also the `PropRegistry` owner key and that
  // map is flat. Landmarks stream on a 420 m grid while these are 256 m chunks, so
  // the bare `cx|cz` form collided between the two layers and unloading one
  // deleted the other's colliders.
  const key = (cx: number, cz: number): string => `scatter:${cx}|${cz}`;
  /** Its own namespace: a different grid, so cell (0,0) is not chunk (0,0). */
  const clumpKey = (cx: number, cz: number): string => `clump:${cx}|${cz}`;

  /**
   * Collects placements for one layer inside a chunk by walking a jittered grid
   * and testing the biome at each candidate.
   */
  const gather = (
    layer: Layer,
    cx: number,
    cz: number,
    cell: number,
    perBiomeTree: Map<TreeKind, Placement[]> | null,
  ): Placement[] => {
    const out: Placement[] = [];
    const spacing = SPACING[layer];
    const originX = cx * cell;
    const originZ = cz * cell;
    const salt = layer.charCodeAt(0) + layer.length * 31;

    // The sampling lattice is global and each cell owns the slice of it that falls
    // inside its bounds, so cells tile it exactly whatever the spacing is.
    //
    // Taking a fixed `floor(cell / spacing)` steps from `floor(origin / spacing)`
    // instead — which is what this did — comes up one column short whenever the
    // spacing does not divide the cell size, leaving a strip of bare ground one
    // spacing wide at that boundary. It was invisible at 2.6 m over a 256 m chunk;
    // it would not be, on the near-field grid.
    const gx0 = Math.ceil(originX / spacing);
    const gz0 = Math.ceil(originZ / spacing);
    const stepsX = Math.ceil((originX + cell) / spacing) - gx0;
    const stepsZ = Math.ceil((originZ + cell) / spacing) - gz0;

    for (let iz = 0; iz < stepsZ; iz++) {
      for (let ix = 0; ix < stepsX; ix++) {
        const gx = gx0 + ix;
        const gz = gz0 + iz;
        const r1 = cellRandom(gx, gz, salt);
        const r2 = cellRandom(gx + 7777, gz - 313, salt + 3);
        const r3 = cellRandom(gx - 91, gz + 4242, salt + 9);

        const x = gx * spacing + (r1 - 0.5) * spacing * 0.85;
        const z = gz * spacing + (r2 - 0.5) * spacing * 0.85;
        if (Math.abs(x) > WORLD.halfSize || Math.abs(z) > WORLD.halfSize) continue;

        // Height of the ground *as drawn*, so nothing hovers or sinks.
        const h = surfaceHeightAt(x, z);
        if (h < WORLD.waterLevel + 0.35) continue;

        const style = biomeStyle(surfaceBiomeAt(x, z));
        let density = 0;
        switch (layer) {
          case 'tree':
            density = style.trees;
            break;
          case 'bush':
            density = style.bushes;
            break;
          case 'fern':
            density = style.bushes * 0.8;
            break;
          case 'flower':
            density = style.flowers;
            break;
          case 'grass':
          case 'clump':
            density = style.grass;
            break;
          case 'rock':
            density = style.rocks;
            break;
          case 'log':
            density = style.trees * 0.35;
            break;
        }
        if (density <= 0) continue;

        // Low-frequency patchiness: forests clump into groves with clearings
        // between them instead of covering everything at a uniform rate. Looks
        // far more natural and roughly halves the instance count.
        if (layer === 'tree' || layer === 'bush' || layer === 'fern') {
          const px = Math.floor(x / 90);
          const pz = Math.floor(z / 90);
          const patch =
            cellRandom(px, pz, 4001) * 0.6 +
            cellRandom(Math.floor(x / 240), Math.floor(z / 240), 4002) * 0.4;
          density *= 0.35 + patch * 1.15;
        }

        // A single random test turns the density into a probability.
        if (r3 > Math.min(1, density * 0.62)) continue;

        // Nothing grows on cliffs.
        const slope = surfaceSlopeAt(x, z);
        const slopeLimit =
          layer === 'grass' || layer === 'clump' || layer === 'rock' ? 1.3 : 0.85;
        if (slope > slopeLimit) continue;

        // Keep the spawn plaza clear enough to walk and see the portal.
        if (Math.hypot(x, z) < WORLD.plazaRadius * 0.8) continue;

        const r4 = cellRandom(gx * 3 + 1, gz * 5 - 2, salt + 21);
        const scale = 0.8 + r4 * 0.5;
        const placement: Placement = {
          x,
          y: h,
          z,
          scale,
          scaleY: scale * (0.86 + r1 * 0.35),
          rot: r2 * Math.PI * 2,
          variant: Math.floor(r4 * 1000) % 4,
        };

        if (layer === 'tree' && perBiomeTree) {
          if (style.treeKind === 'none') continue;
          let list = perBiomeTree.get(style.treeKind);
          if (!list) perBiomeTree.set(style.treeKind, (list = []));
          list.push(placement);
        } else {
          out.push(placement);
        }
      }
    }
    return out;
  };

  const matrix = new Matrix4();
  const quat = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const pos = new Vector3();
  const scl = new Vector3();

  const addInstances = (
    chunk: ScatterChunk,
    label: string,
    geos: BufferGeometry[],
    material: MeshStandardMaterial,
    placements: Placement[],
    shadows: boolean,
    collider: ((p: Placement) => void) | null,
    /** Which geometry a placement gets. Defaults to an even split by variant. */
    pick: (p: Placement) => number = (p) => p.variant,
  ): void => {
    if (placements.length === 0 || geos.length === 0) return;
    // Split by geometry variant so each InstancedMesh has a single geometry.
    const buckets: Placement[][] = geos.map(() => []);
    for (const p of placements) buckets[pick(p) % geos.length]!.push(p);

    buckets.forEach((bucket, gi) => {
      if (bucket.length === 0) return;
      const mesh = new InstancedMesh(geos[gi]!, material, bucket.length);
      // Named so diagnostics can pick a layer out of the scene graph.
      mesh.name = label;
      // Whether this geometry came out of an asset pack rather than a builder.
      // Read by the grass probe, and by `dropChunk` deciding what it may dispose.
      mesh.userData.authored = geos[gi]!.userData.shared === true;
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      bucket.forEach((p, i) => {
        quat.setFromAxisAngle(up, p.rot);
        pos.set(p.x, p.y, p.z);
        scl.set(p.scale, p.scaleY, p.scale);
        matrix.compose(pos, quat, scl);
        mesh.setMatrixAt(i, matrix);
        collider?.(p);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      chunk.meshes.push(mesh);
    });
  };

  const buildChunk = (cx: number, cz: number, ring: number): void => {
    const k = key(cx, cz);
    if (loaded.has(k)) return;
    const chunk: ScatterChunk = { key: k, cx, cz, meshes: [] };

    // Trees are grouped by species because each biome uses a different palette.
    if (ring <= LAYER_RADIUS.tree) {
      const perKind = new Map<TreeKind, Placement[]>();
      gather('tree', cx, cz, CHUNK, perKind);
      const useFarLod = ring >= 2;
      for (const [kind, list] of perKind) {
        const geos = useFarLod ? treeGeosFar.get(kind) : treeGeos.get(kind);
        if (!geos) continue;
        addInstances(chunk, `tree:${kind}`, geos, treeMat, list, ring <= 1, (p) => {
          // Trunks block movement; radius scales with the tree. `top` stays at
          // ground level (you can't stand on a trunk) while `blockTop` reaches
          // well above head height so the trunk is solid all the way up.
          registry.add(k, {
            x: p.x,
            z: p.z,
            r: 0.55 * p.scale,
            top: p.y,
            blockTop: p.y + 8 * p.scaleY,
            solid: true,
          });
        });
      }
    }

    const simpleLayers: Exclude<Layer, 'clump' | 'tree'>[] = [
      'rock',
      'log',
      'bush',
      'fern',
      'flower',
      'grass',
    ];
    for (const layer of simpleLayers) {
      if (ring > LAYER_RADIUS[layer]) continue;
      const placements = gather(layer, cx, cz, CHUNK, null);
      const assets = layerAssets[layer];
      const shadows = layer === 'rock' || layer === 'log' ? ring <= 1 : false;
      const collider =
        layer === 'rock'
          ? (p: Placement) => {
              const size = p.scale * 1.5;
              const top = p.y + size * 0.62;
              // Boulders are climbable: `blockTop` equals `top`, so once you're
              // up there you stop being pushed and start standing on it.
              registry.add(k, {
                x: p.x,
                z: p.z,
                r: size * 0.72,
                top,
                blockTop: top,
                solid: size > 1.7,
              });
            }
          : layer === 'log'
            ? (p: Placement) => {
                const top = p.y + 0.9 * p.scale;
                registry.add(k, {
                  x: p.x,
                  z: p.z,
                  r: 0.6 * p.scale,
                  top,
                  blockTop: top,
                  solid: false,
                });
              }
            : null;
      // Rocks read better with more bulk than the generic 0.8–1.3 scale range.
      if (layer === 'rock') {
        for (const p of placements) {
          p.scale *= 1.5;
          p.scaleY *= 1.2;
        }
      }
      addInstances(chunk, layer, assets.geos, assets.material, placements, shadows, collider);
    }

    loaded.set(k, chunk);
  };

  /**
   * Populates one cell of the near-field clump grid.
   *
   * Deliberately not folded into `buildChunk`: this is a different grid with a
   * different cell size and a different residency rule, and the only thing the two
   * share is `gather`, which now takes the cell size as an argument.
   */
  const buildClumpCell = (cx: number, cz: number): void => {
    const k = clumpKey(cx, cz);
    if (clumpLoaded.has(k)) return;
    const cell: ScatterChunk = { key: k, cx, cz, meshes: [] };
    const placements = gather('clump', cx, cz, CLUMP_CELL, null);
    // No shadows and no colliders: grass is walked through, and casting from
    // thousands of clumps would cost more than the whole rest of the layer.
    addInstances(cell, 'grass:clump', clumpGeos, clumpMat, placements, false, null, clumpPick);
    clumpLoaded.set(k, cell);
  };

  /**
   * Unloads a chunk or a clump cell. `from` is the map it lives in.
   *
   * `InstancedMesh.dispose` releases the instance buffers, never the geometry, so
   * this is safe for the authored clumps as well: their geometry is shared by
   * every cell in the world and is owned by `GrassModels`.
   */
  const dropChunk = (chunk: ScatterChunk, from: Map<string, ScatterChunk>): void => {
    for (const mesh of chunk.meshes) {
      group.remove(mesh);
      mesh.dispose();
    }
    registry.removeOwner(chunk.key);
    from.delete(chunk.key);
  };

  const update = (position: Vector3): void => {
    // Same `floor` rule as the terrain, so a vegetation chunk's ring matches the
    // terrain ring underneath it and near chunks really do get near detail.
    const pcx = Math.floor(position.x / CHUNK);
    const pcz = Math.floor(position.z / CHUNK);

    for (let dz = -TREE_RADIUS; dz <= TREE_RADIUS; dz++) {
      for (let dx = -TREE_RADIUS; dx <= TREE_RADIUS; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const k = key(cx, cz);
        if (loaded.has(k) || pending.has(k)) continue;
        pending.set(k, { cx, cz, dist: dx * dx + dz * dz });
      }
    }

    for (const chunk of [...loaded.values()]) {
      const ring = Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz));
      if (ring > TREE_RADIUS + 1) dropChunk(chunk, loaded);
    }
    for (const [k, want] of [...pending]) {
      const ring = Math.max(Math.abs(want.cx - pcx), Math.abs(want.cz - pcz));
      if (ring > TREE_RADIUS + 1) pending.delete(k);
    }
    lastCentre.set(pcx, 0, pcz);

    // Same three steps again on the clump grid. Kept whole rather than shared with
    // the loop above because every number in it is different: the cell size, the
    // radius, and how far out of range a cell has to be before it is thrown away —
    // one extra ring here is 96 m rather than 256 m.
    const gcx = Math.floor(position.x / CLUMP_CELL);
    const gcz = Math.floor(position.z / CLUMP_CELL);
    for (let dz = -CLUMP_RADIUS; dz <= CLUMP_RADIUS; dz++) {
      for (let dx = -CLUMP_RADIUS; dx <= CLUMP_RADIUS; dx++) {
        const cx = gcx + dx;
        const cz = gcz + dz;
        const k = clumpKey(cx, cz);
        if (clumpLoaded.has(k) || clumpPending.has(k)) continue;
        clumpPending.set(k, { cx, cz, dist: dx * dx + dz * dz });
      }
    }
    for (const cell of [...clumpLoaded.values()]) {
      const ring = Math.max(Math.abs(cell.cx - gcx), Math.abs(cell.cz - gcz));
      if (ring > CLUMP_RADIUS + 1) dropChunk(cell, clumpLoaded);
    }
    for (const [k, want] of [...clumpPending]) {
      const ring = Math.max(Math.abs(want.cx - gcx), Math.abs(want.cz - gcz));
      if (ring > CLUMP_RADIUS + 1) clumpPending.delete(k);
    }
  };

  const lastCentre = new Vector3();

  const pump = (deadline: number, force = true): number => {
    // Clumps first. They are the layer immediately around the player, and a cell
    // is a twentieth of the work of a chunk — making the near field wait behind
    // two 256 m chunks is what would actually be visible.
    //
    // The two loops share one `force`, and the clumps spend it: they are the near
    // field, and a cell is cheap. Granting it to both would let this one streamer
    // overrun the shared budget twice on the same frame, which is the bug being
    // fixed rather than a smaller version of it.
    let forceLeft = force;
    if (clumpPending.size > 0) {
      const queue = [...clumpPending.entries()].sort((a, b) => a[1].dist - b[1].dist);
      for (let i = 0; i < CLUMP_BUDGET && i < queue.length; i++) {
        if ((i > 0 || !forceLeft) && performance.now() >= deadline) break;
        const [k, want] = queue[i]!;
        clumpPending.delete(k);
        buildClumpCell(want.cx, want.cz);
        forceLeft = false;
      }
    }
    if (pending.size === 0) return clumpPending.size;
    const queue = [...pending.entries()].sort((a, b) => a[1].dist - b[1].dist);
    for (let i = 0; i < BUILD_BUDGET && i < queue.length; i++) {
      if ((i > 0 || !forceLeft) && performance.now() >= deadline) break;
      const [k, want] = queue[i]!;
      pending.delete(k);
      const ring = Math.max(Math.abs(want.cx - lastCentre.x), Math.abs(want.cz - lastCentre.z));
      buildChunk(want.cx, want.cz, ring);
      forceLeft = false;
    }
    return pending.size + clumpPending.size;
  };

  const prime = (position: Vector3, rings: number): void => {
    const pcx = Math.floor(position.x / CHUNK);
    const pcz = Math.floor(position.z / CHUNK);
    lastCentre.set(pcx, 0, pcz);
    for (let dz = -rings; dz <= rings; dz++) {
      for (let dx = -rings; dx <= rings; dx++) {
        buildChunk(pcx + dx, pcz + dz, Math.max(Math.abs(dx), Math.abs(dz)));
        pending.delete(key(pcx + dx, pcz + dz));
      }
    }
    // The clump grid is primed at its own radius, not the caller's: `rings` is
    // counted in 256 m chunks and would reach kilometres out here.
    const gcx = Math.floor(position.x / CLUMP_CELL);
    const gcz = Math.floor(position.z / CLUMP_CELL);
    for (let dz = -CLUMP_RADIUS; dz <= CLUMP_RADIUS; dz++) {
      for (let dx = -CLUMP_RADIUS; dx <= CLUMP_RADIUS; dx++) {
        buildClumpCell(gcx + dx, gcz + dz);
        clumpPending.delete(clumpKey(gcx + dx, gcz + dz));
      }
    }
  };

  const dispose = (): void => {
    torndown = true;
    for (const chunk of [...loaded.values()]) dropChunk(chunk, loaded);
    for (const cell of [...clumpLoaded.values()]) dropChunk(cell, clumpLoaded);
    pending.clear();
    clumpPending.clear();
    for (const geos of treeGeos.values()) for (const g of geos) g.dispose();
    for (const geos of treeGeosFar.values()) for (const g of geos) g.dispose();
    for (const g of [...bushGeos, ...fernGeos, ...flowerGeos, ...grassGeos, ...rockGeos, ...logGeos]) {
      g.dispose();
    }
    // The clump geometry is not in that list on purpose. It belongs to
    // `GrassModels`, is shared by every scene that ever loads, and is cached for
    // the lifetime of the page — disposing it here would leave the next world with
    // empty buffers and no error to explain them.
    treeMat.dispose();
    bushMat.dispose();
    grassMat.dispose();
    clumpMat.dispose();
    rockMat.dispose();
  };

  return { group, update, pump, prime, dispose };
}
