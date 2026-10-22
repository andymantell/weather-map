import { createReadStream, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * Serves the UK terrain bake (scripts/detail/bake_uk.py writes .cache/bake/, outside git) at
 * /bake/ in dev, for previewing baked tiles with ?tiles=<id>,<id> (src/detail/detailTerrain.ts).
 */
function bakedTiles(): Plugin {
  const root = fileURLToPath(new URL('.cache/bake/', import.meta.url));
  const types: Record<string, string> = { json: 'application/json', png: 'image/png', jpg: 'image/jpeg' };
  return {
    name: 'baked-tiles',
    configureServer(server) {
      server.middlewares.use('/bake/', (req, res) => {
        const path = normalize(join(root, decodeURIComponent((req.url ?? '').split('?')[0])));
        let found = false;
        try {
          found = path.startsWith(normalize(root)) && statSync(path).isFile();
        } catch {
          // missing: 404 below
        }
        if (!found) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('Content-Type', types[path.split('.').pop() ?? ''] ?? 'application/octet-stream');
        createReadStream(path).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // Relative asset paths so the build works from any host or sub-path.
  base: './',
  plugins: [bakedTiles()],
  // The terrain bake's caches (.cache/) hold hundreds of thousands of files that change all the
  // time while it runs; watching them stalls the dev server.
  server: { watch: { ignored: ['**/.cache/**'] } },
  build: {
    // Three.js alone is over the default 500 kB warning limit.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        // Terrain, towns and forests proof of concept (docs/terrain-towns-forests-poc.md).
        terrainPoc: fileURLToPath(new URL('poc/terrain/index.html', import.meta.url)),
        // Cloud lab for tuning each cloud type (docs/cloud-lab.md).
        clouds: fileURLToPath(new URL('clouds.html', import.meta.url)),
      },
    },
  },
});
