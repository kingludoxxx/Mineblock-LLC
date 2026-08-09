// Shared presentational bits for the Funnel Settings modal.
import { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { STATUS_PRESENTATION } from './gatewayMeta';

const TONES = {
  success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  primary: 'bg-accent-muted text-accent-text border-accent/20',
  warning: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  danger: 'bg-red-500/10 text-red-400 border-red-500/20',
  default: 'bg-bg-elevated text-text-muted border-border-default',
};

// A live connection-status pill. `status` is a health-endpoint status string
// (or 'checking'). React escapes all text — no raw HTML is ever rendered.
export function StatusPill({ status = 'checking', className = '' }) {
  const p = STATUS_PRESENTATION[status] || STATUS_PRESENTATION.unknown;
  const dot = {
    success: 'bg-emerald-400',
    primary: 'bg-accent',
    warning: 'bg-amber-400',
    danger: 'bg-red-400',
    default: 'bg-text-faint',
  }[p.tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full border ${TONES[p.tone]} ${className}`}
    >
      {status === 'checking' ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      )}
      {p.label}
    </span>
  );
}

// iOS-style toggle matching the app's existing switches.
export function Toggle({ checked, onChange, disabled = false, id }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer
        disabled:opacity-40 disabled:cursor-not-allowed
        ${checked ? 'bg-accent' : 'bg-slate-600'}`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white transition-transform
          ${checked ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  );
}

// A rounded gateway "logo" tile (wordmark on a brand-tinted chip — no external
// image dependency, CSP-safe).
export function GatewayLogo({ name, accent, size = 'md' }) {
  const dims = size === 'sm' ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm';
  return (
    <span
      className={`inline-flex items-center justify-center ${dims} rounded-lg font-bold shrink-0`}
      style={{ backgroundColor: `${accent}22`, color: accent, border: `1px solid ${accent}44` }}
      aria-hidden="true"
    >
      {name.slice(0, 2)}
    </span>
  );
}

// Write-only secret / plain field. Secrets that are already stored render as
// masked with a "SET" marker and a Clear affordance; typing replaces, blank
// keeps. Plain identifiers render their current value in clear.
export function CredentialField({ field, currentSet, currentValue, value, onChange, onClear }) {
  const [reveal, setReveal] = useState(false);
  const isSecret = field.kind === 'secret';
  const typing = value !== undefined && value !== null && value !== '';

  const placeholder = isSecret
    ? currentSet
      ? 'Currently •••• SET — type to replace, blank keeps it'
      : field.placeholder
    : field.placeholder;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="block text-xs font-medium text-text-muted">{field.label}</label>
        {isSecret && currentSet && !typing && (
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-emerald-400">
            •••• SET
            {onClear && (
              <button
                type="button"
                onClick={onClear}
                className="ml-1 text-text-faint hover:text-danger cursor-pointer normal-case tracking-normal"
                title="Clear this credential"
              >
                Clear
              </button>
            )}
          </span>
        )}
      </div>
      <div className="relative">
        <input
          type={isSecret && !reveal ? 'password' : 'text'}
          value={isSecret ? (value ?? '') : (value ?? currentValue ?? '')}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="w-full px-3 py-2 pr-9 text-sm bg-bg-elevated border border-border-default rounded-lg
            text-text-primary placeholder:text-text-faint font-mono
            focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
        />
        {isSecret && (
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-text-faint hover:text-text-muted cursor-pointer"
            title={reveal ? 'Hide' : 'Show what you are typing'}
            tabIndex={-1}
          >
            {reveal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        )}
      </div>
    </div>
  );
}

// A muted "coming soon / TODO" scaffold panel — deliberately shows NO fake data.
export function ScaffoldPanel({ title, description, note, children }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-text-primary">{title}</h3>
        {description && <p className="mt-1 text-sm text-text-muted">{description}</p>}
      </div>
      {children}
      <div className="rounded-lg border border-dashed border-border-default bg-bg-elevated/40 px-4 py-6 text-center">
        <p className="text-sm text-text-muted">{note || 'Coming soon'}</p>
      </div>
    </div>
  );
}
