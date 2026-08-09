import { Users, ShoppingCart, DollarSign, TrendingUp, RotateCcw, Percent } from 'lucide-react';
import Card from '../../../components/ui/Card';
import { fmtInt, fmtMoney, fmtRate, EM_DASH } from '../format';

function Stat({ icon: Icon, label, value, sub, tone = 'default' }) {
  const toneClass =
    tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent-text' : 'text-text-primary';
  return (
    <Card className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-text-muted">
        <Icon className="w-4 h-4" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {sub ? <div className="text-xs text-text-faint">{sub}</div> : null}
    </Card>
  );
}

export default function FunnelTotalsCards({ totals, meta }) {
  const t = totals || {};
  const currency = meta?.currency || 'USD';
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      <Stat
        icon={Users}
        label="Visitors"
        value={fmtInt(t.visitors)}
        sub={t.pageviews === null || t.pageviews === undefined ? null : `${fmtInt(t.pageviews)} pageviews`}
      />
      <Stat
        icon={ShoppingCart}
        label="Orders"
        value={fmtInt(t.orders)}
        sub={
          t.processing_sessions
            ? `${fmtInt(t.processing_sessions)} processing excluded (${fmtMoney(t.processing_amount_excluded, currency)})`
            : 'paid only'
        }
      />
      <Stat icon={Percent} label="Conv. rate" value={fmtRate(t.cvr)} sub="orders ÷ funnel visitors" />
      <Stat
        icon={DollarSign}
        label="Net revenue"
        value={fmtMoney(t.net_revenue, currency)}
        sub={`${fmtMoney(t.gross_revenue, currency)} gross`}
        tone={Number(t.net_revenue) < 0 ? 'danger' : 'default'}
      />
      <Stat
        icon={RotateCcw}
        label="Refunded"
        value={t.refunded ? `−${fmtMoney(t.refunded, currency).replace('−', '')}` : fmtMoney(t.refunded, currency)}
        sub="dated on the refund, not the order"
        tone={Number(t.refunded) > 0 ? 'danger' : 'default'}
      />
      <Stat
        icon={TrendingUp}
        label="Rev / visitor"
        value={fmtMoney(t.rev_per_visitor, currency)}
        sub={
          t.aov_post_upsell === null || t.aov_post_upsell === undefined
            ? EM_DASH
            : `AOV ${fmtMoney(t.aov_pre_upsell, currency)} → ${fmtMoney(t.aov_post_upsell, currency)}`
        }
        tone="accent"
      />
    </div>
  );
}
