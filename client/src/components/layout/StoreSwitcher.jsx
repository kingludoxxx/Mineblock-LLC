// W6 / W6b — the store switcher in the sidebar's top-left brand block.
//
// It IS the brand block: the same logo, the same height, the same border; a chevron appears only when there is
// somewhere to go. With no hub, or an empty store list, it renders the brand block exactly as it was before
// this file existed (R21: a store with no hub behind it must look untouched, never broken).
//
// W6b, from Ludo's reference: one row per store — the NAME on the left, a small uppercase ROLE pill on the
// right, a check before the store you are in. A store whose single sign-on is not armed yet is SHOWN, greyed,
// with a "not connected" pill and no link: the operator can see their store exists and why they cannot enter
// it, instead of the store silently missing from the list. The footer is one hairline, then "New store", then
// a quieter "Manage stores".
//
// Every class here is the sidebar's own language: rounded-md rows, text-text-muted -> text-text-primary on
// hover:bg-bg-hover, the gold accent for what is current, bg-bg-hover for a pill. Nothing new visually.
//
// WORDING: "store", never "workspace" (Ludo's vocabulary; the rest of this app says store too).
//
// R5/R15: no store name, code or url is written here. The list arrives from the server (useStoreSwitcher).
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Plus, Settings2 } from 'lucide-react';
import { useBrand } from '../../hooks/useBrand';
import { useStoreSwitcher, switchUrl, addStoreUrl, manageStoresUrl } from '../../hooks/useStoreSwitcher';

const ROW = 'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm text-left transition-colors';
const ROW_IDLE = 'text-text-muted hover:text-text-primary hover:bg-bg-hover';
const ROW_CURRENT = 'bg-accent-muted text-accent-text font-semibold border border-accent/20';
// A store that cannot be entered: the sidebar's muted text, dimmed, and no pointer affordance at all.
const ROW_OFF = 'text-text-muted opacity-45 cursor-default';
const PILL = 'shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider';
const PILL_ROLE = `${PILL} bg-bg-hover text-text-muted`;
const PILL_OFF = `${PILL} bg-bg-hover text-text-faint`;

/** Why a greyed row is greyed. Shown as the row's title so hovering explains it without a second surface. */
export const NOT_CONNECTED_TITLE = 'Single sign-on is not enabled for this store yet';
export const NOT_CONNECTED_PILL = 'not connected';

/**
 * W8a — the store's mark, WITHOUT assuming the store has an image.
 *
 * A store provisioned by the hub gets BRAND_NAME / BRAND_SHORT_NAME and no
 * BRAND_LOGO_*, so `logoWhite` / `logoSymbol` arrive null. Before this, the
 * per-field fallback in config/brand.js filled those nulls with the bundled
 * images of one particular store and every new store wore that store's
 * wordmark. Now:
 *
 *   logo present -> the image, exactly as before (the VITE_BRAND_* / BRAND_*
 *                   path an existing store ships is untouched)
 *   logo absent  -> a NEUTRAL text wordmark: the store's own short name in the
 *                   sidebar's own type. Collapsed, where there is no room for
 *                   a name, the small rounded initial square the menu rows use.
 *
 * No image element is rendered in the no-logo case at all: a null `src` is a
 * request for the current page and paints a broken-image glyph.
 */
export const INITIAL_SQUARE =
  'shrink-0 w-5 h-5 rounded-md bg-bg-hover border border-border-subtle flex items-center justify-center '
  + 'text-[10px] font-semibold uppercase text-text-muted';

/** First character of the store's short name, or a dot when there is nothing to take. */
const initialOf = (name) => {
  const c = String(name || '').trim().charAt(0);
  return c ? c.toUpperCase() : '\u00b7';
};

