import { useEffect, useMemo, useState } from 'react';
import api from '../../../services/api';

// The template list carries `has_analysis`, not the analysis itself (it was 79% of an 8.5 MB list that timed out).
// A view that shows the analysis loads it for the one template it opens.

export function parseAnalysis(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value ?? null;
}

export function templateIsAnalyzed(template) {
  return Boolean(template?.deep_analysis || template?.has_analysis);
}

/** @returns {{analysis: object|null, loading: boolean, error: string|null}} */
export function useTemplateAnalysis(template) {
  const id = template?.id ?? null;
  const inline = template?.deep_analysis ?? null;
  const needsFetch = Boolean(id && !inline && template?.has_analysis);
  const [state, setState] = useState({ key: null, analysis: null, error: null });
  // Parsed once per value: a fresh object on every render would re-fire every effect that depends on it.
  const parsedInline = useMemo(() => parseAnalysis(inline), [inline]);
  const key = needsFetch ? `${id}|${template?.analyzed_at ?? ''}` : null;

  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    api.get(`/statics-generation/templates/${id}/analysis`)
      .then((res) => { if (live) setState({ key, analysis: parseAnalysis(res.data?.deep_analysis), error: null }); })
      .catch((err) => {
        if (live) setState({ key, analysis: null, error: err?.response?.data?.error?.message || err?.message || 'Could not load the analysis' });
      });
    return () => { live = false; };
  }, [key, id]);

  if (inline) return { analysis: parsedInline, loading: false, error: null };
  if (!needsFetch) return { analysis: null, loading: false, error: null };
  if (state.key !== key) return { analysis: null, loading: true, error: null };
  return { analysis: state.analysis, loading: false, error: state.error };
}
