// Runner for toast-batch.jsx — the pushBatch/fireMany composition harness.
//
// Bundles with the project's own vite/react toolchain, but ALIASES 'react' and
// the JSX runtime to hookRuntime.jsx, so the real HOOKS run against a
// positional-hook runtime with real commits, real effects and real timers. No
// jsdom, no browser.
//
// Run:  node server/tests/live-view/run-toast-batch.mjs
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rm, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '../../../client');
const entry = resolve(here, 'toast-batch.jsx');
const runtime = resolve(here, 'hookRuntime.jsx');

const req = createRequire(resolve(clientRoot, 'package.json'));
let build, react;
try {
  ({ build } = await import(pathToFileURL(req.resolve('vite')).href));
  react = (await import(pathToFileURL(req.resolve('@vitejs/plugin-react')).href)).default;
} catch (e) {
  console.error('[live-view/toast-batch] client dependencies are not installed.');
  console.error('  Run: cd client && npm install');
  console.error(`  (${e.message})`);
  process.exit(2);
}

const outDir = await mkdtemp(resolve(clientRoot, 'node_modules', '.lv-batch-'));

try {
  await build({
    root: clientRoot,
    configFile: false,
    logLevel: 'error',
    plugins: [react()],
    resolve: {
      alias: [
        // The component under test imports 'react'; it gets the hook runtime.
        { find: /^react$/, replacement: runtime },
        { find: /^react\/jsx-runtime$/, replacement: runtime },
        { find: /^react\/jsx-dev-runtime$/, replacement: runtime },
      ],
    },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      minify: false,
      // lucide-react renders icons through the same aliased JSX factory, so it
      // must be bundled (not externalised) or it would pull in real React.
      rollupOptions: { output: { entryFileNames: 'batch.mjs' } },
    },
  });

  const child = spawn(process.execPath, [resolve(outDir, 'batch.mjs')], {
    stdio: 'inherit',
    cwd: clientRoot,
  });
  const code = await new Promise((res) => child.on('exit', res));
  if (code !== 0) process.exitCode = code || 1;
} finally {
  await rm(outDir, { recursive: true, force: true });
}
