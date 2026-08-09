// MEDIA LIBRARY verification — drives the REAL /api/v1/media router (real
// authenticate + requirePermission + ensureMediaTables + mediaService) against
// embedded PG, with a MOCK Shopify Admin GraphQL + a MOCK image origin.
//
// The Shopify mock is reached through the SAME override seam production uses
// (MEDIA_SHOPIFY_API_BASE replaces the ORIGIN, path built exactly as
// checkoutPricing.js:101 builds it), so the pipeline under test is the real
// stagedUploadsCreate → staged POST → fileCreate → poll-until-READY code and
// not a stub.
//
// Proves BY EXECUTION:
//   T1  auth: no token / bad token / no funnels permission are refused
//   T2  upload happy path: base64 PNG → staged upload receives the EXACT bytes
//       → fileCreate → poll (UPLOADED then READY) → cdn url + parsed 4x3 dims
//   T3  header parsing on real fixtures: PNG / GIF / JPEG / WebP-lossy
//   T4  upload malformed: no data, bad base64, oversize (413), non-image (415),
//       a LYING mime (declared image/png over text bytes → 415)
//   T5  import-url SSRF refusals: http, ftp, localhost, 127.x, 10.x, 192.168.x,
//       172.16.x, 169.254.169.254, [::1], IPv4-mapped-IPv6 metadata
//   T6  import-url: happy (re-hosted to the mock CDN), 413 declared-oversize,
//       413 STREAMED-oversize (no content-length), 415 wrong content-type,
//       415 image/png header over non-image bytes, upstream 404
//   T7  list / paging / search over filename AND alt / ILIKE metachar safety
//   T8  patch alt, patch archived (archive-only; there is no DELETE route),
//       archived list, restore, 404 on unknown id, 400 on malformed patch
//   T9  scope failure: a stagedUploadsCreate ACCESS_DENIED userError surfaces
//       as 503 shopify_scope_missing with the operator's fix in the message
//   T10 no-backend degradation: upload 503, import-url still indexes the
//       ORIGINAL url with rehosted:false
//
// Run:  node server/tests/media/media.mjs      (idempotent — run it twice)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
// Poll fast — the mock returns UPLOADED once before READY, so the real polling
// loop is exercised without adding seconds to the run.
process.env.MEDIA_SHOPIFY_POLL_INTERVAL_MS = '20';
process.env.MEDIA_SHOPIFY_POLL_TIMEOUT_MS = '4000';
process.env.PUURE_SHOPIFY_TOKEN = 'shpat_mock_token';
process.env.PUURE_SHOPIFY_STORE = 'mock-store.myshopify.com';
delete process.env.MEDIA_STORAGE_BACKEND;

