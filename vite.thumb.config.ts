// Builds the Linux app's thumbnailer page (thumb.html → electron/thumb), loaded from disk with
// relative paths. `npm run linux:build` runs this first.
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  publicDir: false, // only the page: no icons, manifest or service worker
  build: {
    outDir: 'electron/thumb',
    emptyOutDir: true,
    rollupOptions: { input: 'thumb.html' },
  },
});
