import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const SERVER = `http://127.0.0.1:${process.env.PORT ?? 3210}`;

export default defineConfig({
  plugins: [svelte()],
  build: { outDir: 'dist/client', emptyOutDir: true, target: 'es2022' },
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: {
      '/api': SERVER,
      '/ws': { target: SERVER, ws: true },
    },
  },
});
