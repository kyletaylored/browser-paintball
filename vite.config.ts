import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  build: {
    // three.js alone is ~700 kB minified (~200 kB gzipped); that's normal for a 3D game.
    chunkSizeWarningLimit: 1000,
  },
});
