import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works from any host or sub-path.
  base: './',
  build: {
    // Three.js alone is over the default 500 kB warning limit.
    chunkSizeWarningLimit: 1000,
  },
});
