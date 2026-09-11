// Vite config for the W6 harness page ONLY (client/dev/switcher-check.html).
// The app's own build (vite.config.js) is untouched: this one exists so the real Sidebar can be rendered in a
// real browser without a running dashboard. Output goes wherever the check points it (a temp directory).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(HERE, '..'),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: process.env.W6_OUT_DIR || resolve(HERE, '..', 'dist-w6-check'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(HERE, 'switcher-check.html') },
  },
});
