import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works from any host or sub-path.
  base: './',
  build: {
    // Three.js alone is over the default 500 kB warning limit.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        // Terrain, towns and forests proof of concept (docs/terrain-towns-forests-poc.md).
        terrainPoc: fileURLToPath(new URL('poc/terrain/index.html', import.meta.url)),
      },
    },
  },
});
