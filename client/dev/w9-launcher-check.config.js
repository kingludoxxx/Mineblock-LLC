// Vite config for the W9 harness page ONLY (client/dev/w9-launcher-check.html).
// The app's own build (vite.config.js) is untouched and so is the W6/W8 harness
// config next to this one: W9 gets its own entry so no other lane's files move.
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
    outDir: process.env.W9_OUT_DIR || resolve(HERE, '..', 'dist-w9-check'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(HERE, 'w9-launcher-check.html') },
  },
});
