import {
  CanvasTexture,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three';

interface Disposable {
  dispose(): void;
}

interface StoneTextureSet {
  map: Texture;
  normalMap: Texture;
  roughnessMap: Texture;
}

/**
 * AssetManager
 * ------------
 * All art in the lobby is generated procedurally at runtime — zero binary
 * downloads, tiny bundle, and every texture is tileable. It also owns lifetime:
 * anything registered via `track()` is disposed together, so switching scenes
 * never leaks GPU memory.
 *
 * (GLTF/Draco loaders can be layered on later for authored assets; the
 * disposal registry already supports them.)
 */
export class AssetManager {
  private readonly cache = new Map<string, unknown>();
  private readonly disposables = new Set<Disposable>();
  private readonly maxAnisotropy: number;

  constructor(maxAnisotropy = 8) {
    this.maxAnisotropy = maxAnisotropy;
  }

  /** Register a GPU resource for group disposal; returns it for chaining. */
  track<T extends Disposable>(obj: T): T {
    this.disposables.add(obj);
    return obj;
  }

  private cached<T>(key: string, make: () => T): T {
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit as T;
    const made = make();
    this.cache.set(key, made);
    return made;
  }

  // ---------------------------------------------------------------------------
  // Procedural noise
  // ---------------------------------------------------------------------------

  /** Tileable fractal value-noise sampled into a Float array (0..1). */
  private fbm(size: number, baseFreq: number, octaves: number, seed: number): Float32Array {
    const out = new Float32Array(size * size);

    // Single integer-lattice hash; wrapping onto `period` keeps it seamless.
    const latticeValue = (xi: number, yi: number, period: number): number => {
      const x = ((xi % period) + period) % period;
      const y = ((yi % period) + period) % period;
      let h = (x * 374761393 + y * 668265263 + seed * 1442695040) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h = h ^ (h >>> 16);
      return (h >>> 0) / 4294967295;
    };

    const smooth = (t: number): number => t * t * (3 - 2 * t);

    const sample = (fx: number, fy: number, freq: number): number => {
      const gx = fx * freq;
      const gy = fy * freq;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = smooth(gx - x0);
      const ty = smooth(gy - y0);
      const v00 = latticeValue(x0, y0, freq);
      const v10 = latticeValue(x0 + 1, y0, freq);
      const v01 = latticeValue(x0, y0 + 1, freq);
      const v11 = latticeValue(x0 + 1, y0 + 1, freq);
      const a = v00 + (v10 - v00) * tx;
      const b = v01 + (v11 - v01) * tx;
      return a + (b - a) * ty;
    };

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = x / size;
        const fy = y / size;
        let amp = 0.5;
        let freq = baseFreq;
        let sum = 0;
        let norm = 0;
        for (let o = 0; o < octaves; o++) {
          sum += sample(fx, fy, freq) * amp;
          norm += amp;
          amp *= 0.5;
          freq *= 2;
        }
        out[y * size + x] = sum / norm;
      }
    }
    return out;
  }

  private makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    return { canvas, ctx };
  }

  private finalizeTexture(canvas: HTMLCanvasElement, srgb: boolean, repeat: number): CanvasTexture {
    const tex = new CanvasTexture(canvas);
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    tex.anisotropy = this.maxAnisotropy;
    if (srgb) tex.colorSpace = SRGBColorSpace;
    tex.needsUpdate = true;
    return this.track(tex);
  }

  /** Build a normal map from a height field via a Sobel operator. */
  private heightToNormal(height: Float32Array, size: number, strength: number): HTMLCanvasElement {
    const { canvas, ctx } = this.makeCanvas(size);
    const img = ctx.createImageData(size, size);
    const at = (x: number, y: number): number => {
      const xx = (x + size) % size;
      const yy = (y + size) % size;
      return height[yy * size + xx]!;
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx =
          at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
          (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
        const dy =
          at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
          (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
        const nx = dx * strength;
        const ny = dy * strength;
        const nz = 1;
        const len = Math.hypot(nx, ny, nz) || 1;
        const i = (y * size + x) * 4;
        img.data[i] = (nx / len) * 127.5 + 127.5;
        img.data[i + 1] = (ny / len) * 127.5 + 127.5;
        img.data[i + 2] = (nz / len) * 127.5 + 127.5;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // ---------------------------------------------------------------------------
  // Material texture sets
  // ---------------------------------------------------------------------------

  /** Weathered, mossy stone for walls, columns and floor. */
  stone(repeat = 4): StoneTextureSet {
    return this.cached(`stone:${repeat}`, () => {
      const size = 512;
      const base = this.fbm(size, 8, 5, 11);
      const detail = this.fbm(size, 32, 4, 47);
      const cracks = this.fbm(size, 6, 3, 91);
      const mossMask = this.fbm(size, 5, 4, 173);

      const { canvas, ctx } = this.makeCanvas(size);
      const img = ctx.createImageData(size, size);
      const height = new Float32Array(size * size);

      for (let i = 0; i < size * size; i++) {
        const b = base[i]!;
        const d = detail[i]!;
        const c = cracks[i]!;
        const m = mossMask[i]!;
        // Height field for the normal map.
        const crackLine = Math.pow(1 - Math.abs(c - 0.5) * 2, 6); // thin dark veins
        height[i] = b * 0.7 + d * 0.3 - crackLine * 0.5;

        // Base grey stone tint with warm variation.
        let r = 120 + b * 70 + d * 20 - crackLine * 90;
        let g = 118 + b * 66 + d * 18 - crackLine * 90;
        let bl = 108 + b * 58 + d * 16 - crackLine * 95;

        // Moss overgrowth blended in for the "abandoned sanctuary" look.
        const moss = Math.max(0, m - 0.45) * 1.9;
        r = r * (1 - moss) + (58 + d * 40) * moss;
        g = g * (1 - moss) + (96 + d * 70) * moss;
        bl = bl * (1 - moss) + (44 + d * 30) * moss;

        const j = i * 4;
        img.data[j] = Math.max(0, Math.min(255, r));
        img.data[j + 1] = Math.max(0, Math.min(255, g));
        img.data[j + 2] = Math.max(0, Math.min(255, bl));
        img.data[j + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const map = this.finalizeTexture(canvas, true, repeat);

      // Roughness: mossy areas are a touch smoother/wetter.
      const { canvas: rc, ctx: rctx } = this.makeCanvas(size);
      const rimg = rctx.createImageData(size, size);
      for (let i = 0; i < size * size; i++) {
        const m = Math.max(0, mossMask[i]! - 0.45) * 1.9;
        const rough = 235 - m * 70 - detail[i]! * 25;
        const j = i * 4;
        rimg.data[j] = rimg.data[j + 1] = rimg.data[j + 2] = Math.max(60, Math.min(255, rough));
        rimg.data[j + 3] = 255;
      }
      rctx.putImageData(rimg, 0, 0);
      const roughnessMap = this.finalizeTexture(rc, false, repeat);

      const normalMap = this.finalizeTexture(this.heightToNormal(height, size, 2.2), false, repeat);

      return { map, normalMap, roughnessMap };
    });
  }

  /**
   * Jungle ground: mottled grass/earth with fine detail, plus a matching normal
   * and roughness map. Used for the exterior terrain (world-space UVs), so it
   * reads as real ground rather than a flat colour.
   */
  ground(): StoneTextureSet {
    return this.cached('ground', () => {
      const size = 512;
      const macro = this.fbm(size, 4, 4, 21);
      const grass = this.fbm(size, 26, 4, 63);
      const patch = this.fbm(size, 9, 3, 131);
      const grain = this.fbm(size, 64, 2, 205);

      const { canvas, ctx } = this.makeCanvas(size);
      const img = ctx.createImageData(size, size);
      const height = new Float32Array(size * size);

      for (let i = 0; i < size * size; i++) {
        const m = macro[i]!;
        const g = grass[i]!;
        const p = patch[i]!;
        const n = grain[i]!;
        height[i] = g * 0.6 + n * 0.4;

        // Base: lush green, with earthy patches and dry tufts.
        let r = 46 + m * 40 + g * 34;
        let gg = 92 + m * 58 + g * 62;
        let b = 34 + m * 26 + g * 22;

        const dirt = Math.max(0, p - 0.56) * 2.2; // bare earth patches
        r = r * (1 - dirt) + (104 + n * 44) * dirt;
        gg = gg * (1 - dirt) + (82 + n * 34) * dirt;
        b = b * (1 - dirt) + (56 + n * 24) * dirt;

        const dry = Math.max(0, 0.34 - p) * 1.6; // sun-bleached tufts
        r = r * (1 - dry) + (140 + n * 40) * dry;
        gg = gg * (1 - dry) + (146 + n * 40) * dry;
        b = b * (1 - dry) + (70 + n * 20) * dry;

        const j = i * 4;
        img.data[j] = Math.max(0, Math.min(255, r));
        img.data[j + 1] = Math.max(0, Math.min(255, gg));
        img.data[j + 2] = Math.max(0, Math.min(255, b));
        img.data[j + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const map = this.finalizeTexture(canvas, true, 1);

      const { canvas: rc, ctx: rctx } = this.makeCanvas(size);
      const rimg = rctx.createImageData(size, size);
      for (let i = 0; i < size * size; i++) {
        const rough = 210 + grass[i]! * 40 - Math.max(0, patch[i]! - 0.56) * 60;
        const j = i * 4;
        rimg.data[j] = rimg.data[j + 1] = rimg.data[j + 2] = Math.max(90, Math.min(255, rough));
        rimg.data[j + 3] = 255;
      }
      rctx.putImageData(rimg, 0, 0);
      const roughnessMap = this.finalizeTexture(rc, false, 1);

      const normalMap = this.finalizeTexture(this.heightToNormal(height, size, 1.6), false, 1);
      return { map, normalMap, roughnessMap };
    });
  }

  /**
   * An equirectangular sky: graded blue-to-haze dome with layered, soft
   * fractal clouds and a warm sun glow. Cached, so scene switches reuse it.
   */
  sky(): Texture {
    return this.cached('sky', () => {
      const w = 1024;
      const h = 512;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable');

      // Sky gradient: deep zenith blue → pale horizon haze → ground haze.
      // The top band is deliberately FLAT: an equirectangular texture collapses
      // its first rows into the sphere's pole, so any variation there shows up as
      // a hard ring when you look straight up.
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#1d4f86');
      grad.addColorStop(0.14, '#1d4f86');
      grad.addColorStop(0.26, '#2f74ab');
      grad.addColorStop(0.38, '#5fa0c6');
      grad.addColorStop(0.47, '#9fc6d3');
      grad.addColorStop(0.5, '#c4d8cf');
      grad.addColorStop(0.56, '#8fa87e');
      grad.addColorStop(1, '#5d7a53');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Sun with a soft halo, just above the horizon.
      const sunX = w * 0.5;
      const sunY = h * 0.4;
      const halo = ctx.createRadialGradient(sunX, sunY, 4, sunX, sunY, h * 0.34);
      halo.addColorStop(0, 'rgba(255,252,226,0.95)');
      halo.addColorStop(0.12, 'rgba(255,246,205,0.55)');
      halo.addColorStop(0.45, 'rgba(228,240,220,0.18)');
      halo.addColorStop(1, 'rgba(228,240,220,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);

      // Fractal cloud field: seamless horizontally, thinning toward the horizon.
      const cloudSize = 256;
      const c1 = this.fbm(cloudSize, 4, 5, 909);
      const c2 = this.fbm(cloudSize, 8, 4, 313);
      const clouds = ctx.createImageData(w, h);
      const horizon = h * 0.5;
      for (let y = 0; y < horizon; y++) {
        // Perspective: bands compress toward the horizon, and clouds stay
        // visible almost all the way down so the sky isn't a bare wash.
        const v = y / horizon; // 0 zenith → 1 horizon
        const sampleY = Math.pow(v, 2.4) * (cloudSize - 1);
        // Clouds start below the flat zenith cap (v > 0.3) so they never reach
        // the pole, where the projection would smear them into a ring.
        const poleGuard = Math.min(1, Math.max(0, (v - 0.3) / 0.18));
        const fade = Math.min(1, Math.pow(1 - v, 0.28) * 1.35) * poleGuard;
        for (let x = 0; x < w; x++) {
          const sampleX = (x / w) * cloudSize;
          const xi = Math.floor(sampleX) % cloudSize;
          const yi = Math.floor(sampleY) % cloudSize;
          const idx = yi * cloudSize + xi;
          const d = c1[idx]! * 0.65 + c2[idx]! * 0.35;
          // Threshold into billowy masses with soft edges.
          const density = Math.max(0, d - 0.44) * 3.4;
          const a = Math.min(1, density) * fade;
          if (a <= 0.004) continue;
          // Sunlit tops, shaded undersides.
          const shade = 196 + d * 58;
          const j = (y * w + x) * 4;
          clouds.data[j] = shade;
          clouds.data[j + 1] = Math.min(255, shade + 4);
          clouds.data[j + 2] = Math.min(255, shade + 12);
          clouds.data[j + 3] = a * 235;
        }
      }
      // Composite clouds over the gradient.
      const layer = document.createElement('canvas');
      layer.width = w;
      layer.height = h;
      const lctx = layer.getContext('2d');
      if (lctx) {
        lctx.putImageData(clouds, 0, 0);
        ctx.drawImage(layer, 0, 0);
      }

      const tex = new CanvasTexture(canvas);
      tex.colorSpace = SRGBColorSpace;
      tex.wrapS = RepeatWrapping;
      tex.needsUpdate = true;
      return this.track(tex);
    });
  }

  /** A soft green mossy/foliage color texture for ground cover. */
  moss(repeat = 6): Texture {
    return this.cached(`moss:${repeat}`, () => {
      const size = 256;
      const a = this.fbm(size, 6, 5, 7);
      const b = this.fbm(size, 24, 3, 53);
      const { canvas, ctx } = this.makeCanvas(size);
      const img = ctx.createImageData(size, size);
      for (let i = 0; i < size * size; i++) {
        const t = a[i]! * 0.7 + b[i]! * 0.3;
        const r = 40 + t * 60;
        const g = 90 + t * 110;
        const bl = 36 + t * 46;
        const j = i * 4;
        img.data[j] = r;
        img.data[j + 1] = g;
        img.data[j + 2] = bl;
        img.data[j + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return this.finalizeTexture(canvas, true, repeat);
    });
  }

  disposeAll(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables.clear();
    this.cache.clear();
  }
}