function BrandMark({ collapsed, brand }) {
  const logo = collapsed ? brand.logoSymbol : brand.logoWhite;
  const label = brand.shortName;

  if (logo) {
    return <img src={logo} alt={label} className={collapsed ? 'h-4 w-auto' : 'h-5 w-auto'} data-testid="brand-logo" />;
  }
  if (collapsed) {
    return <span className={INITIAL_SQUARE} data-testid="brand-initial" aria-label={label} title={label}>{initialOf(label)}</span>;
  }
  return (
    <span className="flex items-center gap-2 min-w-0" data-testid="brand-wordmark">
      <span className={INITIAL_SQUARE} aria-hidden="true">{initialOf(label)}</span>
      <span className="truncate text-sm font-semibold tracking-tight text-text-primary" data-testid="brand-wordmark-name">{label}</span>
    </span>
  );
}

/** The check slot. Always rendered, so every name starts at the same x whether or not it is the current store. */
function CurrentMark({ current }) {
  return (
    <span className="shrink-0 w-3.5 h-3.5 flex items-center justify-center" aria-hidden="true">
      {current ? <Check className="w-3.5 h-3.5 text-accent" /> : null}
    </span>
  );
}

export default function StoreSwitcher({ collapsed }) {
  const { enabled, hubOrigin, current, stores } = useStoreSwitcher();
  const brand = useBrand();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const itemRefs = useRef([]);

  // The number of focusable rows: every store (a greyed one included — it is readable, it is just not a link),
  // then New store and Manage stores. Unchanged from W6, which is what keeps the keyboard walk unchanged.
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
        <BrandMark collapsed={collapsed} brand={brand} />
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
        <BrandMark collapsed={collapsed} brand={brand} />
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Stores"
          onKeyDown={onMenuKeyDown}
          data-testid="store-switcher-menu"
          className="absolute left-0 top-full mt-1.5 z-40 w-60 max-w-[calc(100vw-1.5rem)] p-1
            bg-bg-elevated border border-border-default rounded-lg shadow-xl"
        >
          <div className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-text-faint">Stores</div>
          {stores.map((s, i) => {
            const isCurrent = s.code === current;
            const ref = (el) => { itemRefs.current[i] = el; };

            // A store whose SSO door is not open yet: same row, greyed, NOT a link. Rendering it as a <span>
            // (not a disabled <a>) is what makes a click do nothing at all — there is no href to follow.
            if (!s.can_hop) {
              return (
                <span
                  key={s.code}
                  ref={ref}
                  role="menuitem"
                  aria-disabled="true"
                  data-store-code={s.code}
                  data-can-hop="false"
                  title={NOT_CONNECTED_TITLE}
                  tabIndex={-1}
                  className={`${ROW} ${ROW_OFF}`}
                >
                  <CurrentMark current={isCurrent} />
                  <span className="flex-1 truncate">{s.name}</span>
                  <span className={PILL_OFF} data-testid="store-pill">{NOT_CONNECTED_PILL}</span>
                </span>
              );
            }

            return (
              <a
                key={s.code}
                ref={ref}
                role="menuitem"
                target="_top"
                href={switchUrl(hubOrigin, s.code)}
                data-store-code={s.code}
                data-can-hop="true"
                aria-current={isCurrent ? 'true' : undefined}
                tabIndex={-1}
                className={`${ROW} ${isCurrent ? ROW_CURRENT : ROW_IDLE}`}
              >
                <CurrentMark current={isCurrent} />
                <span className="flex-1 truncate">{s.name}</span>
                {s.role ? <span className={PILL_ROLE} data-testid="store-pill">{s.role}</span> : null}
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
            <span>New store</span>
          </a>
          <a
            ref={(el) => { itemRefs.current[stores.length + 1] = el; }}
            role="menuitem"
            target="_top"
            href={manageStoresUrl(hubOrigin)}
            data-testid="manage-stores"
            tabIndex={-1}
            className={`${ROW} text-xs text-text-faint hover:text-text-muted hover:bg-bg-hover`}
          >
            <Settings2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>Manage stores</span>
          </a>
        </div>
      )}
    </div>
  );
}
