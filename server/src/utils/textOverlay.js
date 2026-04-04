// ─────────────────────────────────────────────────────────────────────────────
// Text Overlay System — Programmatic text rendering for statics ad pipeline
// Generates text-free images via NanoBanana, then composites text via SVG+Sharp
// ─────────────────────────────────────────────────────────────────────────────

import sharp from 'sharp';
import { Resvg } from '@resvg/resvg-js';

const LOG_PREFIX = '[textOverlay]';

// ── Position Parsing ──────────────────────────────────────────────────────

/**
 * Parse a natural-language position string into pixel coordinates.
 * Handles strings like "top third, centered", "bottom quarter, left-aligned",
 * "center of canvas", "upper right corner", etc.
 *
 * @param {string} positionString - e.g. "top third, centered"
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @returns {{ x: number, y: number }}
 */
function parsePosition(positionString, imageWidth, imageHeight) {
  if (!positionString || typeof positionString !== 'string') {
    return { x: imageWidth / 2, y: imageHeight / 2 };
  }

  const pos = positionString.toLowerCase();

  // ── Y-axis (vertical) ──
  let yRatio = 0.5; // default: center

  if (/top\s*(third|quarter|edge|area)/i.test(pos) || /^top\b/.test(pos) || /upper\s*(third|portion|area|half)/i.test(pos)) {
    if (/quarter/.test(pos)) yRatio = 0.12;
    else if (/third/.test(pos)) yRatio = 0.15;
    else if (/half/.test(pos)) yRatio = 0.25;
    else if (/edge/.test(pos)) yRatio = 0.06;
    else yRatio = 0.15;
  } else if (/middle|center(?:ed)?(?:\s*of\s*canvas)?/i.test(pos) && !/left|right/.test(pos.replace(/center(?:ed)?/g, ''))) {
    // Only match vertical center if the string isn't just about horizontal centering
    if (/middle/.test(pos) || /center\s*of\s*canvas/.test(pos)) yRatio = 0.5;
  } else if (/bottom\s*(third|quarter|edge|area)/i.test(pos) || /^bottom\b/.test(pos) || /lower\s*(third|portion|area|half)/i.test(pos)) {
    if (/quarter/.test(pos)) yRatio = 0.8;
    else if (/third/.test(pos)) yRatio = 0.75;
    else if (/half/.test(pos)) yRatio = 0.7;
    else if (/edge/.test(pos)) yRatio = 0.92;
    else yRatio = 0.8;
  }

  // More specific vertical patterns
  if (/above\s*center|upper\s*center/i.test(pos)) yRatio = 0.35;
  if (/below\s*center|lower\s*center/i.test(pos)) yRatio = 0.65;
  if (/very\s*top/i.test(pos)) yRatio = 0.05;
  if (/very\s*bottom/i.test(pos)) yRatio = 0.95;

  // ── X-axis (horizontal) ──
  let xRatio = 0.5; // default: centered

  if (/\bcenter(?:ed)?\b/i.test(pos)) xRatio = 0.5;
  if (/\bleft\b/i.test(pos)) xRatio = 0.1;
  if (/\bright\b/i.test(pos)) xRatio = 0.9;

  return {
    x: Math.round(imageWidth * xRatio),
    y: Math.round(imageHeight * yRatio),
  };
}

// ── Font Size Calculation ──────────────────────────────────────────────────

/**
 * Calculate font size based on hierarchy level, role, and image dimensions.
 */
function calculateFontSize(hierarchy, role, imageHeight) {
  const roleLower = (role || '').toLowerCase();

  // CTA gets its own size
  if (roleLower === 'cta') return Math.round(imageHeight * 0.04);

  // Badge / stat / disclaimer / small elements
  if (['badge', 'stat_label', 'stat_value', 'guarantee', 'disclaimer', 'other'].includes(roleLower)) {
    return Math.round(imageHeight * 0.035);
  }

  // Hierarchy-based sizing
  const h = parseInt(hierarchy, 10) || 3;
  if (h === 1) return Math.round(imageHeight * 0.065);
  if (h === 2) return Math.round(imageHeight * 0.045);
  return Math.round(imageHeight * 0.035);
}

/**
 * Determine font weight from role and hierarchy.
 */
