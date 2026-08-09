// PaymentToastStack — sliding toasts for money moments.
//
// Port of funnel-os's PaymentToastStack.jsx onto Puure's dark tokens. The
// queue itself (cap, dedupe, auto-dismiss, hidden-tab coalescing) is in
// livePresentation + usePaymentToasts; this file is purely the picture.
//
// WHAT EACH TOAST CAN HONESTLY SAY. The brief asks for amount, product and
// location. Our wire (server/src/services/liveViewQueries.js mapCoEventRow)
// carries the AMOUNT and the currency; it does NOT carry a product name
// (co_sessions.line_items is never selected into a feed event) and does NOT
// carry a location for a purchase (co_sessions has no country column at all,
// and lb_touches.country is never joined to it). So:
//   • amount   → rendered, and a null amount renders as "amount not recorded",
//                never as $0.00 — zero is a real price.
//   • product  → the funnel + page the sale came through, which is what we
//                actually read. Naming a product would be a guess.
//   • location → rendered ONLY if the event carries a country. It does not
//                today; the line is wired so it lights up for free if a future
//                additive server field supplies one, and stays absent until
//                then rather than showing a placeholder.
import { BadgeDollarSign, Flame, X } from 'lucide-react';
import { fmtMoneyParts, fmtInt } from './livePresentation.js';
import './liveview.css';

function ToastRow({ toast, onDismiss }) {
  const upsell = toast.upsell;
  const Icon = upsell ? Flame : BadgeDollarSign;
  const money = fmtMoneyParts(toast.amount, toast.currency);

  // An aggregate with no total is NOT a $0.00 sale. Two ways it happens, and
  // each gets its own words instead of a fabricated number:
  //   • more than one currency in the batch — summing USD + JPY + EUR into
  //     "$300" produces a plausible-looking figure that is simply invented;
  //   • nothing in the batch carried a price at all.
  const aggNoTotal = toast.aggregate && money.text == null;
  const noTotalReason = toast.mixedCurrencies
    ? `mixed currencies${toast.currencies?.length ? ` (${toast.currencies.join(', ')})` : ''}`
    : 'amounts unrecorded';

  // "while you were away" is a claim about the OPERATOR, not about the data.
  // A batch that arrived in one live frame while they were watching gets
  // "just now" instead — see usePaymentToasts.pushBatch, which decides `away`
  // from document.hidden / an explicit resync flag rather than from batch size.
  const title = toast.aggregate
    ? `${fmtInt(toast.count)} ${upsell ? 'upsells' : 'payments'} ${toast.away ? 'while you were away' : 'just now'}`
    : (upsell ? 'Upsell accepted' : 'New payment');

  return (
    <li
      className={`lv-toast ${toast.exiting ? 'lv-toast--exiting' : ''} pointer-events-auto w-[300px] overflow-hidden rounded-xl border shadow-lg shadow-black/40 ${
        upsell
          ? 'border-accent/35 bg-[#16130c]'
          : 'border-success/30 bg-[#0c1410]'
      }`}
      data-testid={upsell ? 'lv-toast-upsell' : 'lv-toast-payment'}
    >
      <div className="flex items-start gap-3 p-3.5">
        <span
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
            upsell
              ? 'border-accent/35 bg-accent-muted text-accent-text'
              : 'border-success/30 bg-success/10 text-success'
          }`}
        >
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={`truncate text-[13px] font-semibold ${upsell ? 'text-accent-text' : 'text-success'}`}>
              {title}
            </span>
            <button
              type="button"
              onClick={() => onDismiss(toast.key)}
              aria-label="Dismiss"
              className="-mr-1 -mt-1 shrink-0 rounded p-1 text-text-faint transition-colors hover:text-text-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
            {money.text ? (
              <span className="lv-amount origin-left text-xl font-semibold tabular-nums text-text-primary">
                {money.text}
              </span>
            ) : aggNoTotal ? (
              // A batch we cannot total. Say WHICH reason — never $0.00.
              <span className="text-[12px] italic text-text-faint" data-testid="lv-toast-no-total">
                {noTotalReason}
              </span>
            ) : (
              // null ≠ 0. An unrecorded amount says so.
              <span className="text-[12px] italic text-text-faint">amount not recorded</span>
            )}
            {/* A real number whose UNIT we never read must not read as dollars. */}
            {money.text && !money.hasCurrency && (
              <span className="text-[10px] text-text-faint" data-testid="lv-toast-no-currency">
                currency not recorded
              </span>
            )}
            {toast.aggregate && toast.unpriced > 0 && (
              <span className="text-[10px] text-text-faint">
                {money.text ? `+${fmtInt(toast.unpriced)} unpriced` : `${fmtInt(toast.unpriced)} unpriced`}
              </span>
            )}
          </div>

          {/* The "where" line: funnel · page, and a country only if one exists. */}
          {(toast.where || toast.page || toast.countryLabel) && (
            <div className="mt-0.5 truncate text-[11px] text-text-muted">
              {toast.where}
              {toast.where && toast.page ? <span className="text-text-faint"> · </span> : null}
              {toast.page}
              {toast.countryLabel ? (
                <span className="text-text-faint"> · {toast.countryLabel}</span>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export default function PaymentToastStack({ toasts, onDismiss }) {
  // Zero events must render zero DOM — not an empty positioned container that
  // silently eats clicks in the corner of every other card on the page.
  if (!toasts || toasts.length === 0) return null;

  return (
    <ul
      className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col-reverse gap-2.5"
      aria-live="polite"
      aria-atomic="false"
      data-testid="lv-toast-stack"
    >
      {toasts.map((t) => (
        <ToastRow key={t.key} toast={t} onDismiss={onDismiss} />
      ))}
    </ul>
  );
}
