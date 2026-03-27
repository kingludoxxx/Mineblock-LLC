import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Upload, Globe, X, Sparkles, Check, Loader2, Trash2, Plus, ImagePlus } from 'lucide-react';
import api from '../../../services/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fileToBase64 = (file) =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });

function generateName(source) {
  const ts = Date.now().toString(36);
  if (source instanceof File) {
    const base = source.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, ' ').trim();
    return base || `ref-${ts}`;
  }
  try {
    const url = new URL(source);
    const seg = url.pathname.split('/').filter(Boolean).pop() || '';
    const base = seg.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, ' ').trim();
    return base || `ref-${ts}`;
  } catch {
    return `ref-${ts}`;
  }
}

// ---------------------------------------------------------------------------
// Tab Button
// ---------------------------------------------------------------------------

function TabButton({ active, icon: Icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
        active
          ? 'bg-white/[0.1] text-white'
          : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]'
      }`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Upload Tab
// ---------------------------------------------------------------------------

function UploadTab({ files, setFiles }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const addFiles = useCallback(
    (incoming) => {
      const accepted = Array.from(incoming).filter((f) =>
        ['image/jpeg', 'image/png', 'image/webp'].includes(f.type),
      );
      setFiles((prev) => {
        const combined = [...prev, ...accepted];
        return combined.slice(0, 200);
      });
    },
    [setFiles],
  );

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const removeFile = (index) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`flex flex-col items-center justify-center gap-3 py-12 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${
          dragOver
            ? 'border-blue-500/50 bg-blue-500/[0.05]'
            : 'border-white/[0.12] hover:border-white/[0.2] bg-white/[0.02]'
        }`}
      >
        <Upload className="w-8 h-8 text-slate-500" />
        <p className="text-sm text-slate-300">Drop ad images here</p>
        <p className="text-xs text-slate-500">Select up to 200 images at once &middot; JPG, PNG, WebP</p>
        <input
          ref={inputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.webp"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {/* Thumbnails */}
      {files.length > 0 && (
        <div>
          <p className="text-xs text-slate-400 mb-2">{files.length} file{files.length !== 1 ? 's' : ''} selected</p>
          <div className="grid grid-cols-6 gap-2 max-h-48 overflow-y-auto">
            {files.map((file, i) => (
              <div key={`${file.name}-${i}`} className="relative group aspect-square rounded-lg overflow-hidden bg-black/30">
                <img
                  src={URL.createObjectURL(file)}
                  alt={file.name}
                  className="w-full h-full object-cover"
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(i);
                  }}
                  className="absolute top-1 right-1 p-0.5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// URL Tab
// ---------------------------------------------------------------------------

function UrlTab({ urls, setUrls }) {
  const [input, setInput] = useState('');

  const addUrl = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    try {
      new URL(trimmed);
    } catch {
      return;
    }
    setUrls((prev) => [...prev, trimmed]);
    setInput('');
  };

  const removeUrl = (index) => {
    setUrls((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addUrl()}
          placeholder="https://example.com/ad.jpg"
          className="flex-1 px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-white placeholder:text-slate-500 outline-none focus:border-white/[0.2] transition-colors"
        />
        <button
          onClick={addUrl}
          className="px-3 py-2 rounded-lg bg-white/[0.08] text-sm text-slate-300 hover:bg-white/[0.12] hover:text-white transition-colors cursor-pointer"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {urls.length > 0 && (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {urls.map((url, i) => (
            <div
              key={`${url}-${i}`}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs text-slate-300"
            >
              <Globe className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <span className="truncate flex-1">{url}</span>
              <button
                onClick={() => removeUrl(i)}
                className="text-slate-500 hover:text-red-400 transition-colors cursor-pointer shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress Item
// ---------------------------------------------------------------------------

function ProgressItem({ item }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
      {/* Thumbnail */}
      <div className="w-10 h-10 rounded-md overflow-hidden bg-black/30 shrink-0">
        {item.preview && (
          <img src={item.preview} alt="" className="w-full h-full object-cover" />
        )}
      </div>

      {/* Name */}
      <span className="text-xs text-slate-300 truncate flex-1">{item.name}</span>

      {/* Status */}
      {item.status === 'pending' && (
        <span className="text-[11px] text-slate-500">Pending</span>
      )}
      {item.status === 'analyzing' && (
        <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
      )}
      {item.status === 'done' && (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          <Check className="w-3 h-3" />
          {item.category || 'Done'}
        </span>
      )}
      {item.status === 'error' && (
        <span className="text-[11px] text-red-400">Failed</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddReferenceModal
// ---------------------------------------------------------------------------

export function AddReferenceModal({ isOpen, onClose, onImportComplete }) {
  const [tab, setTab] = useState('upload');
  const [files, setFiles] = useState([]);
  const [urls, setUrls] = useState([]);
  const [categoryHint, setCategoryHint] = useState('');

  // Import state
  const [importing, setImporting] = useState(false);
  const [queue, setQueue] = useState([]); // { name, preview, status, category }
  const [doneCount, setDoneCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [resultTemplates, setResultTemplates] = useState([]);

  // Reset when modal opens
  useEffect(() => {
    if (isOpen) {
      setTab('upload');
      setFiles([]);
      setUrls([]);
      setCategoryHint('');
      setImporting(false);
      setQueue([]);
      setDoneCount(0);
      setTotalCount(0);
      setCompleted(false);
      setResultTemplates([]);
    }
  }, [isOpen]);

  const canImport =
    !importing && !completed && (files.length > 0 || urls.length > 0);

  // ------------------------------------------
  // Import logic
  // ------------------------------------------
  const handleImport = async () => {
    const items = [];

    // Build queue from files
    for (const file of files) {
      const preview = await fileToBase64(file);
      items.push({
        type: 'file',
        name: generateName(file),
        preview,
        dataUri: preview,
        status: 'pending',
        category: null,
      });
    }

    // Build queue from URLs
    for (const url of urls) {
      items.push({
        type: 'url',
        name: generateName(url),
        preview: url,
        url,
        status: 'pending',
        category: null,
      });
    }

    setQueue(items);
    setTotalCount(items.length);
    setDoneCount(0);
    setImporting(true);

    const templates = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Mark analyzing
      setQueue((prev) =>
        prev.map((q, idx) => (idx === i ? { ...q, status: 'analyzing' } : q)),
      );

      try {
        // 1. Create template
        const payload = {
          name: item.name,
          category: categoryHint || 'Uncategorized',
          image_url: item.type === 'url' ? item.url : item.dataUri,
        };
        const res = await api.post('/statics-templates', payload);
        const template = res.data?.data || res.data;

        // 2. AI categorize
        let category = categoryHint || 'Uncategorized';
        try {
          const catRes = await api.post(`/statics-templates/${template.id}/categorize`);
          category = catRes.data?.data?.category || catRes.data?.category || category;
        } catch {
          // keep hint or Uncategorized
        }

        templates.push({ ...template, category });

        setQueue((prev) =>
          prev.map((q, idx) =>
            idx === i ? { ...q, status: 'done', category } : q,
          ),
        );
      } catch {
        setQueue((prev) =>
          prev.map((q, idx) => (idx === i ? { ...q, status: 'error' } : q)),
        );
      }

      setDoneCount(i + 1);
    }

    setImporting(false);
    setCompleted(true);
    setResultTemplates(templates);
  };

  const handleDone = () => {
    onImportComplete?.(resultTemplates);
    onClose();
  };

  // ------------------------------------------
  // Render
  // ------------------------------------------

  if (!isOpen) return null;

  const modal = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget && !importing) onClose();
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Card */}
      <div className="relative w-full max-w-[500px] max-h-[85vh] flex flex-col bg-[#111] border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-5 pb-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-base font-semibold text-white">Add Reference Ads</h2>
              <p className="text-xs text-slate-400 mt-1">
                Upload up to 200 images at once &mdash; AI scans, tags &amp; categorizes each one
              </p>
            </div>
            <button
              onClick={onClose}
              disabled={importing}
              className="p-1 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer disabled:opacity-40"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Tabs */}
          {!importing && !completed && (
            <div className="flex gap-1 mt-4 p-1 rounded-xl bg-white/[0.04]">
              <TabButton
                active={tab === 'upload'}
                icon={Upload}
                label="Upload Files"
                onClick={() => setTab('upload')}
              />
              <TabButton
                active={tab === 'url'}
                icon={Globe}
                label="From URL"
                onClick={() => setTab('url')}
              />
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-4">
          {/* Input tabs */}
          {!importing && !completed && (
            <>
              {tab === 'upload' ? (
                <UploadTab files={files} setFiles={setFiles} />
              ) : (
                <UrlTab urls={urls} setUrls={setUrls} />
              )}

              {/* Category hint */}
              <input
                type="text"
                value={categoryHint}
                onChange={(e) => setCategoryHint(e.target.value)}
                placeholder="Category hint (e.g. 'Us vs Them') — optional"
                className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-white placeholder:text-slate-500 outline-none focus:border-white/[0.2] transition-colors"
              />

              {/* Submit */}
              <button
                onClick={handleImport}
                disabled={!canImport}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Sparkles className="w-4 h-4" />
                Analyze &amp; Add to Library
              </button>
              <p className="text-[11px] text-slate-500 text-center -mt-2">
                Claude AI detects category + analyzes each ad one by one
              </p>
            </>
          )}

          {/* Progress */}
          {(importing || completed) && (
            <div className="space-y-3">
              {/* Progress bar */}
              {importing && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-300">
                      Analyzing {doneCount}/{totalCount}...
                    </span>
                    <span className="text-xs text-slate-500 tabular-nums">
                      {Math.round((doneCount / totalCount) * 100)}%
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                      style={{ width: `${(doneCount / totalCount) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Completed message */}
              {completed && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="text-sm text-emerald-300 font-medium">
                    {resultTemplates.length} template{resultTemplates.length !== 1 ? 's' : ''} added to library
                  </span>
                </div>
              )}

              {/* Queue list */}
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {queue.map((item, i) => (
                  <ProgressItem key={`${item.name}-${i}`} item={item} />
                ))}
              </div>

              {/* Done button */}
              {completed && (
                <button
                  onClick={handleDone}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 transition-colors cursor-pointer"
                >
                  <Check className="w-4 h-4" />
                  Done
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
