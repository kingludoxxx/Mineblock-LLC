/**
 * A build-check config for the explorer. Lives inside the Lane 4 fence and is
 * NOT part of the app build (client/vite.config.js is untouched).
 *
 *   cd client && npx vite build --config src/pages/analytics/explorer/tests/vite.buildcheck.config.js
 *
 * Why it exists: nothing in the app graph imports this directory until Lane 3
 * adds its lazy route, so a plain `npm run build` can pass without ever parsing
 * the explorer. This config makes buildEntry.jsx the rollup input so a compile
 * error here fails loudly instead of silently.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '../../../../..');

export default defineConfig({
  root: clientRoot,
  plugins: [react(), tailwindcss()],
  build: {
    // Deliberately UNDER dist/: that path is already gitignored and already in
    // eslint's globalIgnores, so a build check can never leak a minified bundle
    // into the repo or into the lint count.
    outDir: resolve(clientRoot, 'dist/explorer-check'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(here, 'buildEntry.jsx'),
      output: { format: 'es', entryFileNames: 'explorer.js' },
      preserveEntrySignatures: 'strict',
    },
  },
});
