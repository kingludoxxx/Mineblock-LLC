// Runner for render-smoke.jsx.
//
// The smoke test is JSX, so node cannot execute it directly. Rather than add a
// test-runner dependency, this bundles it with the project's OWN vite + react
// toolchain in SSR mode and runs the output — so what is verified is the code
// as the real build sees it, not a separately-transpiled copy.
//
// Run:  node server/tests/live-view/run-render-smoke.mjs
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '../../../client');
const entry = resolve(here, 'render-smoke.jsx');

// vite and the react plugin live in client/node_modules, and node resolves a
// bare specifier relative to THIS file, not to cwd. Resolve them explicitly
// from the client root instead of requiring a duplicate install.
const req = createRequire(resolve(clientRoot, 'package.json'));
let build, react;
try {
  ({ build } = await import(pathToFileURL(req.resolve('vite')).href));
  react = (await import(pathToFileURL(req.resolve('@vitejs/plugin-react')).href)).default;
} catch (e) {
  console.error('[live-view/render-smoke] client dependencies are not installed.');
  console.error('  Run: cd client && npm install');
  console.error(`  (${e.message})`);
  process.exit(2);
}

// The bundle is emitted INSIDE client/node_modules on purpose: react,
// react-dom and lucide-react stay external (a bundled React would not be the
// one the app ships), and an ES module's bare specifiers resolve relative to
// the importing FILE, not to cwd. Anywhere under client/ resolves; a temp dir
// does not.
const outDir = await mkdtemp(resolve(clientRoot, 'node_modules', '.lv-smoke-'));

try {
  await build({
    root: clientRoot,
    // Do NOT load client/vite.config.js — it configures a dev proxy this test
    // has no use for, and its plugin list would be applied twice.
    configFile: false,
    logLevel: 'error',
    plugins: [react()],
    // No tailwind plugin: the CSS is irrelevant to renderToStaticMarkup, and
    // leaving it out keeps the bundle (and the failure surface) small.
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        external: [/^react($|\/)/, /^react-dom($|\/)/, 'lucide-react'],
        output: { entryFileNames: 'smoke.mjs' },
      },
    },
  });

  const child = spawn(process.execPath, [resolve(outDir, 'smoke.mjs')], {
    stdio: 'inherit',
    cwd: clientRoot,
  });
  const code = await new Promise((res) => child.on('exit', res));
  if (code !== 0) process.exitCode = code || 1;
} finally {
  await rm(outDir, { recursive: true, force: true });
}