import zlib from 'node:zlib';
import express from 'express';
import jwt from 'jsonwebtoken';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${extra}`); }
};

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURES — real image bytes, not placeholders. Dimensions are asserted, so
// a broken parser cannot pass by returning null.
// ═══════════════════════════════════════════════════════════════════════════

// 4x3 PNG (a genuine, decodable file produced by zlib-stored IDAT).
const PNG_4x3 = (() => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(3, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  // 3 rows: filter byte 0 + 4 px * 3 bytes
  const raw = Buffer.concat(Array.from({ length: 3 }, () => Buffer.concat([
    Buffer.from([0]), Buffer.alloc(12, 0x7f),
  ])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
})();

// 1x1 transparent GIF (the canonical one), 1x1 white JPEG, 2x2 lossy WebP.
const GIF_1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const JPEG_1x1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEB'
  + 'AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh'
  + 'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ'
  + 'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG'
  + 'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+v//Z',
  'base64'
);
const WEBP_2x2 = (() => {
  // RIFF | size | WEBP | 'VP8 ' | chunkSize | frame tag(3) | 9d 01 2a | W | H | payload
  const vp8 = Buffer.concat([
    Buffer.from([0x30, 0x01, 0x00]),         // key-frame tag
    Buffer.from([0x9d, 0x01, 0x2a]),         // start code
    (() => { const b = Buffer.alloc(4); b.writeUInt16LE(2, 0); b.writeUInt16LE(2, 2); return b; })(),
    Buffer.alloc(8, 0),                      // filler payload
  ]);
  const head = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    Buffer.from('VP8 ', 'latin1'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(vp8.length); return b; })(),
    vp8,
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(head.length, 4);
  return Buffer.concat([riff, head]);
})();

// Tiny CRC32 — a PNG chunk with a wrong CRC is not a PNG, and the point of
// the fixture is that it is a REAL file, not a byte pattern that happens to
// satisfy our own parser.
function crc32(buf) {
  let c; const table = crc32.t || (crc32.t = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// MOCK SERVER — Shopify Admin GraphQL + staged-upload target + image origin.
// ═══════════════════════════════════════════════════════════════════════════
const mockState = {
  scopeDenied: false,
  stagedBody: null,        // raw multipart body received at /staged
  fileCreateCalls: 0,
  pollCalls: 0,
  graphqlAuthHeaders: [],
};

const mock = express();
mock.use('/staged', express.raw({ type: () => true, limit: '30mb' }));
mock.use(express.json({ limit: '30mb' }));

let MOCK_ORIGIN = '';

mock.post('/admin/api/:v/graphql.json', (req, res) => {
  const q = String(req.body?.query || '');
  mockState.graphqlAuthHeaders.push(Object.keys(req.headers).filter((h) => /shopify|authorization/i.test(h)));

  if (q.includes('stagedUploadsCreate')) {
    if (mockState.scopeDenied) {
      return res.json({
        data: {
          stagedUploadsCreate: {
            stagedTargets: [],
            userErrors: [{ field: ['input'], message: 'ACCESS_DENIED: write_files access scope required' }],
          },
        },
      });
    }
    return res.json({
      data: {
        stagedUploadsCreate: {
          stagedTargets: [{
            url: `${MOCK_ORIGIN}/staged`,
            resourceUrl: 'https://shopify-staged-uploads.example/mock-resource',
            parameters: [{ name: 'key', value: 'tmp/mock' }, { name: 'policy', value: 'abc' }],
          }],
          userErrors: [],
        },
      },
    });
  }

  if (q.includes('fileCreate')) {
    mockState.fileCreateCalls += 1;
    // Faithful: Shopify returns UPLOADED here, never READY — the caller MUST poll.
    return res.json({
      data: {
        fileCreate: {
          files: [{ id: 'gid://shopify/MediaImage/9001', fileStatus: 'UPLOADED', alt: '' }],
          userErrors: [],
        },
      },
    });
  }

  if (q.includes('fileStatus')) {
    mockState.pollCalls += 1;
    if (mockState.pollCalls % 2 === 1) {
      return res.json({ data: { node: { id: 'gid://shopify/MediaImage/9001', fileStatus: 'UPLOADED' } } });
    }
    return res.json({
      data: {
        node: {
          id: 'gid://shopify/MediaImage/9001',
          fileStatus: 'READY',
          // Shopify's echo is DELIBERATELY WRONG here (999x999) so the test
          // proves our own header parse wins over the CDN's numbers.
          image: { url: 'https://cdn.shopify.com/s/files/1/mock/tiny.png?v=1', width: 999, height: 999 },
        },
      },
    });
  }
  return res.status(400).json({ errors: [{ message: `unhandled query: ${q.slice(0, 60)}` }] });
});

mock.post('/staged', (req, res) => {
  mockState.stagedBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  res.status(204).end();
});

// ── image origin ────────────────────────────────────────────────────────────
mock.get('/img.png', (req, res) => { res.type('image/png').send(PNG_4x3); });
mock.get('/img.gif', (req, res) => { res.type('image/gif').send(GIF_1x1); });
mock.get('/notfound.png', (req, res) => { res.status(404).type('image/png').send('nope'); });
mock.get('/page.html', (req, res) => { res.type('text/html').send('<html>not an image</html>'); });
mock.get('/liar.png', (req, res) => { res.type('image/png').send(Buffer.from('this is plainly not a png at all')); });
mock.get('/big-declared.png', (req, res) => {
  // Declares an oversize content-length → the EARLY refusal path.
  const body = Buffer.concat([PNG_4x3, Buffer.alloc(1024, 0)]);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Length', String(11 * 1024 * 1024));
  res.end(body);
});
mock.get('/big-stream.png', async (req, res) => {
  // NO content-length (chunked) → only the STREAMING cap can catch this.
  res.setHeader('Content-Type', 'image/png');
  res.write(PNG_4x3);
  const mb = Buffer.alloc(1024 * 1024, 0x41);
  for (let i = 0; i < 12; i += 1) {
    if (res.writableEnded) break;
    if (!res.write(mb)) await new Promise((r) => res.once('drain', r));
  }
  try { res.end(); } catch { /* client already aborted — that is the pass */ }
});

const mockServer = mock.listen(0);
await new Promise((r) => mockServer.once('listening', r));
const MOCK_PORT = mockServer.address().port;
MOCK_ORIGIN = `http://127.0.0.1:${MOCK_PORT}`;
process.env.MEDIA_SHOPIFY_API_BASE = MOCK_ORIGIN;
// Dev/test-only loopback allow-list (hard-off when NODE_ENV==='production').
process.env.MEDIA_IMPORT_ALLOW_HOST = `127.0.0.1:${MOCK_PORT}`;

