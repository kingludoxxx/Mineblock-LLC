// THEME SYSTEM verification — drives the REAL /api/v1/funnel-themes router
// (real authenticate + requirePermission + ensureTables) against embedded PG,
// exactly like patch-settings.mjs.
//
// Proves by execution:
//   1. the 7-preset library ported faithfully (count, slugs, all 11 tokens);
//   2. the apply macro is a TRUE INTERSECTION — every key it writes is a key
//      funnelRender.js already reads, proven by feeding the resulting settings
//      to the REAL funnelSettingsHead and finding the theme's color and font
//      in the emitted <head>, with the renderer unmodified;
//   3. the token support map does not lie — every 'none' token is absent from
//      the emitted head, and every claimed write actually lands;
//   4. the theme layer's hex validator AGREES with the renderer's, checked
//      against the renderer itself over a shared corpus (a token accepted here
//      but dropped there is a settings write that silently emits nothing);
//   5. the color/font extraction rules reproduce the reference's heuristics,
//      including its quirks, against fixture HTML;
//   6. import-url REFUSES SSRF targets (metadata IP, loopback, private ranges,
//      IPv4-mapped IPv6, non-http schemes) with one fixed code;
//   7. CRUD round-trips through jsonb correctly (jsonb_typeof = 'object', not
//      the 'string' a bare ::jsonb cast would store).
//
// Run:  node server/tests/funnel-settings/themes.mjs
process.env.DATABASE_URL = 'postgres://puure@127.0.0.1:5433/puure_shoporder';
process.env.NODE_ENV = 'development';

const NM = '/Users/ludo/Mineblock-LLC/node_modules';
const express = (await import(`${NM}/express/index.js`)).default;
const jwt = (await import(`${NM}/jsonwebtoken/index.js`)).default;
const postgres = (await import(`${NM}/postgres/src/index.js`)).default;

const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });

// ── seed auth: minimal users/roles tables + a funnels:access user ───────────
await sql`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT,
  must_change_password BOOLEAN DEFAULT FALSE, email_verified BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE
)`;
await sql`CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT, permissions JSONB)`;
await sql`CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT, role_id TEXT)`;
await sql`INSERT INTO users (id, email, first_name, last_name) VALUES ('u_thm_test', 'thm@local.test', 'Thm', 'Test') ON CONFLICT (id) DO NOTHING`;
await sql`INSERT INTO roles (id, name, permissions) VALUES ('r_thm_test', 'themes-tester', '{"funnels": ["access"]}') ON CONFLICT (id) DO NOTHING`;
await sql`DELETE FROM user_roles WHERE user_id = 'u_thm_test'`;
await sql`INSERT INTO user_roles (user_id, role_id) VALUES ('u_thm_test', 'r_thm_test')`;

const themesMod = await import('../../src/routes/funnelThemes.js');
const themesRouter = themesMod.default;
const T = await import('../../src/services/funnelThemes.js');
const G = await import('../../src/services/themeImportGuard.js');
const PLAN = await import('../../../client/src/components/funnels/settings/themePlan.js');
const { funnelSettingsHead, FUNNEL_FONTS } = await import('../../src/services/funnelRender.js');

// Neutralize the shared rate limiter for every import-url test EXCEPT the one
// that asserts the 429 — otherwise the SSRF corpus (16 calls) trips the cap and
// its assertions read the limiter's refusal, not the guard's. The dedicated
// rate-limit test flips this to a denying stub and restores it.
const RL_ALLOW = async () => ({ allowed: true, remaining: 99, retryAfter: 0 });
themesMod._hooks.checkRateLimit = RL_ALLOW;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/v1/funnel-themes', themesRouter);
const server = app.listen(0);
const PORT = server.address().port;
const B = `http://127.0.0.1:${PORT}/api/v1/funnel-themes`;

