/**
 * SavedReports — the quiet chips row above the explorer controls.
 * Click loads, pencil renames inline, X deletes. Renders nothing when empty.
 *
 * The parent re-mounts this with `key={refreshKey}` after a save rather than
 * pushing a new list in through an effect: re-reading storage on mount IS the
 * synchronisation, so there is no effect that could fall out of step with disk.
 *
 * A write that did not land (quota, private mode) is SAID OUT LOUD rather than
 * reflected optimistically — a chip that renames itself on screen and reverts
 * on reload is worse than a refusal.
 */
import { useEffect, useRef, useState } from 'react';
import { Pencil, X } from 'lucide-react';
import { loadSavedReports, removeSavedReport, renameSavedReport } from './savedReportsStore';

export default function SavedReports({ onLoad }) {
  const [reports, setReports] = useState(() => loadSavedReports());
  const [renamingId, setRenamingId] = useState('');
  const [draftName, setDraftName] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (renamingId && inputRef.current) inputRef.current.focus();
  }, [renamingId]);

  const apply = ({ reports: next, ok }) => {
    setReports(next);
    setError(ok ? '' : 'Browser storage refused the change — saved reports are unchanged.');
  };

  const commitRename = () => {
    if (!renamingId) return;
    apply(renameSavedReport(renamingId, draftName));
    setRenamingId('');
  };

  if (!reports.length && !error) return null;

  return (
    <div className="space-y-1" data-testid="ax-saved-reports">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-text-faint font-semibold">
          Saved
        </span>
        {reports.map((r) => (
          <span
            key={r.id}
            className="inline-flex items-center gap-1 rounded-full border border-border-default bg-bg-card pl-3 pr-1.5 h-7 text-xs font-medium"
            data-testid={`ax-saved-chip-${r.id}`}
          >
            {renamingId === r.id ? (
              <input
                ref={inputRef}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenamingId('');
                }}
                className="bg-transparent outline-none w-28 text-text-primary"
                data-testid={`ax-saved-rename-input-${r.id}`}
              />
            ) : (
              <button
                type="button"
                onClick={() => onLoad?.(r)}
                className="hover:text-accent-text truncate max-w-[180px] cursor-pointer"
                title={r.name}
                data-testid={`ax-saved-load-${r.id}`}
              >
                {r.name}
              </button>
            )}
            <button
              type="button"
              onClick={() => { setRenamingId(r.id); setDraftName(r.name); }}
              className="grid place-items-center h-5 w-5 rounded-full text-text-muted hover:bg-bg-hover cursor-pointer"
              aria-label={`Rename ${r.name}`}
              data-testid={`ax-saved-rename-${r.id}`}
            >
              <Pencil className="h-2.5 w-2.5" />
            </button>
            <button
              type="button"
              onClick={() => apply(removeSavedReport(r.id))}
              className="grid place-items-center h-5 w-5 rounded-full text-text-muted hover:bg-bg-hover cursor-pointer"
              aria-label={`Delete ${r.name}`}
              data-testid={`ax-saved-delete-${r.id}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      {error && <p className="text-xs text-danger" data-testid="ax-saved-error">{error}</p>}
    </div>
  );
}
