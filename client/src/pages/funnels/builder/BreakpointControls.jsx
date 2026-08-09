// PAGE BUILDER — style-tab breakpoint controls.
//
// One segmented Desktop/Mobile switch, plus the alignment presets that hang
// off the same base/mobile split.
//
// THE MODEL, in one sentence: props.style is the base, props.mobile_styles is
// an override bag with the SAME keys, and mobile reads base ← mobile. A key
// absent from mobile_styles INHERITS — which is why every mobile field shows
// the inherited value greyed out rather than an empty box. (The reference
// builder shows blanks here and operators repeatedly re-typed values that
// were already inheriting correctly.)
import { Monitor, Smartphone, AlignLeft, AlignCenter, AlignRight, AlignJustify } from 'lucide-react';
import { BREAKPOINTS, MOBILE_MAX_PX, TEXT_ALIGNS, JUSTIFY_PRESETS } from './styleUtils';

const ICONS = { desktop: Monitor, mobile: Smartphone };
const ALIGN_ICONS = {
  left: AlignLeft,
  center: AlignCenter,
  right: AlignRight,
  justify: AlignJustify,
};

const labelCls = 'block text-[10px] uppercase tracking-wider text-text-faint mb-1';

/**
 * Desktop | Mobile segmented control.
 * @param {'desktop'|'mobile'} value
 * @param {(bp: string) => void} onChange
 * @param {boolean} hasMobile — show the "this block has overrides" dot
 */
export function BreakpointSwitch({ value, onChange, hasMobile }) {
  const active = BREAKPOINTS.find((b) => b.id === value) || BREAKPOINTS[0];
  return (
    <div className="space-y-1.5">
      <label className={labelCls}>Editing for</label>
      <div className="flex rounded-lg border border-border-default overflow-hidden">
        {BREAKPOINTS.map((b) => {
          const Icon = ICONS[b.id];
          const on = value === b.id;
          return (
            <button
              key={b.id}
              onClick={() => onChange(b.id)}
              title={b.hint}
              className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium cursor-pointer transition-colors
                ${on ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-primary'}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {b.label}
              {b.id === 'mobile' && hasMobile && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-sky-400"
                  title="This block has mobile overrides"
                />
              )}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-text-faint leading-snug">
        {value === 'mobile'
          ? `Edits here apply only at ≤${MOBILE_MAX_PX}px. Empty fields inherit the desktop value.`
          : active.hint}
      </p>
    </div>
  );
}

// A banner the mobile mode shows above the fields, so an operator who
// switched breakpoints three minutes ago and got distracted cannot mistake a
// mobile edit for a global one.
export function MobileScopeNote({ onReset, overrideCount }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-sky-400/40 bg-sky-400/10 px-2.5 py-2">
      <Smartphone className="w-3.5 h-3.5 text-sky-400 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-sky-300 font-semibold leading-snug">
          Mobile overrides ({overrideCount})
        </div>
        <div className="text-[11px] text-text-faint leading-snug">
          Only what you change here is written. Everything else inherits desktop.
        </div>
      </div>
      {overrideCount > 0 && (
        <button
          onClick={onReset}
          title="Remove every mobile override on this block"
          className="text-[11px] text-text-faint hover:text-danger cursor-pointer shrink-0 underline"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/**
 * Alignment presets — text-align + flex justify, written into whichever bag
 * the active breakpoint selects (same base/mobile split as every other
 * style field).
 *
 * @param {object} style   — the RAW bag for the active breakpoint (not merged)
 * @param {object} inherit — the effective style, for showing what a blank
 *                           mobile field is inheriting
 * @param {(key: string, value: any) => void} onStyle
 * @param {boolean} isMobile
 */
export function AlignmentControls({ style, inherit, onStyle, isMobile }) {
  const s = style || {};
  const inh = inherit || {};

  const cell = (on, inherited) =>
    `h-8 rounded-md border inline-flex items-center justify-center cursor-pointer transition-colors ${
      on
        ? 'border-sky-400/70 bg-sky-400/10 text-sky-400'
        : inherited
          ? 'border-border-subtle text-text-faint/70 hover:text-text-primary'
          : 'border-border-default text-text-muted hover:text-text-primary'
    }`;

  return (
    <div className="space-y-3.5">
      <div className="pt-1 text-[10px] uppercase tracking-widest text-text-faint font-semibold">
        Alignment
      </div>

      <div>
        <label className={labelCls}>
          Text align
          {isMobile && s.text_align == null && inh.text_align && (
            <span className="ml-1.5 normal-case tracking-normal text-text-faint/80">
              inheriting {String(inh.text_align)}
            </span>
          )}
        </label>
        <div className="grid grid-cols-4 gap-1">
          {TEXT_ALIGNS.map(({ value, label }) => {
            const Icon = ALIGN_ICONS[value];
            const on = s.text_align === value;
            const inherited = !on && inh.text_align === value;
            return (
              <button
                key={value}
                title={on ? `${label} — click to clear` : label}
                // Click-to-toggle: re-clicking the active preset CLEARS it
                // rather than re-writing it, so "back to default" (and, on
                // mobile, "back to inheriting") needs no separate reset.
                onClick={() => onStyle('text_align', on ? undefined : value)}
                className={cell(on, inherited)}
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className={labelCls}>
          Justify content
          {isMobile && s.justify_content == null && inh.justify_content && (
            <span className="ml-1.5 normal-case tracking-normal text-text-faint/80">
              inheriting {String(inh.justify_content)}
            </span>
          )}
        </label>
        <div className="grid grid-cols-4 gap-1">
          {JUSTIFY_PRESETS.map(({ value, label }) => {
            const on = s.justify_content === value;
            const inherited = !on && inh.justify_content === value;
            return (
              <button
                key={value}
                title={on ? `${label} — click to clear` : label}
                onClick={() => onStyle('justify_content', on ? undefined : value)}
                className={`${cell(on, inherited)} text-[10px] font-semibold px-1`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] text-text-faint leading-snug">
          Makes the block wrapper a flex row so its children can be justified.
          Click the active preset again to clear it.
        </p>
      </div>
    </div>
  );
}
