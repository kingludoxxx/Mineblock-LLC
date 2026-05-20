import { chromium } from 'playwright';

const PREFIX = '[playwrightRenderer]';

/**
 * Parse claudeResult.adapted_text into structured fields.
 * adapted_text may be a plain object or a JSON string.
 */
function parseAdaptedText(claudeResult) {
  let raw = claudeResult?.adapted_text;

  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      // not JSON — treat the whole string as body copy
      raw = { body: raw };
    }
  }

  if (!raw || typeof raw !== 'object') raw = {};

  // Normalise bullets: may be array or newline-delimited string
  let bullets = raw.bullets ?? raw.bullet ?? [];
  if (typeof bullets === 'string') {
    bullets = bullets.split('\n').map(b => b.trim()).filter(Boolean);
  }
  if (!Array.isArray(bullets)) bullets = [];

  // Normalise badges: may be array or string
  let badges = raw.badges ?? raw.badge ?? [];
  if (typeof badges === 'string') {
    badges = badges.split('\n').map(b => b.trim()).filter(Boolean);
  }
  if (!Array.isArray(badges)) badges = [];

  return {
    headline:     (raw.headline     ?? '').trim(),
    subheadline:  (raw.subheadline  ?? raw.sub_headline ?? '').trim(),
    body:         (raw.body         ?? raw.body_copy ?? '').trim(),
    bullets,
    badges,
    cta:          (raw.cta          ?? raw.cta_text ?? '').trim(),
  };
}

/**
 * Build an HTML document string styled as a clean white document ad.
 */
