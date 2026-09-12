import {
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
} from 'three';

/**
 * IconRenderer
 * ------------
 * Turns geometry into small PNG data URLs, once, on a throwaway renderer.
 *
 * Every icon in this game is a picture of the thing it represents, taken from the
 * same `BufferGeometry` the world draws — so a slot can never disagree with what it
 * places or holds. Drawings would drift the first time a shape changed.
 *
 * The render deliberately does not borrow the game's renderer. That one is mid-frame
 * with a post-processing composer bound to it, so its size, clear colour and render
 * target would all have to be saved and restored around a handful of one-off draws.
 * A private context is created for the batch and released the moment it finishes,
 * because browsers cap how many WebGL contexts a page may hold and the game's own
 * renderer must not be left competing with an abandoned one.
 *
 * Shared by the build hotbar and the inventory rather than written twice: they had
 * the same forty lines, and the second copy is where the two silently diverge.
 */

export interface IconOptions {
  /** Pixels, square. */
  size?: number;
  /** Flat colour to draw with. Maps are pointless at this size — see below. */
  colour?: number;
  /**
   * Half-width of the orthographic frame, in metres. One shared frame for a batch is
   * what makes the sizes comparable, so a wall reads as the tall one next to a floor.
   * Omit to fit each piece to its own bounds instead, which suits a set of objects
   * whose real sizes differ by an order of magnitude — a stick beside a log.
   */
  frame?: number;
}

/**
 * Renders each geometry once and returns their data URLs in the same order.
 *
 * Flat colour and no texture maps: the world's timber is 512 px of grain that turns
 * to noise in a 30 px square, and what has to read at that size is the silhouette.
 * Orthographic from a fixed three-quarter angle for the same reason — perspective
 * this close mostly just bends the outline.
 *
 * Returns an empty array if a context cannot be created, so callers fall back to
 * text rather than failing.
 */
export function renderIcons(geometries: readonly BufferGeometry[], opts: IconOptions = {}): string[] {
  const size = opts.size ?? 64;
  let renderer: WebGLRenderer | null = null;
  try {
    renderer = new WebGLRenderer({
      alpha: true,
      antialias: true,
      // Read back with `toDataURL` immediately after the draw; preserving the buffer
      // removes any question of the compositor having cleared it first.
      preserveDrawingBuffer: true,
      powerPreference: 'low-power',
    });
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);

    const scene = new Scene();
    scene.add(new HemisphereLight(0xdff0ff, 0x30281f, 1.35));
    const key = new DirectionalLight(0xfff2dc, 2.5);
    key.position.set(-0.6, 1.2, 0.9);
    scene.add(key);
    const rim = new DirectionalLight(0x9ec4ff, 0.9);
    rim.position.set(0.9, 0.2, -0.8);
    scene.add(rim);

    const material = new MeshStandardMaterial({
      color: opts.colour ?? 0xb07c46,
      roughness: 0.9,
      metalness: 0,
    });

    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    const mesh = new Mesh(undefined, material);
    scene.add(mesh);

    const centre = new Vector3();
    const span = new Vector3();
    const urls: string[] = [];
    for (const geo of geometries) {
      mesh.geometry = geo;
      if (!geo.boundingBox) geo.computeBoundingBox();
      geo.boundingBox?.getCenter(centre);
      geo.boundingBox?.getSize(span);
      // Centred on its own bounds. Pieces are modelled with their underside on the
      // ground and are not the same height, so a shared offset would push some of
      // them out of frame.
      mesh.position.set(-centre.x, -centre.y, -centre.z);

      // Fitted per item unless the caller wants one frame for the whole batch. The
      // longest diagonal, not the height: a plank lying flat is wide and thin, and
      // framing it by height alone would run it off both sides.
      const half = opts.frame ?? Math.max(span.x, span.y, span.z) * 0.62 + 0.02;
      camera.left = -half;
      camera.right = half;
      camera.top = half;
      camera.bottom = -half;
      const d = half * 4 + 4;
      camera.position.set(d, d * 0.85, d);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();

      renderer.render(scene, camera);
      urls.push(renderer.domElement.toDataURL('image/png'));
    }
    scene.remove(mesh);
    material.dispose();
    return urls;
  } catch (err) {
    console.warn(`[icons] no offscreen context: ${String((err as Error)?.message ?? err)}`);
    return [];
  } finally {
    if (renderer) {
      renderer.dispose();
      // `dispose` frees three's own resources but leaves the GL context for the
      // driver to reclaim whenever it feels like it. Contexts are a capped,
      // page-wide resource, so it is given up explicitly.
      renderer.forceContextLoss();
    }
  }
}
