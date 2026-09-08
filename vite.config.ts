import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

// https://vite.dev/config/
// The config is tuned for a WebGL/WebGPU game that ships to both the browser
// and a native shell (Tauri). Tauri sets TAURI_ENV_* vars during its builds.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  // Relative base so the same build works when loaded from a file:// origin
  // inside the native shell as well as from a web server.
  base: './',

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 5173,
    strictPort: false,
    host: true, // expose on LAN — handy for testing on a phone
  },

  build: {
    // Modern targets: browsers with WebGL2/WebGPU and the Tauri webview.
    target: isTauri ? ['es2022', 'chrome110', 'safari16'] : 'es2022',
    outDir: 'dist',
    sourcemap: false,
    minify: 'esbuild',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          // Keep the heavy render deps in their own cacheable chunk.
          three: ['three'],
          postprocessing: ['postprocessing'],
        },
      },
    },
  },

  // Pre-bundle the big libs for a fast dev server.
  optimizeDeps: {
    include: ['three', 'postprocessing'],
  },

  // Surface the package version to the UI (shown on the start screen).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // Prevent Vite from clearing the terminal during Tauri dev.
  clearScreen: false,
});
