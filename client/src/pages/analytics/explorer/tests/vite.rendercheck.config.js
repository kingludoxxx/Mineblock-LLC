/**
 * SSR bundle for renderCheck.jsx so the explorer can be RENDERED under node.
 * Inside the Lane 4 fence; client/vite.config.js is untouched.
 *
 *   cd client
 *   npx vite build --config src/pages/analytics/explorer/tests/vite.rendercheck.config.js
 *   node dist/explorer-render/renderCheck.js
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '../../../../..');

export default defineConfig({
  root: clientRoot,
  plugins: [react()],
  build: {
    ssr: resolve(here, 'renderCheck.jsx'),
    // Under dist/ so it is gitignored and lint-ignored like the other check.
    outDir: resolve(clientRoot, 'dist/explorer-render'),
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'renderCheck.js' } },
  },
});
