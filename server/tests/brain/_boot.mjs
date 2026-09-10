// A minimal dashboard host that mounts ONLY the Brain router, exactly as
// routes/index.js does. Spawned as a CHILD PROCESS by the isolation test so each
// "store" gets its own process with its own DATABASE_URL — which is the whole
// point: retrieval is scoped by CONSTRUCTION (the API runs inside the store's
// dashboard against the store's database), not by a filter this test could bypass.
//
// env: DATABASE_URL, BRAIN_SERVICE_TOKEN, PRODUCT_CODES_JSON. Prints "LISTENING <port>".
// run-all.mjs discovers every .mjs under server/tests and runs it as a test. This
// is a HOST, not a test: without the guard it would listen forever and time out.
if (process.env.BRAIN_TEST_HOST !== '1') {
  console.log('SKIP  brain/_boot.mjs is the isolation test\'s dashboard host, not a test (set BRAIN_TEST_HOST=1 to run it)');
  process.exit(0);
}

const { default: express } = await import('express');
const { default: brainRoutes } = await import('../../src/routes/brain.js');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/v1/brain', brainRoutes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
console.log(`LISTENING ${server.address().port}`);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
