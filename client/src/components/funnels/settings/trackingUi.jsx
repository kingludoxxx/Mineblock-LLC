// Shared primitives for the Tracking section (directory, network detail, and
// the two integrations panels). Extracted so the three files render the SAME
// chip, the same badge and the same copy button — a status dot that means one
// thing on a card and another on a detail page is how an operator ends up
// trusting a green light that isn't.
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

// state: 'connected' | 'not_connected' | 'checking' | 'unknown'
export function ConnChip({ state }) {
  const map = {
    connected: { label: 'Connected', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    not_connected: { label: 'Not connected', cls: 'bg-bg-elevated text-text-muted border-border-default' },
    checking: { label: 'Checking…', cls: 'bg-bg-elevated text-text-faint border-border-default' },
    unknown: { label: 'Status unknown', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  };
  const s = map[state] || map.unknown;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded-full border ${s.cls}`}>
      {s.label}
    </span>
  );
}

// The small coloured dot the reference puts on every card next to the state.
export function StatusDot({ state }) {
  const cls = state === 'connected' ? 'bg-emerald-400'
    : state === 'unknown' ? 'bg-amber-400'
      : state === 'checking' ? 'bg-text-faint animate-pulse'
        : 'bg-text-faint';
  return <span className={`w-2 h-2 rounded-full shrink-0 ${cls}`} />;
}

export function ModeTag({ tag }) {
  if (!tag) return null;
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded border border-border-default bg-bg-elevated text-text-faint shrink-0">
      {tag}
    </span>
  );
}

export function CopyUrlButton({ value, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(value ?? ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable (http / permissions) — non-fatal */ }
  };
  return (
    <button
      onClick={copy}
      title="Copy"
      type="button"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border-default bg-bg-elevated text-text-primary hover:bg-bg-hover cursor-pointer transition-colors shrink-0"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

// A checkbox row. `note` renders as a native tooltip AND as visible help text —
// a tooltip alone is invisible on touch and to anyone who does not hover, and
// the whole point of these notes is that a flag which does nothing yet must SAY
// so where the operator is looking.
export function CheckboxRow({ label, checked, onChange, disabled = false, note = '' }) {
  return (
    <div className="space-y-0.5">
      <label
        title={note || undefined}
        className={`flex items-center gap-2.5 text-sm text-text-primary ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 rounded border-border-default bg-bg-elevated accent-accent cursor-pointer disabled:cursor-not-allowed"
        />
        {label}
      </label>
      {note && <p className="pl-[26px] text-xs text-text-faint">{note}</p>}
    </div>
  );
}

export function Field({ label, value, onChange, placeholder, help, mono = true, disabled = false }) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-text-muted">{label}</label>
      <input
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={`w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint ${mono ? 'font-mono' : ''} focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors disabled:opacity-60`}
      />
      {help && <p className="text-xs text-text-faint">{help}</p>}
    </div>
  );
}

export function Panel({ title, description, children, tone = 'default' }) {
  const border = tone === 'warn' ? 'border-amber-500/25' : 'border-border-default';
  return (
    <div className={`rounded-xl border ${border} bg-bg-card p-4 space-y-3`}>
      {(title || description) && (
        <div>
          {title && <div className="text-sm font-semibold text-text-primary">{title}</div>}
          {description && <div className="text-xs text-text-faint">{description}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

// A read-only "label ……… value" row, the shape the reference uses for the
// status block on every network detail page.
export function StatRow({ label, children, tone = '' }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-text-muted shrink-0">{label}</span>
      <span className={`text-right min-w-0 break-words ${tone || 'text-text-primary'}`}>{children}</span>
    </div>
  );
}

