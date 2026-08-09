// Domain Hub — shared bits (status pill, copy button, empty state, confirm
// modal). Kept in the domains/ folder so the lane stays module-only.
import { useState } from 'react';
import { Check, Copy, Globe } from 'lucide-react';
import Button from '../../components/ui/Button';

export const STATUS_STYLES = {
  connected: 'bg-green-500/10 text-green-400 border-green-500/20',
  verifying: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  pending_dns: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  error: 'bg-danger/10 text-danger border-danger/20',
};

export const STATUS_LABELS = {
  connected: 'Connected',
  verifying: 'Verifying',
  pending_dns: 'Pending DNS',
  error: 'Error',
};

export function DomainStatusPill({ status }) {
  return (
    <span
      className={`px-2 py-0.5 text-[11px] rounded-full border whitespace-nowrap ${
        STATUS_STYLES[status] || 'bg-bg-elevated text-text-muted border-border-default'
      }`}
    >
      {STATUS_LABELS[status] || status || '—'}
    </span>
  );
}

export function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(String(value));
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch { /* clipboard unavailable — nothing to break */ }
      }}
      className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer"
    >
      {copied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
    </button>
  );
}

export function EmptyState({ title, hint, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-12 h-12 rounded-full bg-bg-elevated border border-border-default flex items-center justify-center mb-3">
        <Globe size={20} className="text-text-muted" />
      </div>
      <p className="text-sm font-medium text-text-primary">{title}</p>
      {hint && <p className="text-xs text-text-muted mt-1 max-w-sm">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Generic confirm modal — used for the real-money Buy gate and detach. */
export function ConfirmModal({
  title, body, confirmLabel, danger = false, requireText = null,
  onConfirm, onClose, busy = false,
}) {
  const [typed, setTyped] = useState('');
  const blocked = requireText ? typed !== requireText : false;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md bg-bg-card border border-border-default rounded-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-text-primary mb-2">{title}</h3>
        <div className="text-sm text-text-muted space-y-2 mb-4">{body}</div>
        {requireText && (
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={`Type ${requireText} to confirm`}
            className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 mb-4"
          />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            size="sm"
            loading={busy}
            disabled={blocked}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