function buildHtml(fields, product, dims) {
  const { headline, subheadline, body, bullets, badges, cta } = fields;
  const productName = product?.name ?? 'Product';

  const displayHeadline    = headline    || productName;
  const displaySubheadline = subheadline || '';
  const displayBody        = body        || '';
  const displayCta         = cta         || '';

  // Scale font sizes relative to image width (base 1080px)
  const scale = dims.width / 1080;

  // Aspect ratio: portrait formats (4:5, 9:16) get tighter fonts + more line-height
  // so the same body copy fills the taller frame naturally instead of leaving blank space.
  const aspectRatio = dims.height / dims.width; // 1:1→1.0, 4:5→1.25, 9:16→1.78
  // Compress fonts slightly for tall formats so more lines are visible
  const densityFactor = aspectRatio > 1 ? Math.max(0.78, 1 / Math.sqrt(aspectRatio)) : 1;
  // Expand line-height for tall formats to fill vertical space with existing text
  const bodyLineHeight  = +(1.7 + Math.max(0, (aspectRatio - 1) * 0.65)).toFixed(2); // 1:1→1.7, 4:5→2.0, 9:16→2.2
  const paragraphGapPx  = Math.round(20 * scale * (1 + Math.max(0, aspectRatio - 1) * 0.8));

  const headlinePx    = Math.round(52 * scale * densityFactor);
  const subheadPx     = Math.round(28 * scale * densityFactor);
  const bodyPx        = Math.round(22 * scale * densityFactor);
  const bulletPx      = Math.round(20 * scale * densityFactor);
  const badgePx       = Math.round(18 * scale * densityFactor);
  const ctaPx         = Math.round(26 * scale * densityFactor);
  const paddingPx     = Math.round(80 * scale);

  const bulletItems = bullets.map(b =>
    `<li>${escapeHtml(b)}</li>`
  ).join('\n        ');

  const badgeItems = badges.map(b =>
    `<span class="badge">${escapeHtml(b)}</span>`
  ).join('\n        ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${dims.width}, initial-scale=1.0" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  html, body {
    width: ${dims.width}px;
    height: ${dims.height}px;
    overflow: hidden;
    background: #ffffff;
    color: #1a1a1a;
    font-family: Georgia, 'Times New Roman', Times, serif;
  }

  .page {
    width: ${dims.width}px;
    height: ${dims.height}px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: ${paddingPx}px;
    background: #ffffff;
  }

  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding-bottom: ${paragraphGapPx}px;
  }

  .top-rule {
    border: none;
    border-top: 3px solid #1a1a1a;
    margin-bottom: ${Math.round(24 * scale)}px;
  }

  .headline {
    font-family: 'Arial Black', 'Arial Bold', Arial, Helvetica, sans-serif;
    font-size: ${headlinePx}px;
    font-weight: 900;
    color: #1a1a1a;
    text-align: center;
    line-height: 1.15;
    letter-spacing: -0.5px;
    margin-bottom: ${Math.round(20 * scale)}px;
    text-transform: uppercase;
  }

  .subheadline {
    font-family: Georgia, 'Times New Roman', Times, serif;
    font-size: ${subheadPx}px;
    font-weight: normal;
    font-style: italic;
    color: #333333;
    text-align: center;
    line-height: 1.4;
    margin-bottom: ${Math.round(32 * scale)}px;
  }

  .mid-rule {
    border: none;
    border-top: 1px solid #cccccc;
    margin-bottom: ${Math.round(28 * scale)}px;
  }

  .body {
    font-family: Georgia, 'Times New Roman', Times, serif;
    font-size: ${bodyPx}px;
    line-height: ${bodyLineHeight};
    color: #222222;
    margin-bottom: ${paragraphGapPx}px;
  }

  .bullet-list {
    list-style: none;
    padding: 0;
    margin: 0 0 ${Math.round(28 * scale)}px 0;
  }

  .bullet-list li {
    font-family: Georgia, 'Times New Roman', Times, serif;
    font-size: ${bulletPx}px;
    line-height: 1.6;
    color: #1a1a1a;
    padding: ${Math.round(6 * scale)}px 0 ${Math.round(6 * scale)}px ${Math.round(28 * scale)}px;
    border-bottom: 1px solid #eeeeee;
    position: relative;
  }

  .bullet-list li::before {
    content: '—';
    position: absolute;
    left: 0;
    color: #555555;
  }

  .bottom-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: ${Math.round(16 * scale)}px;
    padding-top: ${Math.round(24 * scale)}px;
    border-top: 3px solid #1a1a1a;
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: ${Math.round(10 * scale)}px;
    justify-content: center;
  }

  .badge {
    font-family: 'Arial Black', 'Arial Bold', Arial, Helvetica, sans-serif;
    font-size: ${badgePx}px;
    font-weight: 900;
    color: #ffffff;
    background: #1a1a1a;
    padding: ${Math.round(8 * scale)}px ${Math.round(18 * scale)}px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .cta {
    font-family: 'Arial Black', 'Arial Bold', Arial, Helvetica, sans-serif;
    font-size: ${ctaPx}px;
    font-weight: 900;
    color: #1a1a1a;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
</style>
</head>
<body>
<div class="page">
  <div class="content">
    <hr class="top-rule" />
    <h1 class="headline">${escapeHtml(displayHeadline)}</h1>
    ${displaySubheadline ? `<p class="subheadline">${escapeHtml(displaySubheadline)}</p>` : ''}
    <hr class="mid-rule" />
    ${displayBody ? `<p class="body">${escapeHtml(displayBody)}</p>` : ''}
    ${bullets.length > 0 ? `<ul class="bullet-list">\n        ${bulletItems}\n      </ul>` : ''}
  </div>
  <div class="bottom-section">
    ${badges.length > 0 ? `<div class="badges">${badgeItems}</div>` : ''}
    ${displayCta ? `<p class="cta">${escapeHtml(displayCta)}</p>` : ''}
  </div>
</div>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Build an HTML document string for a two-column comparison ad.
 * @param {Object} options - see renderComparison JSDoc
 * @param {{ width: number, height: number }} dims
 * @returns {string}
 */
function buildComparisonHtml(options, dims) {
  const {
    headline      = 'FAKE MINERS ARE CANCELED',
    leftHeader    = 'Our Product',
    rightHeader   = 'Knockoff Miner',
    leftBullets   = [],
    rightBullets  = [],
    footnote      = '',
    leftImageBase64  = '',
    rightImageBase64 = '',
    leftImageMime    = 'image/jpeg',
    rightImageMime   = 'image/jpeg',
  } = options;

  const { width, height } = dims;
  const scale = width / 1080;

  // Font sizes — scale proportionally, then cap for very tall formats
  const headlinePx   = Math.round(36 * scale);
  const headerPx     = Math.round(18 * scale);
  const bulletPx     = Math.round(15 * scale);
  const footnotePx   = Math.round(12 * scale);
  const vsBadgePx    = Math.round(20 * scale);
  const vsBadgeSize  = Math.round(60 * scale);

  const cardPadH     = Math.round(20 * scale);  // card horizontal margin
  const colPad       = Math.round(16 * scale);  // inner column padding
  const imgHeight    = Math.round(240 * scale);

  const leftSrc  = leftImageBase64  ? `data:${leftImageMime};base64,${leftImageBase64}`  : '';
  const rightSrc = rightImageBase64 ? `data:${rightImageMime};base64,${rightImageBase64}` : '';

  const leftBulletHtml = leftBullets.slice(0, 4).map(b =>
    `<li class="bullet left-bullet"><span class="bullet-icon check">&#10003;</span><span class="bullet-text">${escapeHtml(b)}</span></li>`
  ).join('');

  const rightBulletHtml = rightBullets.slice(0, 4).map(b =>
    `<li class="bullet right-bullet"><span class="bullet-icon cross">&#10007;</span><span class="bullet-text">${escapeHtml(b)}</span></li>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${width}, initial-scale=1.0" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  html, body {
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
    background: #0a0a0a;
    font-family: 'Arial Black', 'Arial Bold', Arial, Helvetica, sans-serif;
  }

  .page {
    width: ${width}px;
    min-height: ${height}px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: ${Math.round(24 * scale)}px ${cardPadH}px ${Math.round(16 * scale)}px;
    gap: ${Math.round(12 * scale)}px;
  }

  /* ── Card ── */
  .card {
    width: 100%;
    background: #ffffff;
    border-radius: ${Math.round(12 * scale)}px;
    overflow: hidden;
    position: relative;
    box-shadow: 0 ${Math.round(8 * scale)}px ${Math.round(32 * scale)}px rgba(0,0,0,0.6);
  }

  /* ── Headline bar ── */
  .headline-bar {
    background: #1a1a1a;
    padding: ${Math.round(24 * scale)}px ${Math.round(32 * scale)}px;
    text-align: center;
  }
  .headline-bar h1 {
    color: #ffffff;
    font-size: ${headlinePx}px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: ${Math.round(2 * scale)}px;
    line-height: 1.2;
  }

  /* ── Two columns ── */
  .columns {
    display: flex;
    flex-direction: row;
    position: relative;
  }

  .col {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: #ffffff;
  }

  /* thin separator line from headline down */
  .col-right {
    border-left: 1px solid #e0e0e0;
  }

  /* ── Column header ── */
  .col-header {
    background: #f0f0f0;
    padding: ${Math.round(12 * scale)}px ${colPad}px;
    text-align: center;
    border-bottom: 1px solid #e0e0e0;
  }
  .col-header span {
    font-size: ${headerPx}px;
    font-weight: 900;
    color: #1a1a1a;
    text-transform: uppercase;
    letter-spacing: ${Math.round(1 * scale)}px;
  }

  /* ── Product image zone ── */
  .col-image {
    height: ${imgHeight}px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: ${colPad}px;
    border-bottom: 1px solid #eeeeee;
    background: #fafafa;
  }
  .col-image img {
    max-width: 100%;
    max-height: ${imgHeight - colPad * 2}px;
    object-fit: contain;
  }
  .col-image .img-placeholder {
    width: 80%;
    height: 70%;
    background: #e8e8e8;
    border-radius: ${Math.round(8 * scale)}px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #aaaaaa;
    font-size: ${Math.round(13 * scale)}px;
    font-weight: bold;
  }

  /* ── Bullets ── */
  .col-bullets {
    list-style: none;
    padding: ${Math.round(12 * scale)}px ${colPad}px ${Math.round(16 * scale)}px;
    display: flex;
    flex-direction: column;
    gap: ${Math.round(8 * scale)}px;
  }
  .bullet {
    display: flex;
    align-items: flex-start;
    gap: ${Math.round(8 * scale)}px;
    font-size: ${bulletPx}px;
    line-height: 1.4;
    color: #222222;
    font-family: Arial, Helvetica, sans-serif;
    font-weight: normal;
  }
  .bullet-icon {
    flex-shrink: 0;
    width: ${Math.round(20 * scale)}px;
    height: ${Math.round(20 * scale)}px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: ${Math.round(12 * scale)}px;
    font-weight: 900;
    margin-top: ${Math.round(1 * scale)}px;
  }
  .check {
    background: #22c55e;
    color: #ffffff;
  }
  .cross {
    background: #ef4444;
    color: #ffffff;
  }
  .bullet-text {
    flex: 1;
  }

  /* ── VS badge (absolute, centered on divider) ── */
  .vs-badge {
    position: absolute;
    left: 50%;
    top: ${Math.round(imgHeight / 2 + 24 * scale)}px;
    transform: translate(-50%, -50%);
    width: ${vsBadgeSize}px;
    height: ${vsBadgeSize}px;
    border-radius: 50%;
    background: #1a1a1a;
    border: ${Math.round(3 * scale)}px solid #ffffff;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
    box-shadow: 0 ${Math.round(2 * scale)}px ${Math.round(8 * scale)}px rgba(0,0,0,0.4);
  }
  .vs-badge span {
    color: #ffffff;
    font-size: ${vsBadgePx}px;
    font-weight: 900;
    letter-spacing: 1px;
  }

  /* ── Footnote ── */
  .footnote {
    color: #888888;
    font-size: ${footnotePx}px;
    font-family: Arial, Helvetica, sans-serif;
    font-weight: normal;
    text-align: center;
    padding: 0 ${cardPadH}px;
    line-height: 1.4;
  }
</style>
</head>
<body>
<div class="page">
  <div class="card">
    <div class="headline-bar">
      <h1>${escapeHtml(headline)}</h1>
    </div>
    <div class="columns">
      <!-- LEFT column -->
      <div class="col col-left">
        <div class="col-header"><span>${escapeHtml(leftHeader)}</span></div>
        <div class="col-image">
          ${leftSrc
            ? `<img src="${leftSrc}" alt="${escapeHtml(leftHeader)}" />`
            : `<div class="img-placeholder">OUR PRODUCT</div>`}
        </div>
        <ul class="col-bullets">
          ${leftBulletHtml || '<li class="bullet left-bullet"><span class="bullet-icon check">&#10003;</span><span class="bullet-text">Premium quality</span></li>'}
        </ul>
      </div>
      <!-- RIGHT column -->
      <div class="col col-right">
        <div class="col-header"><span>${escapeHtml(rightHeader)}</span></div>
        <div class="col-image">
          ${rightSrc
            ? `<img src="${rightSrc}" alt="${escapeHtml(rightHeader)}" />`
            : `<div class="img-placeholder">KNOCKOFF</div>`}
        </div>
        <ul class="col-bullets">
          ${rightBulletHtml || '<li class="bullet right-bullet"><span class="bullet-icon cross">&#10007;</span><span class="bullet-text">Cheap knockoff</span></li>'}
        </ul>
      </div>
      <!-- VS badge — overlaid on divider -->
      <div class="vs-badge"><span>VS</span></div>
    </div>
  </div>
  ${footnote ? `<p class="footnote">${escapeHtml(footnote)}</p>` : ''}
</div>
</body>
</html>`;
}

/**
 * Render a two-column comparison ad using Playwright (HTML/CSS → screenshot).
 * Used for comparison-archetype templates (e.g. "FAKE MINERS ARE CANCELED").
 * Completely bypasses the reference template — renders from scratch.
 *
 * @param {Object} options
 * @param {string}   options.headline          - e.g. "FAKE MINERS ARE CANCELED"
 * @param {string}   options.leftHeader        - e.g. "Miner Forge Pro"
 * @param {string}   options.rightHeader       - e.g. "Knockoff Miner"
 * @param {string[]} options.leftBullets       - green checkmark bullets (3–4)
 * @param {string[]} options.rightBullets      - red X bullets (3–4)
 * @param {string}   options.footnote          - bottom fine print
 * @param {string}   options.leftImageBase64   - base64 PNG/JPEG for LEFT product
 * @param {string}   options.rightImageBase64  - base64 PNG/JPEG for RIGHT product
 * @param {string}   options.leftImageMime     - 'image/jpeg' | 'image/png'
 * @param {string}   options.rightImageMime    - 'image/jpeg' | 'image/png'
 * @param {{ width: number, height: number }} dims - output dimensions
 * @returns {Promise<Buffer>} PNG image buffer
 */
export async function renderComparison(options, dims) {
  const width  = dims?.width  ?? 1080;
  const height = dims?.height ?? 1080;
  const resolvedDims = { width, height };

  console.log(`${PREFIX} Starting comparison render — ${width}×${height}`);
  console.log(`${PREFIX} Comparison: left="${options.leftHeader ?? ''}", right="${options.rightHeader ?? ''}", leftBullets=${options.leftBullets?.length ?? 0}, rightBullets=${options.rightBullets?.length ?? 0}`);

  const html = buildComparisonHtml(options, resolvedDims);
  console.log(`${PREFIX} Comparison HTML built (${html.length} chars)`);

  let browser = null;
  try {
    console.log(`${PREFIX} Launching Chromium headless browser for comparison render`);
    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });

    const page = await context.newPage();

    console.log(`${PREFIX} Setting comparison page content`);
    await page.setContent(html, { waitUntil: 'domcontentloaded' });

    console.log(`${PREFIX} Taking comparison screenshot ${width}×${height}`);
    const buffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width, height },
    });

    console.log(`${PREFIX} Comparison screenshot captured — buffer size: ${buffer.length} bytes`);
    return buffer;

  } catch (err) {
    const msg = `${PREFIX} Playwright comparison render failed: ${err?.message ?? err}`;
    console.error(msg);
    throw new Error(msg);
  } finally {
    if (browser) {
      try {
        await browser.close();
        console.log(`${PREFIX} Comparison browser closed cleanly`);
      } catch (closeErr) {
        console.warn(`${PREFIX} Comparison browser close warning: ${closeErr?.message ?? closeErr}`);
      }
    }
  }
}

