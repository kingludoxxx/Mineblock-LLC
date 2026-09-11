// W6 — the store switcher in the sidebar's top-left brand block.
//
// It IS the brand block: the same logo, the same height, the same border; a chevron appears only when there is
// somewhere to go. With no hub, or an empty store list, it renders the brand block exactly as it was before
// this file existed (R21: a store with no hub behind it must look untouched, never broken).
//
// Every row uses the sidebar's own item language: rounded-md, text-text-muted -> text-text-primary on
// hover:bg-bg-hover, the gold accent for what is current. Nothing new visually.
//
// R5/R15: no store name, code or url is written here. The list arrives from the server (useStoreSwitcher).
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Plus, Settings2 } from 'lucide-react';
import { BRAND_SHORT_NAME, BRAND_LOGO_WHITE, BRAND_LOGO_SYMBOL } from '../../config/brand';
import { useStoreSwitcher, switchUrl, addStoreUrl, manageStoresUrl } from '../../hooks/useStoreSwitcher';

const ROW = 'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm text-left transition-colors';
const ROW_IDLE = 'text-text-muted hover:text-text-primary hover:bg-bg-hover';
const ROW_CURRENT = 'bg-accent-muted text-accent-text font-semibold border border-accent/20';

/** The little rounded square that stands in for a store, the same shape the sidebar uses for its icons. */
function StoreMark({ code, current }) {
  return (
    <span
      aria-hidden="true"
      className={`shrink-0 w-5 h-5 rounded flex items-center justify-center text-[10px] font-semibold
        ${current ? 'bg-accent/20 text-accent-text' : 'bg-bg-hover text-text-muted'}`}
    >
      {String(code || '?').slice(0, 1)}
    </span>
  );
}

function BrandMark({ collapsed }) {
  return collapsed
    ? <img src={BRAND_LOGO_SYMBOL} alt={BRAND_SHORT_NAME} className="h-4 w-auto" />
    : <img src={BRAND_LOGO_WHITE} alt={BRAND_SHORT_NAME} className="h-5 w-auto" />;
}

export default function StoreSwitcher({ collapsed }) {
  const { enabled, hubOrigin, current, stores } = useStoreSwitcher();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const itemRefs = useRef([]);

  // The number of focusable rows: every store, then Add store and Manage stores.
  const count = stores.length + 2;

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); } };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onKey); };
  }, [open]);

  useEffect(() => { if (open) itemRefs.current[focus]?.focus(); }, [open, focus]);

  // No hub, or nothing to switch into: the block this component replaced, unchanged (R21).
  if (!enabled) {
    return (
      <div className="flex items-center gap-2.5" data-testid="brand-block">
        <BrandMark collapsed={collapsed} />
      </div>
    );
  }

  const move = (delta) => setFocus((i) => (i + delta + count) % count);
  const onMenuKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setFocus(0); }
    else if (e.key === 'End') { e.preventDefault(); setFocus(count - 1); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="relative" ref={wrapRef} data-testid="store-switcher">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => { setOpen((v) => !v); setFocus(Math.max(0, stores.findIndex((s) => s.code === current))); }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch store"
        title={collapsed ? 'Switch store' : undefined}
        data-testid="store-switcher-button"
        className={`flex items-center gap-2 rounded-md px-1.5 py-1 -ml-1.5 text-text-muted
          hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer ${collapsed ? 'justify-center' : ''}`}
      >
        <BrandMark collapsed={collapsed} />
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Stores"
          onKeyDown={onMenuKeyDown}
          data-testid="store-switcher-menu"
          className="absolute left-0 top-full mt-1.5 z-40 w-56 max-w-[calc(100vw-1.5rem)] p-1
            bg-bg-elevated border border-border-default rounded-lg shadow-xl"
        >
          <div className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-text-faint">Stores</div>
          {stores.map((s, i) => {
            const isCurrent = s.code === current;
            return (
              <a
                key={s.code}
                ref={(el) => { itemRefs.current[i] = el; }}
                role="menuitem"
                target="_top"
                href={switchUrl(hubOrigin, s.code)}
                data-store-code={s.code}
                aria-current={isCurrent ? 'true' : undefined}
                tabIndex={-1}
                className={`${ROW} ${isCurrent ? ROW_CURRENT : ROW_IDLE}`}
              >
                <StoreMark code={s.code} current={isCurrent} />
                <span className="flex-1 truncate">{s.name}</span>
                {isCurrent && <Check className="w-3.5 h-3.5 shrink-0 text-accent" aria-hidden="true" />}
              </a>
            );
          })}

          <div className="my-1 border-t border-border-subtle" />

          <a
            ref={(el) => { itemRefs.current[stores.length] = el; }}
            role="menuitem"
            target="_top"
            href={addStoreUrl(hubOrigin)}
            data-testid="add-store"
            tabIndex={-1}
            className={`${ROW} ${ROW_IDLE}`}
          >
            <Plus className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Add store</span>
          </a>
          <a
            ref={(el) => { itemRefs.current[stores.length + 1] = el; }}
            role="menuitem"
            target="_top"
            href={manageStoresUrl(hubOrigin)}
            data-testid="manage-stores"
            tabIndex={-1}
            className={`${ROW} ${ROW_IDLE}`}
          >
            <Settings2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Manage stores</span>
          </a>
        </div>
      )}
    </div>
  );
}