function getFontWeight(hierarchy, role) {
  const h = parseInt(hierarchy, 10) || 3;
  const roleLower = (role || '').toLowerCase();

  if (h === 1 || roleLower === 'headline' || roleLower === 'cta') return 'bold';
  if (h === 2 || roleLower === 'subheadline') return '600';
  return 'normal';
}

// ── Text Color Detection ──────────────────────────────────────────────────

/**
 * Determine text color based on background tone.
 * White text on dark backgrounds, black text on light backgrounds.
 */
function getTextColor(backgroundTone) {
  if (!backgroundTone) return '#FFFFFF'; // default to white (most ads are dark)
  const tone = backgroundTone.toLowerCase();
  if (tone === 'light') return '#000000';
  if (tone === 'dark') return '#FFFFFF';
  // mixed — default to white with stroke for readability
  return '#FFFFFF';
}

// ── Text Wrapping ─────────────────────────────────────────────────────────

/**
 * Split text into multiple lines if it's too long for the image width.
 * Uses a simple character-width estimate: each char ~ 0.5 * fontSize wide.
 */
function wrapText(text, fontSize, maxWidth) {
  if (!text) return [''];

  const charWidth = fontSize * 0.5;
  const maxCharsPerLine = Math.floor((maxWidth * 0.8) / charWidth);

  if (text.length <= maxCharsPerLine) return [text];

  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const test = currentLine ? `${currentLine} ${word}` : word;
    if (test.length > maxCharsPerLine && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = test;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.length > 0 ? lines : [text];
}

// ── XML Escaping ──────────────────────────────────────────────────────────

function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── SVG Builder ───────────────────────────────────────────────────────────

/**
 * Build an SVG string containing all text elements.
 * @param {number} width - image width in px
 * @param {number} height - image height in px
 * @param {Array} textElements - array of { x, y, lines, fontSize, fontWeight, fontFamily, color, alignment }
 * @returns {string} SVG markup
 */
function buildTextSvg(width, height, textElements, bgColor = null) {
  let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;

  for (const el of textElements) {
    const anchor = el.alignment === 'left' ? 'start' : el.alignment === 'right' ? 'end' : 'middle';
    const x = el.alignment === 'left'
      ? Math.round(width * 0.08)
      : el.alignment === 'right'
        ? Math.round(width * 0.92)
        : Math.round(width / 2);

    const strokeColor = el.color === '#FFFFFF' ? '#000000' : '#FFFFFF';
    const strokeWidth = Math.max(1, Math.round(el.fontSize * 0.04));

    // Offset first tspan by negative half of total block height for vertical centering
    const totalLines = el.lines.length;
    const lineHeight = el.fontSize * 1.2;
    const blockHalfHeight = (totalLines * lineHeight) / 2;
    const startY = el.y - blockHalfHeight + el.fontSize * 0.5;

    // Paint an opaque background rectangle behind each text element to cover
    // any garbled text that NanoBanana may have rendered despite "no text" instruction.
    if (bgColor) {
      const maxLineChars = Math.max(...el.lines.map(l => l.length));
      const estimatedWidth = Math.min(maxLineChars * el.fontSize * 0.55 + el.fontSize * 2, width * 0.95);
      const blockHeight = totalLines * lineHeight + el.fontSize * 0.6;
      const rectX = el.alignment === 'left'
        ? Math.round(width * 0.04)
        : el.alignment === 'right'
          ? Math.round(width * 0.96 - estimatedWidth)
          : Math.round(x - estimatedWidth / 2);
      const rectY = Math.round(startY - el.fontSize * 0.4);

      svgContent += `<rect x="${rectX}" y="${rectY}" width="${Math.round(estimatedWidth)}" height="${Math.round(blockHeight)}" fill="${bgColor}" rx="4" ry="4"/>`;
    }

    svgContent += `<text x="${x}" y="${startY}" font-family="${escapeXml(el.fontFamily)}" font-size="${el.fontSize}" font-weight="${el.fontWeight}" fill="${el.color}" text-anchor="${anchor}" dominant-baseline="auto" stroke="${strokeColor}" stroke-width="${strokeWidth}" paint-order="stroke">`;

    for (let i = 0; i < el.lines.length; i++) {
      if (i === 0) {
        svgContent += `<tspan x="${x}" dy="0">${escapeXml(el.lines[i])}</tspan>`;
      } else {
        svgContent += `<tspan x="${x}" dy="${lineHeight}">${escapeXml(el.lines[i])}</tspan>`;
      }
    }

    svgContent += `</text>`;
  }

  svgContent += `</svg>`;
  return svgContent;
}

// ── Field-to-Role Mapping ─────────────────────────────────────────────────

/**
 * Match a swap pair's field name to a layout map text element by role.
 * e.g. field "headline" matches role "headline", field "badges[0]" matches role "badge"
 */
function matchFieldToLayoutElement(field, textElements) {
  if (!textElements || textElements.length === 0) return null;

  const fieldLower = (field || '').toLowerCase();

  // Direct role match
  const directMatch = textElements.find(t => {
    const role = (t.role || '').toLowerCase();
    if (fieldLower === role) return true;
    if (fieldLower === 'headline' && role === 'headline') return true;
    if (fieldLower === 'subheadline' && role === 'subheadline') return true;
    if (fieldLower === 'body' && role === 'body') return true;
    if (fieldLower === 'cta' && role === 'cta') return true;
    return false;
  });
  if (directMatch) return directMatch;

  // Array field match: "badges[0]" → "badge", "stats[1]" → "stat_value" or "stat_label"
  const arrayMatch = fieldLower.match(/^(\w+)\[(\d+)\]$/);
  if (arrayMatch) {
    const baseName = arrayMatch[1]; // e.g. "badges", "stats", "bullets"
    const index = parseInt(arrayMatch[2], 10);

    // Find all elements matching this base role
    const matching = textElements.filter(t => {
      const role = (t.role || '').toLowerCase();
      if (baseName === 'badges' && role === 'badge') return true;
      if (baseName === 'stats' && (role === 'stat_value' || role === 'stat_label')) return true;
      if (baseName === 'bullets' && role === 'body') return true;
      if (baseName === 'other_text' && role === 'other') return true;
      return false;
    });

    if (matching.length > index) return matching[index];
    if (matching.length > 0) return matching[0];
  }

  // Fallback: fuzzy match on role
  const fuzzy = textElements.find(t => {
    const role = (t.role || '').toLowerCase();
    return fieldLower.includes(role) || role.includes(fieldLower.replace(/\[\d+\]/, '').replace(/s$/, ''));
  });

  return fuzzy || null;
}

// ── Main Overlay Function ─────────────────────────────────────────────────

/**
 * Overlay text onto a generated image using SVG rendering + Sharp compositing.
 *
 * @param {Buffer} imageBuffer - the base image (text-free) as a Buffer
 * @param {Array} swapPairs - array of { original, adapted, field } from buildSwapPairs()
 * @param {Object|null} layoutMap - layout map from Claude Vision analysis
 * @param {Object} options - { fonts?: string[], backgroundTone?: string }
 * @returns {Promise<Buffer>} - composited image buffer (PNG)
 */
export async function overlayText(imageBuffer, swapPairs, layoutMap, options = {}) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    throw new Error(`${LOG_PREFIX} imageBuffer must be a valid Buffer`);
  }

  if (!swapPairs || swapPairs.length === 0) {
    console.log(`${LOG_PREFIX} No swap pairs provided — returning original image unchanged`);
    return imageBuffer;
  }

  console.log(`${LOG_PREFIX} Starting text overlay: ${swapPairs.length} swap pair(s)`);

  // Step 1: Get image dimensions
  const metadata = await sharp(imageBuffer).metadata();
  const { width, height } = metadata;

  if (!width || !height) {
    throw new Error(`${LOG_PREFIX} Could not determine image dimensions`);
  }

  console.log(`${LOG_PREFIX} Image dimensions: ${width}x${height}`);

  // Step 2: Determine styling
  const backgroundTone = options.backgroundTone || layoutMap?.background?.tone || 'dark';
  const textColor = getTextColor(backgroundTone);
  const defaultFont = (options.fonts && options.fonts.length > 0)
    ? options.fonts[0]
    : 'Arial, Helvetica, sans-serif';

  console.log(`${LOG_PREFIX} Background tone: ${backgroundTone}, text color: ${textColor}, font: ${defaultFont}`);

  // Step 3: Build text elements from swap pairs + layout map
  const textElements = layoutMap?.text_elements || [];
  const svgElements = [];

  // Track used layout elements to avoid double-mapping
  const usedLayoutIndices = new Set();

  for (const pair of swapPairs) {
    const adaptedText = pair.adapted;
    if (!adaptedText || adaptedText.trim() === '') continue;

    // Find matching layout element
    let layoutEl = null;
    if (textElements.length > 0) {
      layoutEl = matchFieldToLayoutElement(pair.field, textElements.filter((_, i) => !usedLayoutIndices.has(i)));
      if (layoutEl) {
        const idx = textElements.indexOf(layoutEl);
        if (idx >= 0) usedLayoutIndices.add(idx);
      }
    }

    const hierarchy = layoutEl?.hierarchy || (pair.field === 'headline' ? 1 : pair.field === 'subheadline' ? 2 : 3);
    const role = layoutEl?.role || pair.field.replace(/\[\d+\]$/, '');
    const alignment = layoutEl?.alignment || 'center';
    const positionStr = layoutEl?.position || getDefaultPosition(pair.field);

    const fontSize = calculateFontSize(hierarchy, role, height);
    const fontWeight = getFontWeight(hierarchy, role);
    const { x, y } = parsePosition(positionStr, width, height);
    const lines = wrapText(adaptedText, fontSize, width);

    svgElements.push({
      x,
      y,
      lines,
      fontSize,
      fontWeight,
      fontFamily: defaultFont,
      color: textColor,
      alignment,
      field: pair.field,
    });

    console.log(`${LOG_PREFIX}   [${pair.field}] "${adaptedText.slice(0, 50)}${adaptedText.length > 50 ? '...' : ''}" → pos:(${x},${y}) size:${fontSize} lines:${lines.length}`);
  }

  if (svgElements.length === 0) {
    console.log(`${LOG_PREFIX} No text elements to render — returning original image`);
    return imageBuffer;
  }

  // Step 4: Sample dominant background color for erasing NanoBanana's garbled text
  let bgColor = null;
  try {
    const { dominant } = await sharp(imageBuffer).stats();
    if (dominant) {
      const r = Math.round(dominant.r);
      const g = Math.round(dominant.g);
      const b = Math.round(dominant.b);
      bgColor = `rgb(${r},${g},${b})`;
      console.log(`${LOG_PREFIX} Sampled dominant bg color: ${bgColor}`);
    }
  } catch (e) {
    // Fallback: use tone-based estimate
    bgColor = backgroundTone === 'light' ? '#F0F0F0' : backgroundTone === 'dark' ? '#1A1A1A' : '#333333';
    console.log(`${LOG_PREFIX} Could not sample bg color, using fallback: ${bgColor}`);
  }

  // Step 5: Build SVG and render to PNG
  const svgString = buildTextSvg(width, height, svgElements, bgColor);
  console.log(`${LOG_PREFIX} SVG generated: ${svgString.length} chars, ${svgElements.length} text element(s), bg erase: ${bgColor || 'none'}`);

  let textPng;
  try {
    const resvg = new Resvg(svgString, {
      fitTo: { mode: 'width', value: width },
    });
    const rendered = resvg.render();
    textPng = rendered.asPng();
  } catch (renderErr) {
    console.error(`${LOG_PREFIX} SVG render failed:`, renderErr.message);
    throw new Error(`${LOG_PREFIX} Failed to render text SVG: ${renderErr.message}`);
  }

  console.log(`${LOG_PREFIX} Text layer rendered: ${textPng.length} bytes`);

  // Step 6: Composite text layer onto base image
  const composited = await sharp(imageBuffer)
    .composite([{
      input: textPng,
      top: 0,
      left: 0,
      blend: 'over',
    }])
    .png()
    .toBuffer();

  console.log(`${LOG_PREFIX} Compositing complete: ${composited.length} bytes (${width}x${height})`);

  return composited;
}

/**
 * Get a default position string for a field when no layout map is available.
 */
function getDefaultPosition(field) {
  const f = (field || '').toLowerCase().replace(/\[\d+\]$/, '');
  switch (f) {
    case 'headline': return 'top third, centered';
    case 'subheadline': return 'upper center, centered';
    case 'body': return 'center of canvas, centered';
    case 'cta': return 'bottom quarter, centered';
    case 'badges': return 'top edge, centered';
    case 'stats': return 'center, centered';
    case 'bullets': return 'center, left';
    case 'other_text': return 'bottom third, centered';
    case 'disclaimer': return 'very bottom, centered';
    default: return 'center of canvas, centered';
  }
}
