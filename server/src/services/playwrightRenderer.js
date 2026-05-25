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
