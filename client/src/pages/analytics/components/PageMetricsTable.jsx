import { Info } from 'lucide-react';
import { fmtInt, fmtMoney, fmtRate, signClass, EM_DASH } from '../format';

const TH = ({ children, right }) => (
  <th
    className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted whitespace-nowrap ${
      right ? 'text-right' : 'text-left'
    }`}
  >
    {children}
  </th>
);

const TD = ({ children, right, className = '' }) => (
  <td className={`px-3 py-2 text-sm whitespace-nowrap ${right ? 'text-right tabular-nums' : ''} ${className}`}>
    {children}
  </td>
);

export default function PageMetricsTable({ pages = [], currency = 'USD' }) {
  if (!pages.length) {
    return (
      <div className="text-sm text-text-muted py-8 text-center">
        No pages carried traffic or revenue in this window.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] border-collapse">
        <thead>
          <tr className="border-b border-border-default">
            <TH>Page</TH>
            <TH>Type</TH>
            <TH right>Visitors</TH>
            <TH right>
              <span className="inline-flex items-center gap-1">
                CTR
                <Info className="w-3 h-3 text-text-faint" />
              </span>
            </TH>
            <TH right>CVR</TH>
            <TH right>Orders</TH>
            <TH right>Revenue</TH>
            <TH right>Refunded</TH>
            <TH right>Net</TH>
            <TH right>Rev / visitor</TH>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.page_id} className="border-b border-border-default/50 hover:bg-bg-elevated/40">
              <TD>
                <div className="font-medium text-text-primary">{p.title || p.slug || p.page_id}</div>
                {p.slug ? <div className="text-[11px] text-text-faint">/{p.slug}</div> : null}
              </TD>
              <TD>
                <span className="px-2 py-0.5 text-[11px] rounded-full border border-border-default text-text-muted capitalize">
                  {p.type || 'generic'}
                </span>
              </TD>
              <TD right>
                {fmtInt(p.visitors)}
                {p.visitors_clamped ? (
                  <span
                    className="ml-1 text-[10px] text-amber-400"
                    title={`Raw touch count was ${p.rate_conflict?.visitors_raw}; floored at submits/orders because you cannot convert without visiting.`}
                  >
                    ▲
                  </span>
                ) : null}
              </TD>
              <TD right className="text-text-muted">
                {fmtRate(p.ctr)}
                {p.ctr !== null && p.ctr !== undefined ? (
                  <span className="ml-1 text-[10px] text-text-faint" title={`proxy: ${p.ctr_basis}`}>
                    ~
                  </span>
                ) : null}
              </TD>
              <TD right>{fmtRate(p.cvr)}</TD>
              <TD right>{fmtInt(p.orders)}</TD>
              <TD right>{fmtMoney(p.gross_revenue, currency)}</TD>
              <TD right className={Number(p.refunded) > 0 ? 'text-danger' : 'text-text-muted'}>
                {Number(p.refunded) > 0 ? `−${fmtMoney(p.refunded, currency)}` : fmtMoney(p.refunded, currency)}
              </TD>
              <TD right className={signClass(p.net_revenue)}>
                {fmtMoney(p.net_revenue, currency)}
              </TD>
              <TD right className="font-medium text-accent-text">
                {fmtMoney(p.rev_per_visitor, currency)}
              </TD>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-[11px] text-text-faint leading-relaxed">
        <span className="text-text-muted">CTR is a proxy (~).</span> Puure emits no click-through event, so this is the
        larger of the step-through rate and the checkout-submit rate — a lower bound on the true forward-action rate.
        {' '}Withheld ({EM_DASH}) below 30 visitors. Revenue counts paid sessions only; refunds are dated on the refund,
        not on the order.
      </p>
    </div>
  );
}