/**
 * Render a document-archetype ad using Playwright (HTML/CSS → screenshot).
 * Used when skipTextRendering=false but archetype === 'document' or template has
 * background.type === 'text'.
 *
 * @param {Object} claudeResult - from buildSwapPairs: { adapted_text, text_elements, ... }
 * @param {Object} product - { name, price, profile, ... }
 * @param {Object|null} angleData - angle object with name, copy_directives, etc.
 * @param {Object|null} layoutMap - pre-analyzed layout from template
 * @param {{ width: number, height: number }} dims - output dimensions
 * @returns {Promise<Buffer>} PNG image buffer
 */
export async function renderDocument(claudeResult, product, angleData, layoutMap, dims) {
  // Default dimensions
  const width  = dims?.width  ?? 1080;
  const height = dims?.height ?? 1080;
  const resolvedDims = { width, height };

  console.log(`${PREFIX} Starting document render — ${width}×${height}`);
  console.log(`${PREFIX} Product: ${product?.name ?? '(none)'}, Angle: ${angleData?.name ?? '(none)'}`);

  // Parse adapted_text
  const fields = parseAdaptedText(claudeResult);
  console.log(`${PREFIX} Parsed fields — headline: "${fields.headline}", bullets: ${fields.bullets.length}, badges: ${fields.badges.length}`);

  // Build HTML
  const html = buildHtml(fields, product, resolvedDims);
  console.log(`${PREFIX} HTML built (${html.length} chars)`);

  let browser = null;
  try {
    console.log(`${PREFIX} Launching Chromium headless browser`);
    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });

    const page = await context.newPage();

    console.log(`${PREFIX} Setting page content`);
    await page.setContent(html, { waitUntil: 'domcontentloaded' });

    console.log(`${PREFIX} Taking screenshot ${width}×${height}`);
    const buffer = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width, height },
    });

    console.log(`${PREFIX} Screenshot captured — buffer size: ${buffer.length} bytes`);
    return buffer;

  } catch (err) {
    const msg = `${PREFIX} Playwright render failed: ${err?.message ?? err}`;
    console.error(msg);
    throw new Error(msg);
  } finally {
    if (browser) {
      try {
        await browser.close();
        console.log(`${PREFIX} Browser closed cleanly`);
      } catch (closeErr) {
        console.warn(`${PREFIX} Browser close warning: ${closeErr?.message ?? closeErr}`);
      }
    }
  }
}
