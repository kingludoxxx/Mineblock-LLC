// Primary text sent to Meta: a blank line after every paragraph, so long copy reads in feed (Ludo 2026-09-14).

export function formatParagraphs(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .join('\n\n')
    .trim();
}

export function formatPrimaryTexts(texts) {
  return (texts || []).map(formatParagraphs).filter(Boolean);
}
