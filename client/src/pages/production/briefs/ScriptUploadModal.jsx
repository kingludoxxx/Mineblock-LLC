import { useEffect, useState } from 'react';
import { X, Upload, Loader2, AlertCircle, FileText } from 'lucide-react';
import api from '../../../services/api';

export default function ScriptUploadModal({ open, onClose, onImported }) {
  const [rawScript, setRawScript]    = useState('');
  const [sourceUrl, setSourceUrl]    = useState('');
  const [brandName, setBrandName]    = useState('');
  const [headline, setHeadline]      = useState('');
  const [thumbnailUrl, setThumbUrl]  = useState('');
  const [saving, setSaving]          = useState(false);
  const [error, setError]            = useState(null);

  useEffect(() => {
    if (!open) {
      setRawScript(''); setSourceUrl(''); setBrandName(''); setHeadline(''); setThumbUrl('');
      setError(null);
      return;
    }
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [open, onClose]);

  if (!open) return null;

  const canSave = rawScript.trim().length >= 20 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const { data } = await api.post('/brief-pipeline/references/upload', {
        rawScript: rawScript.trim(),
        sourceUrl: sourceUrl.trim() || null,
        brandName: brandName.trim() || null,
        headline:  headline.trim()  || null,
        thumbnailUrl: thumbnailUrl.trim() || null,
      });
      if (onImported) onImported(data.reference);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error?.message || err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div
        className="relative w-full max-w-xl bg-[#0a0a0a] border border-white/[0.08] rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-14 border-b border-white/[0.06] flex items-center justify-between px-5 shrink-0">
          <div className="flex items-center gap-2.5">
            <Upload className="w-4 h-4 text-zinc-400" />
            <h2 className="text-sm font-mono font-semibold text-white tracking-[0.18em] uppercase">
              Upload Script
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Paste a full ad transcript, landing-page copy, or any script you want to use as a
            reference for brief generation. Min 20 characters.
          </p>

          {/* Script — required */}
          <div>
            <label className="text-[10px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1.5 block">
              Script <span className="text-zinc-700">(required)</span>
            </label>
            <textarea
              value={rawScript}
              onChange={e => setRawScript(e.target.value)}
              placeholder="Paste your script here…"
              autoFocus
              className="w-full h-44 bg-white/[0.02] border border-white/[0.06] rounded-md p-3 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-[#c9a84c]/40 resize-y leading-relaxed"
            />
            <div className="mt-1 text-[10px] text-zinc-600 font-mono text-right">
              {rawScript.length} chars · {rawScript.trim().split(/\s+/).filter(Boolean).length} words
            </div>
          </div>

          {/* Source URL */}
          <div>
            <label className="text-[10px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1.5 block">
              Source URL <span className="text-zinc-700">(optional)</span>
            </label>
            <input
              type="url"
              value={sourceUrl}
              onChange={e => setSourceUrl(e.target.value)}
              placeholder="https://..."
              className="w-full bg-white/[0.02] border border-white/[0.06] rounded-md p-2.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-[#c9a84c]/40"
            />
          </div>

          {/* Brand + Headline */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1.5 block">
                Brand
              </label>
              <input
                type="text"
                value={brandName}
                onChange={e => setBrandName(e.target.value)}
                placeholder="Brand name"
                className="w-full bg-white/[0.02] border border-white/[0.06] rounded-md p-2.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-[#c9a84c]/40"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1.5 block">
                Headline
              </label>
              <input
                type="text"
                value={headline}
                onChange={e => setHeadline(e.target.value)}
                placeholder="Headline or title"
                className="w-full bg-white/[0.02] border border-white/[0.06] rounded-md p-2.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-[#c9a84c]/40"
              />
            </div>
          </div>

          {/* Thumbnail */}
          <div>
            <label className="text-[10px] font-mono uppercase tracking-[0.15em] text-zinc-500 mb-1.5 block">
              Thumbnail URL <span className="text-zinc-700">(optional)</span>
            </label>
            <input
              type="url"
              value={thumbnailUrl}
              onChange={e => setThumbUrl(e.target.value)}
              placeholder="https://..."
              className="w-full bg-white/[0.02] border border-white/[0.06] rounded-md p-2.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-[#c9a84c]/40"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded-md p-2.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/[0.06] shrink-0 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider rounded-md text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-mono font-semibold uppercase tracking-wider rounded-md transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: 'linear-gradient(135deg, #c9a84c, #d4b55a)',
              color: '#111113',
              boxShadow: '0 0 16px rgba(201,168,76,0.25)',
            }}
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
            Upload
          </button>
        </div>
      </div>
    </div>
  );
}