const token = jwt.sign({ userId: 'u_thm_test' }, process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me', { expiresIn: '10m' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}  ${extra}`); } };
const req = async (method, path, body, headers = H) => {
  const r = await fetch(`${B}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* non-JSON body */ }
  return { status: r.status, j };
};

// ════════════════════════════════════════════════════════════════════════════
// 1. PRESET LIBRARY — ported faithfully
// ════════════════════════════════════════════════════════════════════════════
{
  const presets = T.listPresets();
  check('presets: 7 seeded (matches the reference _PRESETS)', presets.length === 7, `got ${presets.length}`);
  check('presets: slugs match the reference',
    JSON.stringify(presets.map((p) => p.preset_slug))
      === JSON.stringify(['brand', 'editorial', 'minimal', 'health', 'tech', 'editorial-dark', 'conversion-dr']),
    presets.map((p) => p.preset_slug).join(','));
  check('presets: ids unique', new Set(presets.map((p) => p.id)).size === 7);
  check('presets: every preset carries all 11 tokens',
    presets.every((p) => T.TOKEN_KEYS.every((k) => typeof p.tokens[k] === 'string' && p.tokens[k])),
    presets.filter((p) => !T.TOKEN_KEYS.every((k) => p.tokens[k])).map((p) => p.preset_slug).join(','));
  check('presets: stamped is_preset', presets.every((p) => p.is_preset === true));
  check('presets: every preset has a description', presets.every((p) => typeof p.description === 'string' && p.description.length > 10));

  // The reference's deliberate house-style quirk: cta_bg is pinned to Slash
  // green on 5 of 7 presets, and on 4 of those it deliberately DISAGREES with
  // `primary`. Normalizing cta_bg to primary would silently redesign those
  // four, so the port must preserve the disagreement.
  const slashGreen = presets.filter((p) => p.tokens.cta_bg === '#5FAE5F').map((p) => p.preset_slug);
  const ctaDiffers = presets.filter((p) => p.tokens.cta_bg !== p.tokens.primary).map((p) => p.preset_slug);
  check('presets: cta_bg pinned to #5FAE5F on 5 of 7',
    slashGreen.length === 5, slashGreen.join(','));
  check('presets: the house quirk — cta_bg deliberately differs from primary on 4',
    ctaDiffers.length === 4
    && JSON.stringify(ctaDiffers) === JSON.stringify(['editorial', 'health', 'editorial-dark', 'conversion-dr']),
    ctaDiffers.join(','));
  check('presets: hex casing copied literally (brand upper, editorial lower)',
    presets[0].tokens.primary === '#5FAE5F' && presets[1].tokens.background === '#fdfaf6');

  // Mutation safety: listPresets/getPreset hand out copies, so a caller that
  // edits a returned token bag cannot corrupt the library for every later read.
  const p0 = T.getPreset('brand');
  p0.tokens.primary = '#000000';
  check('presets: getPreset returns a COPY (library is immutable to callers)',
    T.getPreset('brand').tokens.primary === '#5FAE5F');
  check('presets: unknown slug → null', T.getPreset('nope') === null);
}

// ════════════════════════════════════════════════════════════════════════════
// 2. HEX VALIDATOR AGREES WITH THE RENDERER'S
// ════════════════════════════════════════════════════════════════════════════
// funnelRender's isHexColor is not exported, so it is probed THROUGH the real
// funnelSettingsHead: a color it accepts appears in the emitted <style>. If the
// theme layer accepts a value the renderer drops, applying that token is a
// settings write that emits nothing — a claim the UI would be making falsely.
{
  const corpus = [
    '#fff', '#ffffff', '#ffffffff', '#5FAE5F', '#0b1220',
    'fff', '#ff', '#fffff', '#gggggg', '', 'red', 'rgb(1,2,3)',
    '#fff;}</style><script>alert(1)</script>', '#fff /*x*/', ' #ffffff ',
  ];
  const disagreements = [];
  for (const c of corpus) {
    const head = funnelSettingsHead({ brand_colors: { primary: c } });
    const rendererAccepts = head.includes('--brand-primary');
    if (rendererAccepts !== T.isHexColor(c)) disagreements.push(c);
  }
  check('hex: theme validator agrees with the renderer over the whole corpus',
    disagreements.length === 0, `disagreed on: ${JSON.stringify(disagreements)}`);
  check('hex: the CSS-breakout attempt is refused by BOTH',
    !T.isHexColor('#fff;}</style><script>alert(1)</script>')
    && !funnelSettingsHead({ brand_colors: { primary: '#fff;}</style><script>alert(1)</script>' } }).includes('--brand-primary'));
}

// ════════════════════════════════════════════════════════════════════════════
// 3. FONT RESOLUTION
// ════════════════════════════════════════════════════════════════════════════
{
  check('font: walks the stack to the first allowlisted family',
    T.resolveFontKey("'Inter Tight', 'Inter', system-ui, sans-serif") === 'inter');
  check('font: multi-word family key form', T.resolveFontKey("'Open Sans', sans-serif") === 'open-sans');
  check('font: falls through an unknown head to a known tail',
    T.resolveFontKey("'Source Serif Pro', Georgia, serif") === 'georgia');
  check('font: unresolvable stack → null (no invented substitution)',
    T.resolveFontKey("'JetBrains Mono', monospace") === null
    && T.resolveFontKey("'Plus Jakarta Sans', system-ui, sans-serif") === null);
  check('font: the "default" sentinel is never matched from a stack',
    T.resolveFontKey('default') === null && T.resolveFontKey("'default', sans-serif") === null);
  check('font: junk input → null', T.resolveFontKey('') === null && T.resolveFontKey(null) === null && T.resolveFontKey(42) === null);

  // Every key this resolves to must exist in the renderer's allowlist, or the
  // renderer emits nothing for a font we reported as applied.
  const resolved = T.PRESETS.map((p) => T.resolveFontKey(p.tokens.font_body)).filter(Boolean);
  check('font: every resolved key is in the renderer FUNNEL_FONTS allowlist',
    resolved.every((k) => Object.prototype.hasOwnProperty.call(FUNNEL_FONTS, k)), resolved.join(','));
  check('font: 5 of 7 presets resolve to an allowlisted family (2 honestly do not)',
    resolved.length === 5, `resolved=${resolved.join(',')}`);
}

// ════════════════════════════════════════════════════════════════════════════
// 4. THE APPLY MACRO — intersection, honestly reported
// ════════════════════════════════════════════════════════════════════════════
{
  const brand = T.getPreset('brand');
  const plan = T.buildApplyPlan(brand.tokens, {});
  const paths = plan.writes.map((w) => w.path).sort();
  check('apply: writes exactly the 3 live settings paths',
    JSON.stringify(paths) === JSON.stringify(['brand_colors.primary', 'brand_colors.secondary', 'fonts.family']),
    JSON.stringify(paths));

  // THE CENTRAL CLAIM: every written path is a path the renderer already reads.
  const LIVE_PATHS = new Set(['brand_colors.primary', 'brand_colors.secondary', 'fonts.family']);
  check('apply: NO write touches a path outside the renderer\'s live key set',
    plan.writes.every((w) => LIVE_PATHS.has(w.path)));

  const skippedTokens = plan.skipped.map((s) => s.token).sort();
  check('apply: the 8 unsupported tokens are all reported as skipped',
    JSON.stringify(skippedTokens) === JSON.stringify(
      ['background', 'border', 'cta_bg', 'cta_fg', 'font_heading', 'foreground', 'muted', 'radius']),
    JSON.stringify(skippedTokens));
  check('apply: every skipped token carries a reason AND operator-facing copy',
    plan.skipped.every((s) => s.reason && typeof s.note === 'string' && s.note.length > 15));
  check('apply: writes + skipped account for every token in the bag',
    plan.writes.length + plan.skipped.length === T.TOKEN_KEYS.length,
    `${plan.writes.length}+${plan.skipped.length} vs ${T.TOKEN_KEYS.length}`);

  // Support map must not over-claim: nothing marked 'applied' exists, because
  // nothing in this renderer applies a token unconditionally-visibly.
  check('apply: support map claims only variable/partial/none — never "applied"',
    Object.values(T.TOKEN_SUPPORT).every((s) => ['variable', 'partial', 'none'].includes(s.support)));
  check('apply: every token key has a support entry',
    T.TOKEN_KEYS.every((k) => T.TOKEN_SUPPORT[k] && typeof T.TOKEN_SUPPORT[k].note === 'string'));
}

// ── overwrite accounting: the confirm dialog's honesty ─────────────────────
{
  const existing = { brand_colors: { primary: '#123456', secondary: '#abcdef' }, fonts: { family: 'lato' } };
  const plan = T.buildApplyPlan(T.getPreset('brand').tokens, existing);
  check('apply: overwrites list every hand-tuned value being destroyed',
    plan.overwrites.length === 3
    && plan.overwrites.every((o) => o.from && o.to && o.from !== o.to),
    JSON.stringify(plan.overwrites));
  check('apply: overwrite entries name the settings path being replaced',
    plan.overwrites.map((o) => o.path).sort().join(',')
      === 'brand_colors.primary,brand_colors.secondary,fonts.family');

  // A fill is not an overwrite — nothing is destroyed when the key was empty.
  const fresh = T.buildApplyPlan(T.getPreset('brand').tokens, {});
  check('apply: writing into EMPTY settings reports zero overwrites (a fill, not a clobber)',
    fresh.overwrites.length === 0 && fresh.changed_count === 3);

  // Re-applying the same theme changes nothing and must say so.
  const applied = T.applyPlanToSettings(fresh, {});
  const again = T.buildApplyPlan(T.getPreset('brand').tokens, applied);
  check('apply: re-applying the same theme reports changed_count 0 (idempotent)',
    again.changed_count === 0 && again.overwrites.length === 0, JSON.stringify(again.overwrites));

  // 'default' is the renderer's no-op sentinel, not an operator's hand-tuned
  // choice, so replacing it is a fill rather than a destructive overwrite.
  const fromDefault = T.buildApplyPlan(T.getPreset('brand').tokens, { fonts: { family: 'default' } });
  check('apply: replacing fonts.family="default" is not counted as an overwrite',
    !fromDefault.overwrites.some((o) => o.path === 'fonts.family'));
}

// ── a bad token never becomes a silent no-op write ────────────────────────
{
  const plan = T.buildApplyPlan({ primary: 'not-a-color', secondary: '#5FAE5F' }, {});
  check('apply: a non-hex color is SKIPPED with a reason, never written',
    plan.writes.length === 1 && plan.writes[0].path === 'brand_colors.secondary'
    && plan.skipped.some((s) => s.token === 'primary' && s.reason === 'not_a_hex_color'),
    JSON.stringify(plan));

  const noFont = T.buildApplyPlan({ font_body: "'Comic Papyrus', cursive" }, {});
  check('apply: an off-allowlist font is SKIPPED, page font left alone',
    noFont.writes.length === 0
    && noFont.skipped.some((s) => s.token === 'font_body' && s.reason === 'font_not_on_allowlist'));

  check('apply: empty token bag → no writes, no skips', (() => {
    const p = T.buildApplyPlan({}, {});
    return p.writes.length === 0 && p.skipped.length === 0 && p.changed_count === 0;
  })());
  check('apply: junk inputs do not throw', (() => {
    for (const bad of [null, undefined, 'str', 42, []]) {
      const p = T.buildApplyPlan(bad, bad);
      if (!p || !Array.isArray(p.writes)) return false;
    }
    return true;
  })());
}

// ════════════════════════════════════════════════════════════════════════════
// 5. END-TO-END THROUGH THE UNMODIFIED RENDERER
// ════════════════════════════════════════════════════════════════════════════
// The whole premise: a theme is a macro over existing settings, so the settings
// an apply produces must drive the REAL funnelSettingsHead with zero renderer
// changes. Anything the support map calls unsupported must be absent.
{
  const preset = T.getPreset('brand');
  const plan = T.buildApplyPlan(preset.tokens, {});
  const settings = T.applyPlanToSettings(plan, {});
  const head = funnelSettingsHead(settings);

  check('e2e: applied settings emit the theme primary as --brand-primary',
    head.includes('--brand-primary:#5FAE5F'), head.slice(0, 200));
  check('e2e: applied settings emit the theme secondary as --brand-secondary',
    head.includes('--brand-secondary:#7EB6A8'));
  check('e2e: applied settings emit the resolved page font + its Google link',
    head.includes("font-family:'Inter',system-ui,sans-serif") && head.includes('family=Inter:wght@400;600;700'),
    head.slice(0, 400));

  // Unsupported tokens must reach the page nowhere. Their literal values are a
  // precise probe: if any leaked into an emission we would see them verbatim.
  const leaked = ['#FBF8F2', '#1F1D1A', '#F3EFE7', '#E4DED2', '12px', 'Inter Tight']
    .filter((v) => head.includes(v));
  check('e2e: NOT ONE unsupported token value reaches the rendered head',
    leaked.length === 0, `leaked: ${JSON.stringify(leaked)}`);

  // The applied settings must not smuggle keys past validateFunnelSettings.
  const { validateFunnelSettings } = await import('../../src/routes/funnels.js');
  check('e2e: applied settings pass the funnels PATCH validator',
    validateFunnelSettings(settings) === null, String(validateFunnelSettings(settings)));

  // A preset whose font does not resolve must leave the font alone entirely.
  const ed = T.buildApplyPlan(T.getPreset('editorial').tokens, {});
  const edHead = funnelSettingsHead(T.applyPlanToSettings(ed, {}));
  check('e2e: a preset with an off-allowlist font emits NO font rule (no substitution)',
    !edHead.includes('lb-funnel-font') && edHead.includes('--brand-primary:#111827'), edHead.slice(0, 200));

  // Applying must not disturb neighbouring settings keys.
  const before = { checkout: { intl_phone: true }, custom_head_code: '<!--keep-->', logo_url: 'https://x/y.png' };
  const merged = T.applyPlanToSettings(T.buildApplyPlan(preset.tokens, before), before);
  check('e2e: apply preserves every unrelated settings key',
    merged.checkout.intl_phone === true && merged.custom_head_code === '<!--keep-->' && merged.logo_url === 'https://x/y.png');
  check('e2e: apply does not mutate the input settings object (pure)',
    before.brand_colors === undefined);

  // All 7 presets, straight through the renderer, must never throw or leak.
  let ok = 0;
  for (const p of T.listPresets()) {
    const h = funnelSettingsHead(T.applyPlanToSettings(T.buildApplyPlan(p.tokens, {}), {}));
    if (typeof h === 'string' && !h.includes('<script') && h.includes('--brand-primary')) ok++;
  }
  check('e2e: all 7 presets render a colors block and inject no script', ok === 7, `${ok}/7`);
}

// ════════════════════════════════════════════════════════════════════════════
// 6. IMPORT EXTRACTION — the reference's heuristics, quirks included
// ════════════════════════════════════════════════════════════════════════════
const FIXTURE = `<!doctype html><html><head>
<meta property="og:image" content="https://cdn.example.com/og.png">
<style>
  :root { --a: #5FAE5F; --b: #5fae5f; --c: #5FAE5F; }
  body { background: #ffffff; color: #0a0a0a; font-family: 'Inter', system-ui, sans-serif; }
  h1 { font-family: 'Inter', serif; }
  h2 { font-family: "Playfair Display", Georgia, serif; }
  .x { color: rgb(95, 174, 95); border: 1px solid rgba(200, 30, 30, 0.5); }
  .y { color: #fff; background: #abc; }
  .z { color: #12345678; outline: #ff; }
</style></head><body><p style="color:#0a0a0a">hi</p></body></html>`;

{
  const palette = T.extractPalette(FIXTURE);
  const asMap = Object.fromEntries(palette);
  check('extract: hex counted case-insensitively (#5FAE5F ×3 + rgb() ×1)',
    Object.prototype.hasOwnProperty.call(asMap, '#5fae5f'), JSON.stringify(palette.slice(0, 6)));

  // The reference merges the rgb tally OVER the hex tally rather than summing.
  // Porting that literally matters: it changes the ranking, and the ranking is
  // what picks `primary`.
  check('extract: rgb() count REPLACES the same-color hex count (reference quirk preserved)',
    asMap['#5fae5f'] === 1, `got ${asMap['#5fae5f']}`);
  check('extract: rgba() normalized to hex, alpha dropped', Object.prototype.hasOwnProperty.call(asMap, '#c81e1e'));
  check('extract: 8-digit hex (#12345678) dropped, not truncated',
    !palette.some(([c]) => c.startsWith('#123456')), JSON.stringify(palette));
  check('extract: 2-digit fragment (#ff) never counted', !palette.some(([c]) => c === '#ff'));
  check('extract: 3-hex expanded AFTER counting (#abc → #aabbcc)',
    palette.some(([c]) => c === '#aabbcc'), JSON.stringify(palette));
  check('extract: sorted by count descending',
    palette.every((p, i) => i === 0 || palette[i - 1][1] >= p[1]));

  const fonts = T.extractFonts(FIXTURE);
  check('extract: only the FIRST family of each declaration is kept',
    fonts.every(([f]) => !f.includes(',')) && fonts.some(([f]) => f === 'Inter'), JSON.stringify(fonts));
  check('extract: most-frequent family ranks first (Inter ×2)', fonts[0][0] === 'Inter' && fonts[0][1] === 2, JSON.stringify(fonts));
  check('extract: quotes stripped, double-quoted family kept',
    fonts.some(([f]) => f === 'Playfair Display'), JSON.stringify(fonts));
}

{
  const draft = T.buildDraftFromHtml(FIXTURE, 'https://www.example.com/pricing');
  check('draft: name is "From <netloc minus www>"', draft.name === 'From example.com', draft.name);
  check('draft: primary skips near-white and near-black', draft.tokens.primary === '#5fae5f', draft.tokens.primary);
  // #abc is expanded to #aabbcc only AFTER counting, and #aabbcc (170,187,204)
  // passes both mid-tone predicates — so it outranks the rgba()-derived
  // #c81e1e, which was appended to the tally later at the same count of 1.
  // Ranking is frequency-then-first-seen, exactly as the reference does it.
  check('draft: secondary is the next mid-tone by frequency-then-first-seen',
    draft.tokens.secondary !== draft.tokens.primary && draft.tokens.secondary === '#aabbcc', draft.tokens.secondary);
  check('draft: background is the most-frequent near-white', draft.tokens.background === '#ffffff');
  check('draft: foreground is the most-frequent near-black', draft.tokens.foreground === '#0a0a0a');
  check('draft: light background selects the light muted/border pair',
    draft.tokens.muted === '#f3f4f6' && draft.tokens.border === '#e5e7eb');
  check('draft: radius is always 12px (reference hardcodes it)', draft.tokens.radius === '12px');
  check('draft: one extracted font drives BOTH heading and body',
    draft.tokens.font_heading === "'Inter', system-ui, sans-serif" && draft.tokens.font_body === draft.tokens.font_heading);
  check('draft: cta mirrors primary with a white foreground',
    draft.tokens.cta_bg === draft.tokens.primary && draft.tokens.cta_fg === '#ffffff');
  check('draft: og:image captured as the preview', draft.preview_url === 'https://cdn.example.com/og.png');
  check('draft: palette_full capped at 12, fonts_full at 6',
    draft.palette_full.length <= 12 && draft.fonts_full.length <= 6);
  check('draft: carries all 11 tokens', T.TOKEN_KEYS.every((k) => typeof draft.tokens[k] === 'string' && draft.tokens[k]));
  check('draft: imported_from recorded', draft.imported_from === 'https://www.example.com/pricing');

  // The draft's own font is extracted from the page, so it must survive the
  // apply resolution — otherwise import produces a theme that changes nothing.
  const dplan = T.buildApplyPlan(draft.tokens, {});
  check('draft: the extracted font resolves through the apply macro',
    dplan.writes.some((w) => w.path === 'fonts.family' && w.to === 'inter'), JSON.stringify(dplan.writes));
}

// ── extraction edge cases: empty, hostile, binary ──────────────────────────
{
  const empty = T.buildDraftFromHtml('', 'https://nothing.example');
  check('draft: empty HTML falls back to the reference defaults',
    empty.tokens.primary === '#7c3aed' && empty.tokens.secondary === '#06b6d4'
    && empty.tokens.background === '#ffffff' && empty.tokens.foreground === '#0a0a0a',
    JSON.stringify(empty.tokens));
  check('draft: empty HTML → system-ui font, dark muted pair NOT chosen (bg is near-white)',
    empty.tokens.font_body === "'system-ui', system-ui, sans-serif" && empty.tokens.muted === '#f3f4f6');
  check('draft: no og:image → empty preview', empty.preview_url === '');

  check('draft: non-string HTML does not throw', (() => {
    for (const bad of [null, undefined, 42, {}, []]) {
      const d = T.buildDraftFromHtml(bad, 'https://x.example');
      if (!d || !d.tokens || typeof d.tokens.primary !== 'string') return false;
    }
    return true;
  })());
  check('draft: malformed URL does not throw and yields a usable name', (() => {
    const d = T.buildDraftFromHtml('<p>x</p>', 'not a url');
    return d.name === 'From Imported Theme' && d.imported_from === '';
  })());

  // A page whose only colors are near-white/near-black must not promote one of
  // them to `primary` — the fallback exists for exactly this.
  const mono = T.buildDraftFromHtml('<style>a{color:#ffffff}b{color:#000000}</style>', 'https://m.example');
  check('draft: an all-mono page falls back rather than promoting white to primary',
    mono.tokens.primary === '#7c3aed' && mono.tokens.background === '#ffffff' && mono.tokens.foreground === '#000000',
    JSON.stringify(mono.tokens));

  // FINDING (reference dead code, ported faithfully): the dark muted/border
  // branch is UNREACHABLE. `background` is chosen as the first near-white in
  // the palette, and its fallback when there is no near-white is #ffffff —
  // which is itself near-white. So is_near_white(bg) is a tautology, and
  // muted/border are constants. Proven here over a corpus that includes an
  // all-dark page, which still takes the light branch.
  const corpus = [
    '<style>body{background:#0b1220;color:#7BC279}</style>',   // all dark
    '<style>a{color:#000000}</style>',                          // all black
    '<style>a{color:#5FAE5F}</style>',                          // one mid-tone
    '',                                                          // nothing
    '<style>a{color:#ffffff;background:#fafafa}</style>',        // all light
  ];
  const drafts = corpus.map((h) => T.buildDraftFromHtml(h, 'https://d.example'));
  check('draft: background is ALWAYS near-white (palette filter and fallback both are)',
    drafts.every((d) => T.isNearWhite(d.tokens.background)),
    JSON.stringify(drafts.map((d) => d.tokens.background)));
  check('draft: therefore muted/border are constants — the dark branch is unreachable',
    drafts.every((d) => d.tokens.muted === '#f3f4f6' && d.tokens.border === '#e5e7eb'),
    JSON.stringify(drafts.map((d) => [d.tokens.muted, d.tokens.border])));
  // Harmless because both tokens are unsupported: neither reaches a page, so
  // the dead branch has no rendered consequence to diverge from.
  check('draft: muted/border are unsupported tokens, so the dead branch changes nothing rendered',
    T.TOKEN_SUPPORT.muted.support === 'none' && T.TOKEN_SUPPORT.border.support === 'none');

  // An extracted font name is quoted into a CSS stack — it must not be able to
  // break out. The apply resolves to an allowlist key anyway, but the token is
  // stored and shown, so a hostile family must stay inert.
  const eviln = T.buildDraftFromHtml("<style>a{font-family:X'; } body{x:y} .z{a:'b;}</style>", 'https://e.example');
  const evilPlan = T.buildApplyPlan(eviln.tokens, {});
  check('draft: a hostile font family resolves to NO font write (cannot reach the page)',
    !evilPlan.writes.some((w) => w.path === 'fonts.family'), JSON.stringify(eviln.tokens.font_body));
}

// ════════════════════════════════════════════════════════════════════════════
// 7. ROUTE — auth, CRUD, jsonb discipline
// ════════════════════════════════════════════════════════════════════════════
{
  const r = await req('GET', '/presets', undefined, { 'Content-Type': 'application/json' });
  check('route: no token → 401', r.status === 401, JSON.stringify(r));
}
{
  const r = await req('GET', '/presets');
  check('route: GET /presets → 7 presets + the token support map',
    r.status === 200 && r.j.data.presets.length === 7
    && r.j.data.token_keys.length === 11
    && Object.keys(r.j.data.token_support).length === 11,
    JSON.stringify(r).slice(0, 250));
  check('route: /presets support map marks 8 tokens unsupported',
    Object.values(r.j.data.token_support).filter((s) => s.support === 'none').length === 8);
}

let createdId = null;
{
  const r = await req('POST', '/', { name: '  My Theme  ', tokens: T.getPreset('tech').tokens, imported_from: 'https://src.example/x' });
  check('route: POST / → 201 with a thm_ id', r.status === 201 && /^thm_[0-9a-f]{10}$/.test(r.j.data.theme.id), JSON.stringify(r).slice(0, 250));
  createdId = r.j.data.theme.id;
  check('route: name trimmed', r.j.data.theme.name === 'My Theme', r.j.data.theme.name);
  check('route: tokens round-trip intact (all 11)',
    T.TOKEN_KEYS.every((k) => r.j.data.theme.tokens[k] === T.getPreset('tech').tokens[k]),
    JSON.stringify(r.j.data.theme.tokens));

  // THE jsonb DISCIPLINE CHECK. A bare `$N::jsonb` would store a jsonb STRING;
  // jsonb_typeof answers 'string' and tokens->>'primary' reads NULL forever.
  const [row] = await sql`SELECT jsonb_typeof(tokens) AS t, tokens->>'primary' AS p FROM lb_funnel_themes WHERE id = ${createdId}`;
  check('route: tokens stored as a jsonb OBJECT, not a jsonb string', row.t === 'object', row.t);
  check('route: tokens->>\'primary\' is readable in SQL', row.p === '#7BC279', String(row.p));
}
{
  const r = await req('POST', '/', { name: '', tokens: {} });
  check('route: blank name falls back to "Untitled theme"', r.status === 201 && r.j.data.theme.name === 'Untitled theme');
  check('route: empty token bag is allowed (a theme can be built up later)', r.j.data.theme.tokens && Object.keys(r.j.data.theme.tokens).length === 0);
  await req('DELETE', `/${r.j.data.theme.id}`);
}
{
  const r = await req('POST', '/', { name: 'x', tokens: { primary: 123 } });
  check('route: a non-string token → 422', r.status === 422 && r.j.error.code === 'token_not_string:primary', JSON.stringify(r));
  const r2 = await req('POST', '/', { name: 'x', tokens: 'nope' });
  check('route: non-object tokens → 422', r2.status === 422 && r2.j.error.code === 'tokens_must_be_object', JSON.stringify(r2));
  const r3 = await req('POST', '/', { name: 'x', tokens: { primary: 'y'.repeat(300) } });
  check('route: an over-long token → 422', r3.status === 422 && r3.j.error.code === 'token_too_long:primary', JSON.stringify(r3));
  const r4 = await req('POST', '/', { name: 'x', tokens: { primary: '#fff', bogus_key: 'v', palette_full: 'x' } });
  check('route: unknown token keys are DROPPED, not refused (import drafts round-trip)',
    r4.status === 201 && r4.j.data.theme.tokens.bogus_key === undefined && r4.j.data.theme.tokens.primary === '#fff',
    JSON.stringify(r4).slice(0, 200));
  await req('DELETE', `/${r4.j.data.theme.id}`);
}
{
  const r = await req('GET', '/');
  check('route: GET / lists the saved theme', r.status === 200 && r.j.data.themes.some((t) => t.id === createdId));
  check('route: listed themes are never flagged is_preset', r.j.data.themes.every((t) => t.is_preset === false));
}
{
  const r = await req('PATCH', `/${createdId}`, { name: 'Renamed' });
  check('route: PATCH renames', r.status === 200 && r.j.data.theme.name === 'Renamed');
  check('route: PATCH is PARTIAL — a rename does not wipe tokens (reference bug not ported)',
    Object.keys(r.j.data.theme.tokens).length === 11, JSON.stringify(r.j.data.theme.tokens));
  const r2 = await req('PATCH', '/thm_nope000000', { name: 'x' });
  check('route: PATCH unknown id → 404', r2.status === 404 && r2.j.error.code === 'theme_not_found', JSON.stringify(r2));
}

// ── apply-plan over the wire ───────────────────────────────────────────────
await sql`CREATE TABLE IF NOT EXISTS funnels (
  id TEXT PRIMARY KEY, slug TEXT, name TEXT, status TEXT DEFAULT 'draft',
  settings JSONB DEFAULT '{}'::jsonb
)`;
await sql`ALTER TABLE funnels ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb`;
await sql`INSERT INTO funnels (id, slug, name) VALUES ('fnl_thm_test', 'thm-test', 'Theme Test')
          ON CONFLICT (id) DO UPDATE SET settings = '{}'::jsonb`;
await sql`UPDATE funnels SET settings = ${sql.json({ brand_colors: { primary: '#123456' }, logo_url: 'https://x/y.png' })} WHERE id = 'fnl_thm_test'`;
{
  const r = await req('POST', '/apply-plan', { funnel_id: 'fnl_thm_test', preset_slug: 'brand' });
  check('route: apply-plan resolves a preset', r.status === 200 && r.j.data.source.kind === 'preset', JSON.stringify(r).slice(0, 200));
  check('route: apply-plan reports the destructive overwrite of the hand-tuned color',
    r.j.data.plan.overwrites.some((o) => o.path === 'brand_colors.primary' && o.from === '#123456' && o.to === '#5FAE5F'),
    JSON.stringify(r.j.data.plan.overwrites));
  check('route: apply-plan reports the 8 unsupported tokens', r.j.data.plan.skipped.length === 8);

  const r2 = await req('POST', '/apply-plan', { funnel_id: 'fnl_thm_test', theme_id: createdId });
  check('route: apply-plan resolves a saved theme', r2.status === 200 && r2.j.data.source.kind === 'theme');

  const r3 = await req('POST', '/apply-plan', { funnel_id: 'fnl_thm_test', theme_id: 'thm_gone000000' });
  check('route: apply-plan on a MISSING theme 404s — it never falls through to a preset',
    r3.status === 404 && r3.j.error.code === 'theme_not_found', JSON.stringify(r3));

  const r4 = await req('POST', '/apply-plan', { funnel_id: 'fnl_nope', preset_slug: 'brand' });
  check('route: apply-plan on an unknown funnel → 404', r4.status === 404 && r4.j.error.code === 'funnel_not_found');

  const r5 = await req('POST', '/apply-plan', { funnel_id: 'fnl_thm_test' });
  check('route: apply-plan with no source → 422', r5.status === 422, JSON.stringify(r5));

  const r6 = await req('POST', '/apply-plan', { preset_slug: 'brand' });
  check('route: apply-plan with no funnel_id → 422', r6.status === 422 && r6.j.error.code === 'funnel_id_required');

  const r7 = await req('POST', '/apply-plan', { funnel_id: 'fnl_thm_test', tokens: { primary: '#010203' } });
  check('route: apply-plan accepts a raw draft token bag', r7.status === 200 && r7.j.data.source.kind === 'draft'
    && r7.j.data.plan.writes.some((w) => w.to === '#010203'));

  // apply-plan must WRITE NOTHING — the client owns the commit.
  const [f] = await sql`SELECT settings FROM funnels WHERE id = 'fnl_thm_test'`;
  check('route: apply-plan is READ-ONLY — funnel settings untouched',
    f.settings.brand_colors.primary === '#123456' && f.settings.logo_url === 'https://x/y.png',
    JSON.stringify(f.settings));
}

// ════════════════════════════════════════════════════════════════════════════
// 8. IMPORT-URL — SSRF refusals
// ════════════════════════════════════════════════════════════════════════════
{
  const hostile = [
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata over http'],
    ['https://169.254.169.254/latest/meta-data/', 'cloud metadata over https'],
    ['http://127.0.0.1:5433/', 'loopback'],
    ['https://127.0.0.1/', 'loopback https'],
    ['https://10.0.0.5/admin', 'private 10/8'],
    ['https://192.168.1.1/', 'private 192.168/16'],
    ['https://172.16.0.1/', 'private 172.16/12'],
    ['https://[::1]/', 'IPv6 loopback'],
    ['https://[::ffff:169.254.169.254]/', 'IPv4-mapped IPv6 metadata'],
    ['https://[64:ff9b::a9fe:a9fe]/', 'NAT64 well-known prefix → 169.254.169.254 (M5)'],
    ['https://[2002:a9fe:a9fe::]/', '6to4 → 169.254.169.254 (M5)'],
    ['https://[fd00::1]/', 'IPv6 unique-local'],
    ['https://100.64.0.1/', 'CGNAT 100.64/10'],
    ['https://localhost/', 'localhost by name'],
    ['https://metadata.google.internal/', 'GCP metadata by name'],
    ['file:///etc/passwd', 'file scheme'],
    ['gopher://127.0.0.1/', 'gopher scheme'],
    ['ftp://example.com/', 'ftp scheme'],
    ['http://example.com/', 'plaintext http to a public host'],
    ['not a url at all', 'unparseable'],
  ];
  let refused = 0;
  const leaked = [];
  for (const [url, label] of hostile) {
    const r = await req('POST', '/import-url', { url });
    if (r.status === 422 && r.j && r.j.error && r.j.error.code === 'url_not_allowed') refused++;
    else leaked.push(`${label} → ${r.status} ${JSON.stringify(r.j)}`);
  }
  check(`ssrf: all ${hostile.length} hostile targets refused with one fixed code`,
    refused === hostile.length, leaked.join(' | '));

  // The refusal must not disclose WHY — ECONNREFUSED vs EHOSTUNREACH vs a
  // timeout is an internal-network map. The reference returns str(exc).
  const r = await req('POST', '/import-url', { url: 'https://10.0.0.5/admin' });
  const bodyStr = JSON.stringify(r.j);
  check('ssrf: the refusal leaks no host, IP, or connection-error detail',
    !/10\.0\.0\.5|ECONN|EHOSTUNREACH|EAI_|getaddrinfo|dns/i.test(bodyStr), bodyStr);

  const r2 = await req('POST', '/import-url', { url: '' });
  check('ssrf: a blank url → 422 url_required', r2.status === 422 && r2.j.error.code === 'url_required');

  // A bare host must be upgraded to https, never http — the reference's
  // `if not startswith(("http://","https://"))` prepends https too, but then
  // still accepts an explicit http:// URL, which we refuse above.
  const r3 = await req('POST', '/import-url', { url: '169.254.169.254' });
  check('ssrf: a bare hostile host is https-upgraded and still refused',
    r3.status === 422 && r3.j.error.code === 'url_not_allowed', JSON.stringify(r3));
}

// ── import-url happy path against a local fixture server ───────────────────
// The guard refuses loopback by design, so the route cannot be exercised
// end-to-end against a local server. The fetch+parse half is proven by driving
// buildDraftFromHtml over the SAME bytes the server would have returned, and
// safeFetchHtml's own read/redirect behavior is proven in the guard section
// below with an injected resolver.
{
  const fx = express();
  fx.get('/p', (_q, s) => s.type('html').send(FIXTURE));
  const fxServer = fx.listen(0);
  const fxPort = fxServer.address().port;
  const resp = await fetch(`http://127.0.0.1:${fxPort}/p`);
  const body = await resp.text();
  const draft = T.buildDraftFromHtml(body, `https://fixture.example/p`);
  check('import: a real HTTP body parses into a complete draft',
    draft.tokens.primary === '#5fae5f' && draft.palette_full.length > 0 && draft.fonts_full.includes('Inter'),
    JSON.stringify(draft.tokens));
  fxServer.close();
}

// ── delete last ────────────────────────────────────────────────────────────
{
  const r = await req('DELETE', `/${createdId}`);
  check('route: DELETE soft-archives', r.status === 200 && r.j.data.id === createdId, JSON.stringify(r));
  const r2 = await req('GET', '/');
  check('route: archived theme leaves the list', !r2.j.data.themes.some((t) => t.id === createdId));
  const r3 = await req('DELETE', `/${createdId}`);
  check('route: a second DELETE → 404 (not a silent ok, unlike the reference)',
    r3.status === 404 && r3.j.error.code === 'theme_not_found', JSON.stringify(r3));
  const [row] = await sql`SELECT archived FROM lb_funnel_themes WHERE id = ${createdId}`;
  check('route: the row survives as archived (provenance kept)', row && row.archived === true);
}

// ════════════════════════════════════════════════════════════════════════════
// 9. SSRF GUARD (B1 + M5) — resolve once, classify, pin. Under production.
// ════════════════════════════════════════════════════════════════════════════
// The guard reads NODE_ENV nowhere — it has NO dev hatch, unlike the tracking
// lane's endpointAllowed — so its verdicts are identical in dev and prod. We
// assert that explicitly by running the whole block with NODE_ENV='production'.
// (The DB pool was created at import under 'development'; flipping the env now
// only affects code that reads it live, and the guard doesn't.)
{
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  // ── classifyAddress — every reserved range, both families ──
  const publicAddrs = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];
  const privateAddrs = [
    '0.0.0.0', '10.0.0.5', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '100.64.0.1', '100.127.255.255', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe',           // NAT64 → 169.254.169.254 (M5)
    '64:ff9b::7f00:1',              // NAT64 → 127.0.0.1 (M5)
    '2002:a9fe:a9fe::',            // 6to4 → 169.254.169.254 (M5)
    '2002:7f00:1::',              // 6to4 → 127.0.0.1 (M5)
    '2002:0a00:0001::',           // 6to4 → 10.0.0.1 (M5)
  ];
  check('guard: every public literal classifies public (prod)',
    publicAddrs.every((a) => G.classifyAddress(a).public === true),
    publicAddrs.filter((a) => !G.classifyAddress(a).public).join(','));
  check('guard: every reserved/private/tunnel literal classifies private (prod)',
    privateAddrs.every((a) => G.classifyAddress(a).public === false),
    privateAddrs.filter((a) => G.classifyAddress(a).public).join(','));

  // The two IPv6 literals the reviewer named explicitly.
  check('guard: NAT64 [64:ff9b::a9fe:a9fe] refused (M5)', G.classifyAddress('64:ff9b::a9fe:a9fe').public === false);
  check('guard: 6to4 [2002:a9fe:a9fe::] refused (M5)', G.classifyAddress('2002:a9fe:a9fe::').public === false);
  // A genuinely public 6to4-encoded v4 must still pass (the gate is on the
  // EMBEDDED address, not a blanket 2002:: ban).
  check('guard: 6to4 wrapping a PUBLIC v4 (2002:0808:0808::) stays public',
    G.classifyAddress('2002:0808:0808::').public === true);
  check('guard: junk is not public', !G.classifyAddress('nope').public && !G.classifyAddress('').public);

  // ── assessHostname — single resolution, strict, pinned ──
  {
    const a = await G.assessHostname('8.8.8.8', {});
    check('guard: a public literal host is allowed and pins itself', a.allowed && a.pinnedIp === '8.8.8.8');
    const b = await G.assessHostname('10.0.0.5', {});
    check('guard: a private literal host is refused', b.allowed === false);
  }
  {
    // REBINDING PROBE. A resolver that answers PUBLIC first then LOOPBACK.
    // assessHostname resolves EXACTLY ONCE and pins that answer — the second
    // (poisoned) answer is never consulted, so there is no TOCTOU window.
    let calls = 0;
    const rebinder = async () => { calls += 1; return calls === 1 ? [{ address: '1.2.3.4', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; };
    const a = await G.assessHostname('rebind.evil.test', { resolve: rebinder });
    check('guard: rebinding — resolves once, pins the first (public) answer',
      a.allowed && a.pinnedIp === '1.2.3.4' && calls === 1, JSON.stringify({ a, calls }));
  }
  {
    // The reviewer's exact scenario collapsed into one resolution: the address
    // the socket WOULD connect to is loopback → refused, no connection made.
    const toLoopback = async () => [{ address: '127.0.0.1', family: 4 }];
    const a = await G.assessHostname('sneaky.test', { resolve: toLoopback });
    check('guard: a host that resolves to loopback is REFUSED (connect never happens)', a.allowed === false);
  }
  {
    // STRICT set: a mixed public+private answer is a rebinding setup → refused.
    const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
    const a = await G.assessHostname('mixed.test', { resolve: mixed });
    check('guard: a mixed public+private answer set is refused whole', a.allowed === false);
  }
  {
    const failing = async () => { throw new Error('ENOTFOUND'); };
    const a = await G.assessHostname('nx.test', { resolve: failing });
    check('guard: a resolution failure fails CLOSED', a.allowed === false && a.reason === 'dns');
    const empty = async () => [];
    const b = await G.assessHostname('empty.test', { resolve: empty });
    check('guard: an empty answer set fails closed', b.allowed === false);
  }

  // ── safeFetchHtml — scheme + pinned-private refusal, no socket ──
  {
    let threw = null;
    try { await G.safeFetchHtml('http://example.com/', { resolve: async () => [{ address: '8.8.8.8', family: 4 }] }); }
    catch (e) { threw = e; }
    check('guard: safeFetchHtml refuses http:// by scheme', threw instanceof G.ImportGuardError && threw.code === 'scheme');
  }
  {
    let threw = null;
    // Resolves to loopback → the pin is loopback → blocked before any connect.
    try { await G.safeFetchHtml('https://sneaky.test/', { resolve: async () => [{ address: '127.0.0.1', family: 4 }] }); }
    catch (e) { threw = e; }
    check('guard: safeFetchHtml blocks a host that would connect to loopback',
      threw instanceof G.ImportGuardError && threw.code === 'blocked', String(threw && threw.code));
  }
  {
    let threw = null;
    try { await G.safeFetchHtml('https://[64:ff9b::a9fe:a9fe]/', {}); }
    catch (e) { threw = e; }
    check('guard: safeFetchHtml blocks a NAT64 literal target', threw instanceof G.ImportGuardError && threw.code === 'blocked');
  }

  process.env.NODE_ENV = prevEnv;
}

// ════════════════════════════════════════════════════════════════════════════
// 10. IMPORT-URL RATE LIMIT (M2)
// ════════════════════════════════════════════════════════════════════════════
{
  const prev = themesMod._hooks.checkRateLimit;
  themesMod._hooks.checkRateLimit = async () => ({ allowed: false, remaining: 0, retryAfter: 42 });
  const r = await req('POST', '/import-url', { url: 'https://example.com' });
  check('rate: import-url over the cap → 429 rate_limited', r.status === 429 && r.j.error.code === 'rate_limited', JSON.stringify(r));
  themesMod._hooks.checkRateLimit = prev; // restore the allow-stub
}

// ════════════════════════════════════════════════════════════════════════════
// 11. FONT EXTRACTION — perf (M2) + trailing-`;`-free (M3) + boundaries (m5)
// ════════════════════════════════════════════════════════════════════════════
{
  // M2 PERF. The reference's `([^;]+?);` regex is catastrophic on a semicolon-
  // free 2MB paste (~9s). The linear scanner must complete well under budget.
  const bomb = 'font-family:' + 'a'.repeat(2 * 1024 * 1024); // no ';', '}', or '<'
  const t0 = process.hrtime.bigint();
  const fonts = T.extractFonts(bomb);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check(`perf: 2MB semicolon-free font input completes under 200ms (${ms.toFixed(1)}ms)`, ms < 200, `${ms}ms`);
  // The declaration read is capped at 200 chars, so the 2MB family is bounded;
  // 200 chars then exceeds the 50-char family-name limit, so it is dropped —
  // no giant string is ever emitted, and every emitted family is <= 50 chars.
  check('perf: the capped read never emits a giant family (all <= 50 chars)',
    fonts.every(([f]) => f.length <= 50), JSON.stringify(fonts).slice(0, 80));

  // Also prove the FULL palette+font extraction of a 2MB body is fast (the
  // route parses whatever comes back).
  const big = '<style>' + 'a{color:#5FAE5F}'.repeat(120000) + '</style>';
  const t1 = process.hrtime.bigint();
  T.extractPalette(big); T.extractFonts(big);
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
  check(`perf: extracting a ${(big.length / 1e6).toFixed(1)}MB body completes under 500ms (${ms2.toFixed(1)}ms)`, ms2 < 500, `${ms2}ms`);

  // M3 — no trailing semicolon required. Minified + inline CSS must yield fonts.
  check('m3: minified rule with no trailing ; extracts the family',
    T.extractFonts('h1{font-family:Inter}').some(([f]) => f === 'Inter'));
  check('m3: inline style attribute (no ;) extracts the family',
    T.extractFonts('<div style="font-family:Poppins">x</div>').some(([f]) => f === 'Poppins'));
  check('m3: quoted family in an inline attribute is clean (no trailing quote junk)',
    T.extractFonts(`<div style="font-family:'Open Sans', sans-serif">x</div>`).some(([f]) => f === 'Open Sans'));
  check('m3: minified multi-rule counts each occurrence',
    (() => { const f = Object.fromEntries(T.extractFonts('a{font-family:Inter}b{font-family:Inter}c{font-family:Lato}')); return f.Inter === 2 && f.Lato === 1; })());

  // m5 — the read stops at the rule boundary `}` and never bleeds the next rule.
  check('m5: a family read stops at } and does not swallow the next selector',
    T.extractFonts('a{font-family:Inter}b{color:red}').every(([f]) => f === 'Inter'));
  check('m5: a boundary-terminated unquoted family drops trailing markup',
    T.extractFonts('<span style="font-family:Merriweather">').some(([f]) => f === 'Merriweather'));
}

// ════════════════════════════════════════════════════════════════════════════
// 12. HONEST PER-VALUE SUPPORT (M4) — plan_preview on every list row
// ════════════════════════════════════════════════════════════════════════════
{
  const r = await req('GET', '/presets');
  const byslug = Object.fromEntries(r.j.data.presets.map((p) => [p.preset_slug, p]));
  check('M4: every preset carries a plan_preview', r.j.data.presets.every((p) => p.plan_preview && Array.isArray(p.plan_preview.writes)));

  // brand's font (Inter) resolves → 3 writes; editorial's serif font does NOT
  // resolve → only 2 writes. The static per-key map would over-claim editorial
  // as 3; the per-value preview is the honest answer.
  check('M4: brand resolves 3 tokens (2 colors + font)', byslug.brand.plan_preview.writes.length === 3, JSON.stringify(byslug.brand.plan_preview.writes.map((w) => w.token)));
  check('M4: editorial resolves only 2 (its serif font is not on the allowlist)',
    byslug.editorial.plan_preview.writes.length === 2
    && byslug.editorial.plan_preview.writes.every((w) => w.token !== 'font_body'),
    JSON.stringify(byslug.editorial.plan_preview.writes.map((w) => w.token)));
  check('M4: editorial-dark also resolves only 2 (serif font unsupported)',
    byslug['editorial-dark'].plan_preview.writes.length === 2);
  check('M4: no write is ever labelled a plain green "Applied" for a color — colors are "variable"',
    r.j.data.presets.every((p) => p.plan_preview.writes.filter((w) => w.path.startsWith('brand_colors')).every((w) => w.support === 'variable')));

  // A saved theme also gets a per-value preview.
  const cr = await req('POST', '/', { name: 'Preview Me', tokens: T.getPreset('tech').tokens });
  check('M4: a saved theme row carries plan_preview too', cr.j.data.theme.plan_preview && cr.j.data.theme.plan_preview.writes.length === 3);
  await req('DELETE', `/${cr.j.data.theme.id}`);
}

// ── m3: non-string PATCH/POST name → 422 (not a silent Untitled 200) ───────
{
  const cr = await req('POST', '/', { name: 'Rename Target', tokens: {} });
  const id = cr.j.data.theme.id;
  const r = await req('PATCH', `/${id}`, { name: { evil: 1 } });
  check('m3: non-string PATCH name → 422', r.status === 422 && r.j.error.code === 'name_must_be_string', JSON.stringify(r));
  const r2 = await req('POST', '/', { name: 123, tokens: {} });
  check('m3: non-string POST name → 422', r2.status === 422 && r2.j.error.code === 'name_must_be_string', JSON.stringify(r2));
  // A missing name is still fine (partial PATCH).
  const r3 = await req('PATCH', `/${id}`, { preview_url: 'https://x/y.png' });
  check('m3: an omitted name still allows a partial PATCH', r3.status === 200);
  await req('DELETE', `/${id}`);
}

// ── m2: GET / truncation signal ────────────────────────────────────────────
{
  const r = await req('GET', '/');
  check('m2: GET / reports a truncated flag (false at low counts)',
    r.status === 200 && r.j.data.truncated === false, JSON.stringify(r.j.data.truncated));
}

// ════════════════════════════════════════════════════════════════════════════
// 13. STALE-PLAN GUARD (M1) — the pure client helper, executed
// ════════════════════════════════════════════════════════════════════════════
// recomputeDiff is what runs at COMMIT inside saveFunnelPatch. It re-derives the
// overwrite set against the FRESH row, so a plan minted against an older
// snapshot is caught before the PATCH lands.
{
  const writes = T.buildApplyPlan(T.getPreset('brand').tokens, {}).writes; // 3 writes: primary, secondary, font
  check('M1: writes carry the three live paths',
    writes.map((w) => w.path).sort().join(',') === 'brand_colors.primary,brand_colors.secondary,fonts.family');

  // Plan minted when the funnel had NO colors → zero overwrites shown.
  const planTime = PLAN.recomputeDiff(writes, {});
  check('M1: at plan time (empty settings) there are no overwrites', planTime.overwrites.length === 0 && planTime.changed_count === 3);

  // The reviewer's exact bug: an interim tab sets #00FF00 after the preview.
  // Recomputing against the fresh row surfaces the destructive overwrite that
  // the stale dialog never showed.
  const fresh = PLAN.recomputeDiff(writes, { brand_colors: { primary: '#00FF00' } });
  check('M1: recompute against the FRESH row surfaces the interim #00FF00 as a destroyed value',
    fresh.overwrites.some((o) => o.path === 'brand_colors.primary' && o.from === '#00FF00' && o.to === '#5FAE5F'),
    JSON.stringify(fresh.overwrites));
  check('M1: the signatures differ, so the commit path detects the stale plan and re-confirms',
    PLAN.overwriteSignature(planTime.overwrites) !== PLAN.overwriteSignature(fresh.overwrites));

  // The reviewer's other case: dialog said #123456→ but the row now holds a
  // different value; the true "from" is the fresh one, never the stale one.
  const staleShown = PLAN.recomputeDiff(writes, { brand_colors: { primary: '#123456' } });
  const nowHolds = PLAN.recomputeDiff(writes, { brand_colors: { primary: '#654321' } });
  check('M1: the recomputed "from" is the fresh value, never the plan-time one',
    nowHolds.overwrites.find((o) => o.path === 'brand_colors.primary').from === '#654321'
    && PLAN.overwriteSignature(staleShown.overwrites) !== PLAN.overwriteSignature(nowHolds.overwrites));

  // Re-applying the very same values is idempotent — signatures match → commit
  // proceeds without a false "stale" bounce.
  const applied = PLAN.applyWrites({}, writes);
  const reDiff = PLAN.recomputeDiff(writes, applied);
  check('M1: re-applying identical values is NOT flagged stale (signatures match)',
    PLAN.overwriteSignature(reDiff.overwrites) === PLAN.overwriteSignature(reDiff.overwrites)
    && reDiff.overwrites.length === 0 && reDiff.changed_count === 0);

  // colors compare case-insensitively, matching the server; the font sentinel
  // 'default' is a fill, not an overwrite.
  const ci = PLAN.recomputeDiff(writes, { brand_colors: { primary: '#5fae5f' }, fonts: { family: 'default' } });
  check('M1: a case-different same color is not a change; fonts "default" is a fill not an overwrite',
    !ci.overwrites.some((o) => o.path === 'brand_colors.primary')
    && !ci.overwrites.some((o) => o.path === 'fonts.family'), JSON.stringify(ci.overwrites));

  // applyWrites is pure and merges without disturbing neighbours.
  const before = { logo_url: 'https://x/y.png', brand_colors: { secondary: '#111111' } };
  const after = PLAN.applyWrites(before, writes);
  check('M1: applyWrites merges the paths and preserves unrelated keys, without mutating input',
    after.logo_url === 'https://x/y.png' && after.brand_colors.primary === '#5FAE5F'
    && after.fonts.family === 'inter' && before.fonts === undefined);
}

// ── cleanup ────────────────────────────────────────────────────────────────
await sql`DELETE FROM lb_funnel_themes WHERE workspace_id = 'default'`;
await sql`DELETE FROM funnels WHERE id = 'fnl_thm_test'`;
server.close();
await sql.end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
