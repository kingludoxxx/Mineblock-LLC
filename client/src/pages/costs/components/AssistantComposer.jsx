// AssistantComposer — the one input path into the COGS assistant (NEW FILE,
// costs lane).
//
// Three ways to attach a photo of a price list (drop, paste, picker) all
// funnel into ONE addFiles(), so the size and type rules cannot diverge
// between them. Slots are reserved SYNCHRONOUSLY against a ref, because
// setState updaters do not run synchronously and dropping five files at once
// would otherwise race straight past the cap.
import { useCallback, useRef, useState } from 'react';
import { ImagePlus, Loader2, Send, X } from 'lucide-react';
import Button from '../../../components/ui/Button';
import { MAX_IMAGE_BYTES, MODELS, fileToBase64 } from '../assistantApi';

const MAX_IMAGES = 4;

export default function AssistantComposer({ busy, model, onModelChange, onSend, disabled }) {
  const [text, setText] = useState('');
  const [images, setImages] = useState([]);
  const [rejected, setRejected] = useState([]);
  const [dragging, setDragging] = useState(false);
  const reservedRef = useRef(0);
  const fileRef = useRef(null);

  const addFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []).filter((f) => f && f.type.startsWith('image/'));
    if (!files.length) return;
    const bad = [];
    const accepted = [];
    for (const f of files) {
      if (reservedRef.current >= MAX_IMAGES) {
        bad.push(`${f.name}: at most ${MAX_IMAGES} images per message`);
        continue;
      }
      reservedRef.current += 1;
      accepted.push(f);
    }
    const loaded = [];
    for (const f of accepted) {
      try {
        const out = await fileToBase64(f, MAX_IMAGE_BYTES);
        loaded.push({ id: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 7)}`, ...out });
      } catch (err) {
        reservedRef.current -= 1;
        bad.push(err.message);
      }
    }
    if (loaded.length) setImages((prev) => [...prev, ...loaded]);
    if (bad.length) setRejected(bad);
  }, []);

  const removeImage = (id) => {
    setImages((prev) => {
      const next = prev.filter((i) => i.id !== id);
      reservedRef.current = next.length;
      return next;
    });
  };

  const send = async () => {
    if (busy || disabled) return;
    if (!text.trim() && !images.length) return;
    const payload = { message: text.trim(), images: images.map((i) => i.data) };
    setText('');
    setImages([]);
    setRejected([]);
    reservedRef.current = 0;
    await onSend(payload);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer?.files); }}
      className={`rounded-xl border p-3 transition-colors ${dragging ? 'border-accent bg-bg-hover' : 'border-border-default bg-bg-card'}`}
    >
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {images.map((img) => (
            <div key={img.id} className="relative">
              <img src={img.data} alt={img.name} className="h-16 w-16 object-cover rounded-lg border border-border-default" />
              <button
                type="button"
                onClick={() => removeImage(img.id)}
                aria-label={`Remove ${img.name}`}
                className="absolute -top-1.5 -right-1.5 bg-bg-elevated border border-border-default rounded-full p-0.5 text-text-muted hover:text-text-primary cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {rejected.length > 0 && (
        <ul className="mb-2 text-[11px] text-danger space-y-0.5">
          {rejected.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData?.files || []);
          if (files.length) { e.preventDefault(); addFiles(files); }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
        }}
        rows={3}
        disabled={disabled}
        placeholder={'e.g. "the 3-pack costs $4.20 landed from the new supplier" — or paste a photo of the price list'}
        className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-faint resize-y outline-none"
      />

      <div className="flex items-center justify-between gap-3 pt-2 border-t border-border-subtle/60">
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          />
          <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} disabled={disabled}>
            <ImagePlus className="w-3.5 h-3.5" /> Photo
          </Button>
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={disabled}
            aria-label="Model"
            className="bg-bg-elevated border border-border-default rounded-lg px-2 py-1 text-xs text-text-muted cursor-pointer"
          >
            {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <Button size="sm" onClick={send} disabled={disabled || busy || (!text.trim() && !images.length)}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          {busy ? 'Reading your catalog…' : 'Propose'}
        </Button>
      </div>
      <p className="mt-1.5 text-[10px] text-text-faint">
        Nothing is written until you apply a proposal. Enter sends · Shift+Enter for a new line.
      </p>
    </div>
  );
}
