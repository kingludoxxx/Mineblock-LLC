import { AlertTriangle, Trophy, Hourglass, Minus } from 'lucide-react';
import Card from '../../../components/ui/Card';
import { fmtInt, fmtMoney, fmtRate, fmtPct, fmtDate, liftClass, EM_DASH } from '../format';

function VerdictBanner({ verdict, currency }) {
  if (!verdict) return null;
  const { status, headline } = verdict;
  const tone =
    status === 'winner'
      ? { cls: 'border-green-500/30 bg-green-500/5 text-green-400', Icon: Trophy }
      : status === 'not_ready'
        ? { cls: 'border-amber-500/30 bg-amber-500/5 text-amber-400', Icon: Hourglass }
        : { cls: 'border-border-default bg-bg-elevated text-text-muted', Icon: Minus };
  const { cls, Icon } = tone;
  const conf = verdict.revenue?.confidence;
  return (
    <div className={`rounded-xl border px-4 py-3.5 flex items-start gap-3 ${cls}`}>
      <Icon className="w-5 h-5 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <div className="text-sm font-medium leading-snug">{headline}</div>
        <div className="mt-1 text-[11px] text-text-faint flex flex-wrap gap-x-4 gap-y-1">
          <span>Ranked on net revenue per visitor</span>
          {conf !== null && conf !== undefined ? <span>Confidence {fmtRate(conf, 1)}</span> : null}
          {verdict.sample ? (
            <span>
              {verdict.sample.ready ? 'Sample ready' : 'Sample thin'} · α adjusted to{' '}
              {verdict.sample.alphaAdjusted} over {verdict.sample.comparisons} comparison
              {verdict.sample.comparisons === 1 ? '' : 's'}
            </span>
          ) : null}
          {verdict.requiredSamplePerArm ? (
            <span>~{fmtInt(verdict.requiredSamplePerArm)} visitors/arm needed</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Disclosure({ disclosure, window: win }) {
  if (!disclosure) return null;
  const warn = disclosure.tracking_started_after_test;
  return (
    <div className="space-y-2">
      {warn ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 flex gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-[12px] text-amber-200/90 leading-relaxed">
            <strong className="font-medium">Tracking started after this test did.</strong> Test created{' '}
            {fmtDate(disclosure.test_created_at)}; first recorded touch {fmtDate(disclosure.tracking_started_at)}.
            Exposures before the tracking start were never recorded — they are missing, not zero, so the sample starts
            later than the test does.
          </div>
        </div>
      ) : null}
      <p className="text-[11px] text-text-faint leading-relaxed">
        <span className="text-text-muted">Only this window</span> ({win?.from} → {win?.to}, {win?.days}d, UTC).
        {' '}Arms that started at different times are not comparable across a window they do not both span.
        {' '}<span className="text-text-muted">Visitors = split exposures</span>, written at checkout-session mint, not
        at page serve — this counts visitors who reached checkout, not page traffic. Every arm is understated by the
        same mechanism, so the comparison holds; the absolute figure is not page traffic.
      </p>
    </div>
  );
}

const RowLabel = ({ children, sub, emphasis }) => (
  <th
    className={`px-3 py-2 text-left text-sm font-normal whitespace-nowrap sticky left-0 bg-bg-card ${
      emphasis ? 'text-text-primary font-medium' : 'text-text-muted'
    }`}
  >
    {children}
    {sub ? <div className="text-[10px] text-text-faint font-normal">{sub}</div> : null}
  </th>
);

export default function SplitResultsPanel({ data }) {
  if (!data) return null;
  if (data.error) {
    return <Card className="text-sm text-danger">Could not load split results: {data.error}</Card>;
  }
  const currency = data.meta?.currency || 'USD';
  const order = data.verdict?.ranked || [];
  // Ranked on net revenue per visitor — the column order IS the ranking.
  const arms = [...(data.arms || [])].sort((a, b) => {
    const ia = order.indexOf(a.arm_key);
    const ib = order.indexOf(b.arm_key);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  if (!arms.length) return <Card className="text-sm text-text-muted">This test has no arms yet.</Card>;

  const leader = data.verdict?.leader;
  const conf = data.verdict?.revenue?.confidence;
  const convConf = data.verdict?.conversion?.confidence;

  // Rows are metrics, columns are arms — matching the operator's reference report.
  const rows = [
    { label: 'Visitors', get: (a) => fmtInt(a.visitors) },
    { label: 'Submits', sub: 'checkout sessions minted', get: (a) => `${fmtInt(a.submits)} · ${fmtRate(a.submit_rate)}` },
    { label: 'Orders', get: (a) => fmtInt(a.orders) },
    { label: 'Conv. rate', get: (a) => fmtRate(a.cvr, 2) },
    { label: 'AOV pre-upsell', get: (a) => fmtMoney(a.aov_pre_upsell, currency) },
    {
      label: 'Upsell sales',
      sub: 'legs · buyers',
      get: (a) => `${fmtInt(a.upsell_legs)} · ${fmtInt(a.upsell_buyers)}`,
    },
    { label: 'Upsell revenue', get: (a) => fmtMoney(a.upsell_revenue, currency) },
    { label: 'AOV post-upsell', emphasis: true, get: (a) => fmtMoney(a.aov_post_upsell, currency) },
    { label: 'Revenue', sub: 'gross', get: (a) => fmtMoney(a.gross_revenue, currency) },
    {
      label: 'Refunded',
      danger: true,
      get: (a) => (Number(a.refunded) > 0 ? `−${fmtMoney(a.refunded, currency)}` : fmtMoney(a.refunded, currency)),
    },
    { label: 'Net revenue', get: (a) => fmtMoney(a.net_revenue, currency) },
    { label: 'Rev / visitor', emphasis: true, sub: 'the ranking metric', get: (a) => fmtMoney(a.rev_per_visitor, currency) },
    {
      label: 'vs control',
      lift: true,
      get: (a) => (a.is_control ? 'control' : fmtPct(a.vs_control_rpv_pct)),
    },
    {
      label: 'Confidence',
      emphasis: true,
      sub: 'rev / visitor',
      get: (a) => (a.is_control ? EM_DASH : conf === null || conf === undefined ? EM_DASH : fmtRate(conf, 1)),
    },
    {
      label: 'Conv. confidence',
      get: (a) => (a.is_control ? EM_DASH : convConf === null || convConf === undefined ? EM_DASH : fmtRate(convConf, 1)),
    },
    {
      label: 'Sample',
      get: (a) =>
        a.visitors >= 300 && a.orders >= 25 ? (
          <span className="text-green-400">ready</span>
        ) : (
          <span className="text-amber-400">thin</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <VerdictBanner verdict={data.verdict} currency={currency} />
      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border-default">
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted sticky left-0 bg-bg-card">
                  Metric
                </th>
                {arms.map((a) => (
                  <th
                    key={a.arm_key}
                    className={`px-3 py-2.5 text-right text-sm font-semibold whitespace-nowrap ${
                      a.arm_key === leader ? 'text-green-400' : 'text-text-primary'
                    }`}
                  >
                    <span className="uppercase">{a.arm_key}</span>
                    {a.is_control ? (
                      <span className="ml-1.5 text-[10px] font-normal text-text-faint">control</span>
                    ) : null}
                    {a.arm_key === leader && data.verdict?.status === 'winner' ? (
                      <Trophy className="inline-block w-3.5 h-3.5 ml-1.5 -mt-0.5" />
                    ) : null}
                    {a.archived ? (
                      <span className="ml-1.5 text-[10px] font-normal text-amber-400">archived</span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.label}
                  className={`border-b border-border-default/50 ${r.emphasis ? 'bg-bg-elevated/50' : ''}`}
                >
                  <RowLabel sub={r.sub} emphasis={r.emphasis}>
                    {r.label}
                  </RowLabel>
                  {arms.map((a) => {
                    const v = r.get(a);
                    const cls = r.danger
                      ? Number(a.refunded) > 0
                        ? 'text-danger'
                        : 'text-text-muted'
                      : r.lift
                        ? liftClass(a.is_control ? null : a.vs_control_rpv_pct)
                        : r.emphasis
                          ? 'text-text-primary font-medium'
                          : 'text-text-primary';
                    return (
                      <td
                        key={a.arm_key}
                        className={`px-3 py-2 text-sm text-right tabular-nums whitespace-nowrap ${cls}`}
                      >
                        {v}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Disclosure disclosure={data.disclosure} window={data.window} />
      {data.ledger ? (
        <details className="text-[11px] text-text-faint">
          <summary className="cursor-pointer text-text-muted hover:text-text-primary">
            Credits-ledger reconciliation (all-time, arm-attributed)
          </summary>
          <div className="mt-2 space-y-1 pl-3 border-l border-border-default">
            {data.ledger.arms?.map((a) => (
              <div key={a.arm_key}>
                <span className="uppercase text-text-muted">{a.arm_key}</span>: {fmtInt(a.exposures)} exposures ·{' '}
                {fmtInt(a.conversions)} conversions · {fmtInt(a.credited_legs)} legs ·{' '}
                {fmtMoney(a.net_revenue, currency)} net
              </div>
            ))}
            <div className="pt-1 text-text-faint">
              The ledger answers a different question than the table above (money the ledger attributed to an arm,
              all-time) and is shown for reconciliation, not blended into it.
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}
