// Deterministic, dependency-free code formatters for the Clone-a-page paste
// panes. COSMETIC ONLY: they re-indent and re-line-break, they never rewrite,
// reorder, or drop tokens. Pure functions (string in → string out, no state),
// exported separately so the server-side verification harness can unit-test
// them without a JSX transform.

// Void elements never push indent depth.
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Elements whose raw text content must not be re-tokenized as markup.
// <pre>/<textarea> content is whitespace-significant and passes through
// VERBATIM; <style> content is CSS-formatted; <script> is dedented only.
const OPAQUE_TAGS = new Set(['script', 'style', 'pre', 'textarea']);

// Find the index of the '>' that ends a tag starting at `start`, honouring
// quoted attribute values (a '>' inside "..." or '...' does not end the tag).
function findTagEnd(src, start) {
  let quote = null;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

// Remove the common leading whitespace of a block's non-empty lines and drop
// leading/trailing blank lines. Used for <script> bodies so their internal
// relative indentation survives re-indenting.
function dedent(block) {
  const lines = String(block).replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let common = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    common = Math.min(common, l.match(/^[ \t]*/)[0].length);
  }
  if (!Number.isFinite(common)) common = 0;
  return lines.map((l) => (l.trim() ? l.slice(common) : ''));
}

// Re-indent HTML by tag depth, two spaces per level. One tag per line; text
// nodes are whitespace-collapsed onto their own line; <pre>/<textarea> bodies
// verbatim; <style> bodies CSS-formatted; <script> bodies dedented.
export function formatHtml(source) {
  const src = String(source);

  // ── Tokenize ────────────────────────────────────────────────────────────
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === '<') {
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i + 4);
        const stop = end === -1 ? src.length : end + 3;
        tokens.push({ kind: 'comment', raw: src.slice(i, stop) });
        i = stop;
        continue;
      }
      const end = findTagEnd(src, i);
      if (end === -1) {
        // Unterminated tag — emit the tail as text rather than lose it.
        tokens.push({ kind: 'text', raw: src.slice(i) });
        break;
      }
      const raw = src.slice(i, end + 1);
      const m = raw.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/);
      if (!m) {
        // <!doctype ...>, <?xml ...>, or stray '<' — no depth change.
        tokens.push({ kind: 'decl', raw });
        i = end + 1;
        continue;
      }
      const name = m[1].toLowerCase();
      const isClose = raw[1] === '/';
      const selfClosed = /\/\s*>$/.test(raw);
      tokens.push({ kind: 'tag', raw, name, isClose, selfClosed });
      i = end + 1;
      if (!isClose && !selfClosed && OPAQUE_TAGS.has(name)) {
        const closeMatch = src.slice(i).match(new RegExp(`</${name}\\s*>`, 'i'));
        if (closeMatch) {
          tokens.push({ kind: 'opaque', name, raw: src.slice(i, i + closeMatch.index) });
          tokens.push({ kind: 'tag', raw: closeMatch[0], name, isClose: true, selfClosed: false });
          i += closeMatch.index + closeMatch[0].length;
        }
        // No close tag → the rest tokenizes normally; nothing is dropped.
      }
    } else {
      const next = src.indexOf('<', i);
      const stop = next === -1 ? src.length : next;
      tokens.push({ kind: 'text', raw: src.slice(i, stop) });
      i = stop;
    }
  }

  // ── Emit ────────────────────────────────────────────────────────────────
  const out = [];
  let depth = 0;
  const pad = (d) => '  '.repeat(Math.max(0, d));
  for (const t of tokens) {
    if (t.kind === 'text') {
      const text = t.raw.replace(/\s+/g, ' ').trim();
      if (text) out.push(pad(depth) + text);
    } else if (t.kind === 'comment' || t.kind === 'decl') {
      out.push(pad(depth) + t.raw.trim());
    } else if (t.kind === 'opaque') {
      if (t.name === 'pre' || t.name === 'textarea') {
        if (t.raw) out.push(t.raw.replace(/^\n/, '').replace(/\n$/, ''));
      } else if (t.name === 'style') {
        const css = formatCss(t.raw);
        if (css) out.push(css.split('\n').map((l) => pad(depth) + l).join('\n'));
      } else {
        const lines = dedent(t.raw);
        if (lines.length) out.push(lines.map((l) => (l ? pad(depth) + l : '')).join('\n'));
      }
    } else if (t.isClose) {
      depth = Math.max(0, depth - 1);
      out.push(pad(depth) + t.raw);
    } else {
      // Multi-line open tags collapse onto one line (newline runs → space).
      out.push(pad(depth) + t.raw.replace(/\s*\r?\n\s*/g, ' '));
      if (!t.selfClosed && !VOID_TAGS.has(t.name)) depth += 1;
    }
  }
  return out.join('\n');
}

// Format CSS: newline after '{', '}' and ';', two-space indent inside braces.
// Strings and /* comments */ pass through verbatim; a ';' or brace inside
// parentheses (e.g. url(data:image/png;base64,...)) never breaks the line.
export function formatCss(source) {
  const src = String(source);
  const lines = [];
  let line = '';
  let depth = 0;
  let paren = 0;
  const pad = (d) => '  '.repeat(Math.max(0, d));
  const flush = () => {
    const t = line.trim();
    if (t) lines.push(pad(depth) + t);
    line = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      line += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      const stop = Math.min(j + 1, src.length);
      line += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '(') { paren += 1; line += c; i += 1; continue; }
    if (c === ')') { paren = Math.max(0, paren - 1); line += c; i += 1; continue; }
    if (paren === 0) {
      if (c === '{') {
        line = `${line.replace(/\s+$/, '')} {`;
        flush();
        depth += 1;
        i += 1;
        continue;
      }
      if (c === '}') {
        flush();
        depth = Math.max(0, depth - 1);
        line = '}';
        flush();
        i += 1;
        continue;
      }
      if (c === ';') {
        line += ';';
        flush();
        i += 1;
        continue;
      }
    }
    if (c === '\n' || c === '\r') {
      // Source line breaks become soft spaces; flush() decides real breaks.
      if (line && !/\s$/.test(line)) line += ' ';
      i += 1;
      continue;
    }
    line += c;
    i += 1;
  }
  flush();
  return lines.join('\n');
}