// ═══════════════════════════════════════════════════════════════════════════
// SEED — minimal users/roles/user_roles, same shape as the tracking harness.
// ═══════════════════════════════════════════════════════════════════════════
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES
  ('u_media_test', 'media@local.test', 'Media', 'Test'),
  ('u_media_noperm', 'noperm@local.test', 'No', 'Perm')
  ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions) VALUES
  ('r_media_test', 'media-tester', '{"funnels": ["access"]}'),
  ('r_media_noperm', 'media-noperm', '{"orders": ["access"]}')
  ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`;
await sql`DELETE FROM user_roles WHERE user_id IN ('u_media_test','u_media_noperm')`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES
  ('u_media_test','r_media_test'), ('u_media_noperm','r_media_noperm')`;

// Idempotency: this harness owns every row it writes, and it drops them up
// front so a second run starts from the same state as the first.
await sql`DROP TABLE IF EXISTS lb_media`;

const mediaRouter = (await import('../../src/routes/media.js')).default;
const mediaService = await import('../../src/services/mediaService.js');
const { ensureMediaTables } = await import('../../src/services/mediaSchema.js');
await ensureMediaTables();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/api/v1/media', mediaRouter);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const B = `http://127.0.0.1:${server.address().port}/api/v1/media`;

const token = jwt.sign({ userId: 'u_media_test' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const tokenNoPerm = jwt.sign({ userId: 'u_media_noperm' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; let text = '';
  try { text = await r.text(); j = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, j, text };
};
const code = (r) => r.j?.error?.code || `<${r.status}:${(r.text || '').slice(0, 60)}>`;

// ═══════════════════════════════════════════════════════════════════════════
// T1 — auth
// ═══════════════════════════════════════════════════════════════════════════
{
  const noTok = await req('GET', '/', undefined, { 'Content-Type': 'application/json' });
  check('T1 GET / without a token is 401', noTok.status === 401, String(noTok.status));
  const badTok = await req('GET', '/', undefined, { Authorization: 'Bearer not-a-jwt', 'Content-Type': 'application/json' });
  check('T1 GET / with a bad token is 401', badTok.status === 401, String(badTok.status));
  const up = await req('POST', '/upload', { data: 'AAAA' }, { 'Content-Type': 'application/json' });
  check('T1 POST /upload without a token is 401', up.status === 401, String(up.status));
  const noPerm = await req('GET', '/', undefined, { Authorization: `Bearer ${tokenNoPerm}`, 'Content-Type': 'application/json' });
  check('T1 a user without funnels:access is 403', noPerm.status === 403, String(noPerm.status));
}

// ═══════════════════════════════════════════════════════════════════════════
// T2 — upload happy path through the REAL Shopify pipeline
// ═══════════════════════════════════════════════════════════════════════════
let uploadedId = '';
{
  mockState.stagedBody = null;
  mockState.pollCalls = 0;
  const before = mockState.fileCreateCalls;
  const r = await req('POST', '/upload', {
    filename: '../../etc/hero shot".png',
    mime: 'image/png',
    data: PNG_4x3.toString('base64'),
    alt: 'A hero',
  });
  check('T2 upload returns 201', r.status === 201, code(r));
  const item = r.j?.item || {};
  uploadedId = item.id || '';
  check('T2 backend is shopify', r.j?.backend === 'shopify', JSON.stringify(r.j?.backend));
  check('T2 url is the polled CDN url',
    item.url === 'https://cdn.shopify.com/s/files/1/mock/tiny.png?v=1', String(item.url));
  check('T2 shopify_file_id stored', item.shopify_file_id === 'gid://shopify/MediaImage/9001', String(item.shopify_file_id));
  check('T2 dimensions parsed from OUR header read (4x3), not Shopify\'s 999x999',
    item.width === 4 && item.height === 3, `${item.width}x${item.height}`);
  check('T2 bytes recorded', item.bytes === PNG_4x3.length, `${item.bytes} vs ${PNG_4x3.length}`);
  check('T2 source=upload, kind=image', item.source === 'upload' && item.kind === 'image', JSON.stringify([item.source, item.kind]));
  check('T2 alt round-trips', item.alt === 'A hero', String(item.alt));
  check('T2 created_by is the caller', item.created_by === 'u_media_test', String(item.created_by));
  check('T2 fileCreate was called exactly once', mockState.fileCreateCalls === before + 1, String(mockState.fileCreateCalls - before));
  check('T2 the poll loop actually ran (UPLOADED then READY)', mockState.pollCalls >= 2, String(mockState.pollCalls));
  check('T2 the token travelled in a HEADER, never a URL',
    mockState.graphqlAuthHeaders.at(-1)?.includes('x-shopify-access-token'),
    JSON.stringify(mockState.graphqlAuthHeaders.at(-1)));

  // The staged POST must carry the pre-signed parameters FIRST and then the
  // EXACT bytes — a corrupted multipart body is a silently broken CDN object.
  const body = mockState.stagedBody || Buffer.alloc(0);
  check('T2 staged upload received a multipart body', body.length > PNG_4x3.length, String(body.length));
  check('T2 staged body carries the pre-signed parameters before the file',
    body.indexOf(Buffer.from('name="key"')) > -1
    && body.indexOf(Buffer.from('name="key"')) < body.indexOf(Buffer.from('name="file"')),
    String(body.indexOf(Buffer.from('name="key"'))));
  check('T2 staged body contains the EXACT png bytes', body.includes(PNG_4x3), 'png bytes not found verbatim');
  check('T2 filename was sanitised (no path, no quote, forced .png)',
    /filename="hero-shot\.png"/.test(body.toString('latin1')),
    (body.toString('latin1').match(/filename="[^"]*"/) || [''])[0]);
}

// ═══════════════════════════════════════════════════════════════════════════
// T3 — header parsing across formats (unit-level, on the real fixtures)
// ═══════════════════════════════════════════════════════════════════════════
{
  const d = mediaService.imageDimensions;
  check('T3 PNG 4x3', JSON.stringify(d(PNG_4x3)) === '{"width":4,"height":3}', JSON.stringify(d(PNG_4x3)));
  check('T3 GIF 1x1', JSON.stringify(d(GIF_1x1)) === '{"width":1,"height":1}', JSON.stringify(d(GIF_1x1)));
  const jd = d(JPEG_1x1);
  check('T3 JPEG 1x1', jd && jd.width === 1 && jd.height === 1, JSON.stringify(jd));
  const wd = d(WEBP_2x2);
  check('T3 WebP lossy 2x2', wd && wd.width === 2 && wd.height === 2, JSON.stringify(wd));
  check('T3 sniff identifies all four',
    mediaService.sniffMime(PNG_4x3) === 'image/png'
    && mediaService.sniffMime(GIF_1x1) === 'image/gif'
    && mediaService.sniffMime(JPEG_1x1) === 'image/jpeg'
    && mediaService.sniffMime(WEBP_2x2) === 'image/webp', '');
  check('T3 a truncated PNG yields null, it does not throw',
    d(PNG_4x3.subarray(0, 14)) === null, JSON.stringify(d(PNG_4x3.subarray(0, 14))));
  check('T3 garbage yields null', d(Buffer.alloc(64, 0x41)) === null, '');
  check('T3 an empty buffer yields null', d(Buffer.alloc(0)) === null, '');
}

// ═══════════════════════════════════════════════════════════════════════════
// T4 — upload malformed
// ═══════════════════════════════════════════════════════════════════════════
{
  const noData = await req('POST', '/upload', { filename: 'x.png', mime: 'image/png' });
  check('T4 missing data → 400 data_required', noData.status === 400 && code(noData) === 'data_required', code(noData));

  const badB64 = await req('POST', '/upload', { filename: 'x.png', mime: 'image/png', data: '!!!!' });
  check('T4 non-base64 data → 400/415', [400, 415].includes(badB64.status), code(badB64));

  // 5 MB cap: 6 MB of base64 must be refused on LENGTH, before any decode.
  const oversize = 'A'.repeat(Math.ceil((6 * 1024 * 1024) * 4 / 3));
  const big = await req('POST', '/upload', { filename: 'big.png', mime: 'image/png', data: oversize });
  check('T4 oversize upload → 413 too_large', big.status === 413 && code(big) === 'too_large', code(big));

  const text = await req('POST', '/upload', {
    filename: 'notes.txt', mime: 'text/plain', data: Buffer.from('hello there').toString('base64'),
  });
  check('T4 non-image bytes → 415 unsupported_type', text.status === 415 && code(text) === 'unsupported_type', code(text));

  // The declared mime is a CLAIM; the bytes are the fact.
  const liar = await req('POST', '/upload', {
    filename: 'evil.png', mime: 'image/png', data: Buffer.from('<svg onload=alert(1)>').toString('base64'),
  });
  check('T4 a LYING mime is judged on the bytes → 415',
    liar.status === 415 && code(liar) === 'unsupported_type', code(liar));

  // A data: URL body is accepted verbatim (that is what FileReader produces).
  const dataUrl = await req('POST', '/upload', {
    filename: 'du.gif', mime: 'image/gif', data: `data:image/gif;base64,${GIF_1x1.toString('base64')}`,
  });
  check('T4 a data: URL payload is accepted', dataUrl.status === 201, code(dataUrl));
}

// ═══════════════════════════════════════════════════════════════════════════
// T5 — import-url SSRF refusals (the allow-list covers ONLY 127.0.0.1:MOCK_PORT)
// ═══════════════════════════════════════════════════════════════════════════
{
  const cases = [
    ['http (plaintext) is refused', 'http://example.com/a.png', 'invalid_scheme'],
    ['ftp is refused', 'ftp://example.com/a.png', 'invalid_scheme'],
    ['file: is refused', 'file:///etc/passwd', 'invalid_scheme'],
    ['a garbage url is refused', 'not a url at all', 'invalid_scheme'],
    ['localhost is refused', 'https://localhost/a.png', 'blocked_host'],
    ['sub.localhost is refused', 'https://evil.localhost/a.png', 'blocked_host'],
    ['127.0.0.1 is refused', 'https://127.0.0.1/a.png', 'blocked_host'],
    ['127.x.x.x is refused', 'https://127.99.12.3/a.png', 'blocked_host'],
    ['10/8 is refused', 'https://10.1.2.3/a.png', 'blocked_host'],
    ['192.168/16 is refused', 'https://192.168.1.1/a.png', 'blocked_host'],
    ['172.16/12 is refused', 'https://172.20.0.5/a.png', 'blocked_host'],
    ['CGNAT 100.64/10 is refused', 'https://100.70.0.1/a.png', 'blocked_host'],
    ['cloud metadata 169.254.169.254 is refused', 'https://169.254.169.254/latest/meta-data/', 'blocked_host'],
    ['metadata.google.internal is refused', 'https://metadata.google.internal/x.png', 'blocked_host'],
    ['IPv6 loopback is refused', 'https://[::1]/a.png', 'blocked_host'],
    ['IPv6 ULA is refused', 'https://[fd00::1]/a.png', 'blocked_host'],
    ['IPv4-mapped metadata is refused (the classic bypass)', 'https://[::ffff:169.254.169.254]/a.png', 'blocked_host'],
    ['0.0.0.0 is refused', 'https://0.0.0.0/a.png', 'blocked_host'],
  ];
  for (const [name, url, want] of cases) {
    const r = await req('POST', '/import-url', { url });
    check(`T5 ${name}`, r.status === 400 && code(r) === want, `${r.status} ${code(r)}`);
  }
  const empty = await req('POST', '/import-url', {});
  check('T5 missing url → 400 url_required', empty.status === 400 && code(empty) === 'url_required', code(empty));
  const long = await req('POST', '/import-url', { url: `https://x.example/${'a'.repeat(2100)}.png` });
  check('T5 an absurdly long url → 400 url_too_long', long.status === 400 && code(long) === 'url_too_long', code(long));
}

// ═══════════════════════════════════════════════════════════════════════════
// T6 — import-url behaviour
// ═══════════════════════════════════════════════════════════════════════════
let importedId = '';
{
  const ok = await req('POST', '/import-url', { url: `${MOCK_ORIGIN}/img.png`, alt: 'imported hero' });
  check('T6 import happy path → 201', ok.status === 201, code(ok));
  importedId = ok.j?.item?.id || '';
  check('T6 rehosted:true', ok.j?.rehosted === true, JSON.stringify(ok.j?.rehosted));
  check('T6 the stored url is the CDN url, NOT the source url',
    ok.j?.item?.url === 'https://cdn.shopify.com/s/files/1/mock/tiny.png?v=1', String(ok.j?.item?.url));
  check('T6 source=url', ok.j?.item?.source === 'url', String(ok.j?.item?.source));
  check('T6 dimensions parsed on import', ok.j?.item?.width === 4 && ok.j?.item?.height === 3,
    `${ok.j?.item?.width}x${ok.j?.item?.height}`);
  check('T6 filename derived from the path', ok.j?.item?.filename === 'img.png', String(ok.j?.item?.filename));

  const gif = await req('POST', '/import-url', { url: `${MOCK_ORIGIN}/img.gif` });
  check('T6 a GIF imports too', gif.status === 201 && gif.j?.item?.mime === 'image/gif', code(gif));

  const html = await req('POST', '/import-url', { url: `${MOCK_ORIGIN}/page.html` });
  check('T6 text/html content-type → 415', html.status === 415 && code(html) === 'unsupported_type', code(html));

  const liar = await req('POST', '/import-url', { url: `${MOCK_ORIGIN}/liar.png` });
  check('T6 image/png header over non-image bytes → 415',
    liar.status === 415 && code(liar) === 'unsupported_type', code(liar));

  const declared = await req('POST', '/import-url', { url: `${MOCK_ORIGIN}/big-declared.png` });
  check('T6 declared-oversize → 413 (refused before the body is read)',
    declared.status === 413 && code(declared) === 'too_large', code(declared));

  const streamed = await req('POST', '/import-url', { url: `${MOCK_ORIGIN}/big-stream.png` });
  check('T6 STREAMED oversize with no content-length → 413',
    streamed.status === 413 && code(streamed) === 'too_large', code(streamed));

  const missing = await req('POST', '/import-url', { url: `${MOCK_ORIGIN}/notfound.png` });
  check('T6 upstream 404 → 400 upstream_status',
    missing.status === 400 && code(missing) === 'upstream_status', code(missing));
}

// ═══════════════════════════════════════════════════════════════════════════
// T7 — list / paging / search
// ═══════════════════════════════════════════════════════════════════════════
{
  const all = await req('GET', '/');
  check('T7 list returns 200 with the rows created so far', all.status === 200 && all.j?.items?.length >= 4,
    `${all.status} n=${all.j?.items?.length}`);
  check('T7 total is an integer', Number.isInteger(all.j?.total), JSON.stringify(all.j?.total));
  check('T7 newest first', (() => {
    const ts = (all.j?.items || []).map((i) => new Date(i.created_at).getTime());
    return ts.every((t, i) => i === 0 || ts[i - 1] >= t);
  })(), JSON.stringify((all.j?.items || []).map((i) => i.created_at)));

  const byName = await req('GET', '/?q=hero');
  check('T7 search matches FILENAME (hero-shot.png)',
    byName.j?.items?.some((i) => i.filename === 'hero-shot.png'), JSON.stringify(byName.j?.items?.map((i) => i.filename)));
  check('T7 search also matches ALT ("imported hero")',
    byName.j?.items?.some((i) => i.id === importedId), JSON.stringify(byName.j?.items?.map((i) => i.alt)));

  const none = await req('GET', '/?q=zzz-no-such-thing');
  check('T7 a non-matching search is an empty list, not an error',
    none.status === 200 && none.j?.items?.length === 0 && none.j?.total === 0, JSON.stringify(none.j));

  // ILIKE metacharacters must be escaped, or '%' matches everything.
  const meta = await req('GET', '/?q=%25');
  check('T7 a bare % in the query does NOT match everything',
    meta.status === 200 && meta.j?.total === 0, `total=${meta.j?.total}`);

  const paged = await req('GET', '/?limit=1&offset=0');
  check('T7 limit=1 returns one row', paged.j?.items?.length === 1, String(paged.j?.items?.length));
  check('T7 has_more is true when more remain', paged.j?.has_more === true, String(paged.j?.has_more));
  const page2 = await req('GET', '/?limit=1&offset=1');
  check('T7 offset advances to a different row',
    page2.j?.items?.[0]?.id && page2.j.items[0].id !== paged.j.items[0].id, '');
  check('T7 an absurd limit is clamped, not honoured',
    (await req('GET', '/?limit=99999')).j?.limit === 200, '');
  check('T7 a garbage limit falls back to the default',
    (await req('GET', '/?limit=abc')).j?.limit === 60, '');
}

// ═══════════════════════════════════════════════════════════════════════════
// T8 — patch / archive (there is no DELETE route, on purpose)
// ═══════════════════════════════════════════════════════════════════════════
{
  const del = await fetch(`${B}/${uploadedId}`, { method: 'DELETE', headers: H });
  check('T8 DELETE is not routed (archive-only)', del.status === 404 || del.status === 405, String(del.status));

  const alt = await req('PATCH', `/${uploadedId}`, { alt: 'Updated alt text' });
  check('T8 patch alt → 200', alt.status === 200 && alt.j?.item?.alt === 'Updated alt text', code(alt));

  const bad = await req('PATCH', `/${uploadedId}`, { alt: 42 });
  check('T8 non-string alt → 400 invalid_alt', bad.status === 400 && code(bad) === 'invalid_alt', code(bad));
  const badArch = await req('PATCH', `/${uploadedId}`, { archived: 'yes' });
  check('T8 non-boolean archived → 400 invalid_archived', badArch.status === 400 && code(badArch) === 'invalid_archived', code(badArch));
  const nothing = await req('PATCH', `/${uploadedId}`, {});
  check('T8 empty patch → 400 nothing_to_update', nothing.status === 400 && code(nothing) === 'nothing_to_update', code(nothing));
  const ghost = await req('PATCH', '/med_does_not_exist', { alt: 'x' });
  check('T8 unknown id → 404 not_found', ghost.status === 404 && code(ghost) === 'not_found', code(ghost));

  const arch = await req('PATCH', `/${uploadedId}`, { archived: true });
  check('T8 archive → 200 archived:true', arch.status === 200 && arch.j?.item?.archived === true, code(arch));
  const live = await req('GET', '/');
  check('T8 an archived row leaves the default list',
    !(live.j?.items || []).some((i) => i.id === uploadedId), '');
  const archList = await req('GET', '/?archived=true');
  check('T8 ?archived=true shows it',
    (archList.j?.items || []).some((i) => i.id === uploadedId), JSON.stringify(archList.j?.total));

  const restore = await req('PATCH', `/${uploadedId}`, { archived: false });
  check('T8 restore → archived:false', restore.status === 200 && restore.j?.item?.archived === false, code(restore));
  const backLive = await req('GET', '/');
  check('T8 the restored row is back in the default list',
    (backLive.j?.items || []).some((i) => i.id === uploadedId), '');

  const rows = await sql`SELECT COUNT(*)::int AS n FROM lb_media`;
  check('T8 nothing was ever hard-deleted', rows[0].n >= 4, JSON.stringify(rows[0]));
}

// ═══════════════════════════════════════════════════════════════════════════
// T9 — the missing-scope path (the whole point of the live-smoke question)
// ═══════════════════════════════════════════════════════════════════════════
{
  mockState.scopeDenied = true;
  const r = await req('POST', '/upload', {
    filename: 'scope.png', mime: 'image/png', data: PNG_4x3.toString('base64'),
  });
  check('T9 ACCESS_DENIED on stagedUploadsCreate → 503', r.status === 503, `${r.status} ${code(r)}`);
  check('T9 the code names the SCOPE, not a generic outage', code(r) === 'shopify_scope_missing', code(r));
  check('T9 the message tells the operator exactly what to grant',
    /write_files/.test(String(r.j?.error?.message || '')), String(r.j?.error?.message));
  const rows = await sql`SELECT COUNT(*)::int AS n FROM lb_media WHERE filename = 'scope.png'`;
  check('T9 a failed upload wrote NO row', rows[0].n === 0, JSON.stringify(rows[0]));
  mockState.scopeDenied = false;
}

// ═══════════════════════════════════════════════════════════════════════════
// T10 — no backend configured: honest degradation
// ═══════════════════════════════════════════════════════════════════════════
{
  const savedBase = process.env.MEDIA_SHOPIFY_API_BASE;
  process.env.MEDIA_STORAGE_BACKEND = 'none';

  const st = await req('GET', '/storage');
  check('T10 /storage reports backend:null and uploads off',
    st.status === 200 && st.j?.backend === null && st.j?.uploads_enabled === false, JSON.stringify(st.j));

  const up = await req('POST', '/upload', {
    filename: 'nb.png', mime: 'image/png', data: PNG_4x3.toString('base64'),
  });
  check('T10 upload with no backend → 503 storage_not_configured',
    up.status === 503 && code(up) === 'storage_not_configured', `${up.status} ${code(up)}`);

  const imp = await req('POST', '/import-url', { url: `${MOCK_ORIGIN}/img.png` });
  check('T10 import-url still succeeds (index-only)', imp.status === 201, code(imp));
  check('T10 rehosted:false is REPORTED, not hidden', imp.j?.rehosted === false, JSON.stringify(imp.j?.rehosted));
  check('T10 rehost_error names the reason', imp.j?.rehost_error === 'storage_not_configured', String(imp.j?.rehost_error));
  check('T10 the ORIGINAL url is what got indexed',
    imp.j?.item?.url === `${MOCK_ORIGIN}/img.png`, String(imp.j?.item?.url));
  check('T10 shopify_file_id is null for an un-rehosted row',
    imp.j?.item?.shopify_file_id === null, String(imp.j?.item?.shopify_file_id));

  delete process.env.MEDIA_STORAGE_BACKEND;
  process.env.MEDIA_SHOPIFY_API_BASE = savedBase;
  const st2 = await req('GET', '/storage');
  check('T10 the backend comes back once configured again', st2.j?.backend === 'shopify', JSON.stringify(st2.j?.backend));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
server.close();
mockServer.close();
await sql.end({ timeout: 5 });
process.exit(fail === 0 ? 0 : 1);
