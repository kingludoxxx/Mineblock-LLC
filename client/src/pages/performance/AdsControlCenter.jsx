import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../services/api';
import DatePicker from '../../components/ui/DatePicker';
import {
  Zap,
  RefreshCw,
  Shield,
  Plus,
  Activity,
  Sparkles,
  Pencil,
  Copy,
  Trash2,
  X,
  Clock,
  AlertTriangle,
  PauseCircle,
  Eye,
  Target,
  Settings,
  Radio,
  Hash,
  ArrowUpRight,
  ArrowDownRight,
  Gauge,
  ShieldCheck,
  Timer,
  Play,
} from 'lucide-react';

// ── Helpers ─────────────────────────────────────────────────────────────────

const fmtMoney = (n) =>
  '$' +
  Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtPct = (n) => Number(n || 0).toFixed(1) + '%';

const fmtInt = (n) => Number(n || 0).toLocaleString();

const todayStr = () => new Date().toISOString().slice(0, 10);

function timeAgo(date) {
  if (!date) return 'Never';
  const now = Date.now();
  const then = new Date(date).getTime();
  if (isNaN(then)) return 'Unknown';
  const rawDiff = now - then;
  const isFuture = rawDiff < 0;
  const diff = Math.abs(rawDiff);
  const suffix = isFuture ? 'from now' : 'ago';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return isFuture ? 'in < 1 min' : `${sec}s ${suffix}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ${suffix}`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${suffix}`;
  const d = Math.floor(hr / 24);
  return `${d}d ${suffix}`;
}

function formatAction(rule) {
  if (!rule) return '';
  const a = rule.action;
  const v = rule.action_value;
  const map = {
    pause_ad: 'Pause Ad',
    resume_ad: 'Resume Ad',
    increase_budget_pct: `Increase Budget by ${v || 0}%`,
    decrease_budget_pct: `Decrease Budget by ${v || 0}%`,
    increase_budget_fixed: `Increase Budget by ${fmtMoney(v)}`,
    decrease_budget_fixed: `Decrease Budget by ${fmtMoney(v)}`,
    send_alert: 'Send Alert',
    flag_promising: 'Flag as Promising',
  };
  return map[a] || a;
}

function formatConditions(conditions, logicOperator) {
  if (!Array.isArray(conditions) || conditions.length === 0) return 'No conditions';
  const opMap = { '>': '>', '<': '<', '>=': '\u2265', '<=': '\u2264', '=': '=' };
  const metricLabels = {
    spend: 'Spend',
    purchases: 'Purchases',
    roas: 'ROAS',
    cpa: 'CPA',
    ctr: 'CTR',
    cpc: 'CPC',
    revenue: 'Revenue',
    conversion_rate: 'Conv Rate',
  };
  const moneyMetrics = new Set(['spend', 'cpa', 'cpc', 'revenue']);
  const pctMetrics = new Set(['ctr', 'conversion_rate']);
  return conditions
    .map((c) => {
      const label = metricLabels[c.metric] || c.metric;
      const op = opMap[c.operator] || c.operator;
      let val = c.value;
      if (moneyMetrics.has(c.metric)) val = fmtMoney(c.value);
      else if (pctMetrics.has(c.metric)) val = fmtPct(c.value);
      else if (c.metric === 'roas') val = `${Number(c.value).toFixed(1)}x`;
      return `${label} ${op} ${val}`;
    })
    .join(` ${(logicOperator || 'AND').toUpperCase()} `);
}

const timeWindowLabels = {
  today: 'Today',
  yesterday: 'Yesterday',
  last_3_days: 'Last 3 Days',
  last_7_days: 'Last 7 Days',
  last_14_days: 'Last 14 Days',
  last_30_days: 'Last 30 Days',
};

const actionColors = {
  pause_ad: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
  resume_ad: { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/30' },
  increase_budget_pct: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
  decrease_budget_pct: { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/30' },
  increase_budget_fixed: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
  decrease_budget_fixed: { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/30' },
  send_alert: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
  flag_promising: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
};

const ruleTypeBadge = {
  kill: { bg: 'bg-red-500/15', text: 'text-red-400', label: 'Kill' },
  scale: { bg: 'bg-blue-500/15', text: 'text-blue-400', label: 'Scale' },
  alert: { bg: 'bg-amber-500/15', text: 'text-amber-400', label: 'Alert' },
  protect: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', label: 'Protect' },
};

const statusBadges = {
  success: { bg: 'bg-green-500/15', text: 'text-green-400', label: 'Executed' },
  failed: { bg: 'bg-red-500/15', text: 'text-red-400', label: 'Failed' },
  error: { bg: 'bg-red-500/15', text: 'text-red-400', label: 'Error' },
  dry_run: { bg: 'bg-amber-500/15', text: 'text-amber-400', label: 'Dry Run' },
  skipped: { bg: 'bg-white/[0.06]', text: 'text-white/40', label: 'Skipped' },
};

const feedBorderColors = {
  pause_ad: 'border-l-red-500',
  resume_ad: 'border-l-green-500',
  increase_budget_pct: 'border-l-blue-500',
  decrease_budget_pct: 'border-l-orange-500',
  increase_budget_fixed: 'border-l-blue-500',
  decrease_budget_fixed: 'border-l-orange-500',
  send_alert: 'border-l-amber-500',
  flag_promising: 'border-l-emerald-500',
};

const feedIcons = {
  pause_ad: PauseCircle,
  resume_ad: Play,
  increase_budget_pct: ArrowUpRight,
  decrease_budget_pct: ArrowDownRight,
  increase_budget_fixed: ArrowUpRight,
  decrease_budget_fixed: ArrowDownRight,
  send_alert: AlertTriangle,
  flag_promising: Sparkles,
};

const cardGlass = 'bg-white/[0.02] border border-white/[0.06] backdrop-blur-sm rounded-2xl';

// ── Skeleton ────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }) {
  return <div className={`animate-pulse bg-white/[0.04] rounded-xl ${className}`} />;
}

function SkeletonCards({ count = 3, className = 'h-40' }) {
  return Array.from({ length: count }, (_, i) => (
    <Skeleton key={i} className={className} />
  ));
}

// ── Toggle Switch ───────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange?.(!checked);
      }}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none cursor-pointer ${
        checked ? 'bg-green-500' : 'bg-white/10'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}

// ── KPI Stat Card ───────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, accent = 'blue', loading }) {
  const accents = {
    blue: 'text-blue-400 bg-blue-500/10',
    green: 'text-green-400 bg-green-500/10',
    red: 'text-red-400 bg-red-500/10',
    amber: 'text-amber-400 bg-amber-500/10',
    orange: 'text-orange-400 bg-orange-500/10',
    purple: 'text-purple-400 bg-purple-500/10',
    emerald: 'text-emerald-400 bg-emerald-500/10',
    cyan: 'text-cyan-400 bg-cyan-500/10',
  };
  const [iconColor, iconBg] = (accents[accent] || accents.blue).split(' ');
  if (loading) return <Skeleton className="h-[76px]" />;
  return (
    <div className={`${cardGlass} p-3 flex flex-col gap-1`}>
      <div className="flex items-center gap-2">
        <div className={`w-6 h-6 rounded-md flex items-center justify-center ${iconBg}`}>
          <Icon size={13} className={iconColor} />
        </div>
        <span className="text-[11px] text-white/40 uppercase tracking-wider leading-none">{label}</span>
      </div>
      <div className="text-lg font-semibold text-white pl-8">{value}</div>
    </div>
  );
}

// ── Rule Card ───────────────────────────────────────────────────────────────

function RuleCard({ rule, onToggle, onEdit, onDuplicate, onDelete }) {
  const badge = ruleTypeBadge[rule.rule_type] || ruleTypeBadge.alert;
  return (
    <div className={`${cardGlass} p-4 flex flex-col gap-3 group hover:border-white/[0.12] transition-colors`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-white truncate">{rule.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium ${badge.bg} ${badge.text}`}>
              {badge.label}
            </span>
            {rule.dry_run && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium bg-amber-500/15 text-amber-400">
                DRY RUN
              </span>
            )}
          </div>
          {rule.description && (
            <p className="text-xs text-white/30 line-clamp-1">{rule.description}</p>
          )}
        </div>
        <Toggle checked={rule.enabled} onChange={() => onToggle(rule)} />
      </div>

      {/* Conditions */}
      <div className="bg-white/[0.02] rounded-lg px-3 py-2 border border-white/[0.04]">
        <p className="text-xs text-white/50 leading-relaxed">
          <span className="text-white/20 mr-1">When</span>
          {formatConditions(rule.conditions, rule.logic_operator)}
        </p>
        <p className="text-xs mt-1">
          <span className="text-white/20">{'\u2192'} </span>
          <span className={`font-medium ${(actionColors[rule.action] || actionColors.send_alert).text}`}>
            {formatAction(rule)}
          </span>
        </p>
      </div>

      {/* Meta row */}
      <div className="flex items-center justify-between text-[11px] text-white/25">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <Hash size={10} /> {rule.times_triggered || 0} triggered
          </span>
          <span className="flex items-center gap-1">
            <Clock size={10} /> {rule.last_triggered_at ? timeAgo(rule.last_triggered_at) : 'Never'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span>{rule.cooldown_minutes}m cooldown</span>
          <span>P{rule.priority}</span>
        </div>
      </div>

      {/* Source badge */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.03] border border-white/[0.06] text-white/30">
          TW {'\u{1F433}'} Triple Whale
        </span>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onEdit(rule)}
            className="p-1.5 rounded-lg hover:bg-white/[0.06] text-white/30 hover:text-white/60 transition-colors cursor-pointer"
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={() => onDuplicate(rule)}
            className="p-1.5 rounded-lg hover:bg-white/[0.06] text-white/30 hover:text-white/60 transition-colors cursor-pointer"
          >
            <Copy size={13} />
          </button>
          <button
            onClick={() => onDelete(rule)}
            className="p-1.5 rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-400 transition-colors cursor-pointer"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Activity Entry ──────────────────────────────────────────────────────────

function ActivityEntry({ entry }) {
  const borderColor = feedBorderColors[entry.action] || 'border-l-white/20';
  const FeedIcon = feedIcons[entry.action] || Activity;
  const ac = actionColors[entry.action] || actionColors.send_alert;
  const sb = statusBadges[entry.execution_status] || statusBadges.success;
  const snap = entry.metrics_snapshot || {};

  return (
    <div className={`border-l-2 ${borderColor} pl-3 py-2.5 hover:bg-white/[0.01] transition-colors`}>
      <div className="flex items-start gap-2">
        <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5 ${ac.bg}`}>
          <FeedIcon size={12} className={ac.text} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-white truncate max-w-[180px]">
              {entry.ad_name || 'Unknown Ad'}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium ${ac.bg} ${ac.text}`}>
              {(entry.action || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium ${sb.bg} ${sb.text}`}>
              {sb.label}
            </span>
          </div>
          {entry.reason && (
            <p className="text-xs text-white/35 mt-0.5 line-clamp-1">{entry.reason}</p>
          )}
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-white/25 flex-wrap">
            {snap.spend != null && <span>Spend {fmtMoney(snap.spend)}</span>}
            {snap.roas != null && <span>ROAS {Number(snap.roas).toFixed(1)}x</span>}
            {snap.cpa != null && <span>CPA {fmtMoney(snap.cpa)}</span>}
            {snap.purchases != null && <span>Purchases {snap.purchases}</span>}
          </div>
          <div className="flex items-center gap-2 mt-1 text-[10px] text-white/20">
            {entry.account_name && <span>{entry.account_name}</span>}
            {entry.account_name && <span className="text-white/10">{'\u00B7'}</span>}
            <span>{timeAgo(entry.created_at)}</span>
            {entry.rule_name && (
              <>
                <span className="text-white/10">{'\u00B7'}</span>
                <span className="text-white/15">via {entry.rule_name}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Promising Ad Card ───────────────────────────────────────────────────────

function PromisingAdCard({ ad }) {
  const suggestionColors = {
    monitor: 'bg-cyan-500/10 text-cyan-400',
    scale: 'bg-blue-500/10 text-blue-400',
    increase_budget: 'bg-green-500/10 text-green-400',
  };
  const suggestionColor = suggestionColors[ad.suggested_action] || suggestionColors.monitor;

  return (
    <div className="py-2.5 border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.01] transition-colors px-1">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white truncate">{ad.ad_name || ad.name}</p>
          <p className="text-[11px] text-white/25 truncate">{ad.campaign_name}</p>
        </div>
        {ad.suggested_action && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium shrink-0 ${suggestionColor}`}>
            {(ad.suggested_action || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-[11px] mb-1.5">
        <div>
          <span className="text-white/20">Spend</span>{' '}
          <span className="text-white/60">{fmtMoney(ad.total_spend)}</span>
        </div>
        <div>
          <span className="text-white/20">ROAS</span>{' '}
          <span className="text-white/60">{ad.roas != null ? `${Number(ad.roas).toFixed(1)}x` : '-'}</span>
        </div>
        <div>
          <span className="text-white/20">CPA</span>{' '}
          <span className="text-white/60">{ad.cpa != null ? fmtMoney(ad.cpa) : '-'}</span>
        </div>
        <div>
          <span className="text-white/20">Purchases</span>{' '}
          <span className="text-white/60">{ad.total_purchases ?? '-'}</span>
        </div>
        <div>
          <span className="text-white/20">CTR</span>{' '}
          <span className="text-white/60">{ad.ctr != null ? fmtPct(ad.ctr) : '-'}</span>
        </div>
        <div>
          <span className="text-white/20">CPC</span>{' '}
          <span className="text-white/60">{ad.cpc != null ? fmtMoney(ad.cpc) : '-'}</span>
        </div>
      </div>
      {ad.reason && (
        <p className="text-[11px] text-emerald-400/70 italic">{ad.reason}</p>
      )}
    </div>
  );
}

// ── Create/Edit Rule Modal ──────────────────────────────────────────────────

const emptyRule = {
  name: '',
  description: '',
  rule_type: 'kill',
  entity_level: 'ad',
  conditions: [{ metric: 'spend', operator: '>', value: '' }],
  logic_operator: 'AND',
  time_window: 'today',
  action: 'pause_ad',
  action_value: null,
  min_spend: 0,
  cooldown_minutes: 60,
  max_executions_per_day: 50,
  dry_run: false,
  priority: 10,
};

const metricOptions = [
  { value: 'spend', label: 'Spend' },
  { value: 'purchases', label: 'Purchases' },
  { value: 'roas', label: 'ROAS' },
  { value: 'cpa', label: 'CPA' },
  { value: 'ctr', label: 'CTR' },
  { value: 'cpc', label: 'CPC' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'conversion_rate', label: 'Conversion Rate' },
];

const operatorOptions = [
  { value: '>', label: '>' },
  { value: '<', label: '<' },
  { value: '>=', label: '>=' },
  { value: '<=', label: '<=' },
  { value: '=', label: '=' },
];

const actionOptions = [
  { value: 'pause_ad', label: 'Pause Ad' },
  { value: 'resume_ad', label: 'Resume Ad' },
  { value: 'increase_budget_pct', label: 'Increase Budget (%)' },
  { value: 'decrease_budget_pct', label: 'Decrease Budget (%)' },
  { value: 'increase_budget_fixed', label: 'Increase Budget (Fixed)' },
  { value: 'decrease_budget_fixed', label: 'Decrease Budget (Fixed)' },
  { value: 'send_alert', label: 'Send Alert' },
  { value: 'flag_promising', label: 'Flag as Promising' },
];

const timeWindowOptions = Object.entries(timeWindowLabels).map(([value, label]) => ({
  value,
  label,
}));

const budgetActions = new Set([
  'increase_budget_pct',
  'decrease_budget_pct',
  'increase_budget_fixed',
  'decrease_budget_fixed',
]);

const inputClass =
  'w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/20 transition-colors';

const selectClass =
  'bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20 transition-colors cursor-pointer appearance-none';

const labelClass = 'text-xs text-white/40 uppercase tracking-wider mb-1.5 block';

function RuleModal({ show, onClose, editingRule, onSave }) {
  const [form, setForm] = useState({ ...emptyRule });
  const [saving, setSaving] = useState(false);
  const panelRef = useRef(null);

  useEffect(() => {
    if (show) {
      if (editingRule) {
        setForm({
          ...emptyRule,
          ...editingRule,
          conditions:
            Array.isArray(editingRule.conditions) && editingRule.conditions.length > 0
              ? editingRule.conditions.map(c => ({ ...c }))
              : [{ metric: 'spend', operator: '>', value: '' }],
        });
      } else {
        setForm({ ...emptyRule });
      }
    }
  }, [show, editingRule]);

  // Close on escape
  useEffect(() => {
    if (!show) return;
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [show, onClose]);

  if (!show) return null;

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const setCondition = (index, field, value) => {
    setForm((prev) => {
      const conditions = [...prev.conditions];
      conditions[index] = { ...conditions[index], [field]: value };
      return { ...prev, conditions };
    });
  };

  const addCondition = () => {
    setForm((prev) => ({
      ...prev,
      conditions: [...prev.conditions, { metric: 'spend', operator: '>', value: '' }],
    }));
  };

  const removeCondition = (index) => {
    setForm((prev) => ({
      ...prev,
      conditions: prev.conditions.filter((_, i) => i !== index),
    }));
  };

  const handleSave = async () => {
    // Validate conditions have values
    const hasEmptyConditions = form.conditions.some((c) => c.value === '' || c.value === undefined);
    if (hasEmptyConditions) { alert('All conditions must have a value.'); return; }
    // Validate budget actions have a meaningful value
    if (budgetActions.has(form.action) && (!form.action_value || Number(form.action_value) <= 0)) {
      alert('Budget actions require a value greater than 0.'); return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        action_value: budgetActions.has(form.action) ? Number(form.action_value) || 0 : null,
        min_spend: Number(form.min_spend) || 0,
        cooldown_minutes: Number(form.cooldown_minutes) || 60,
        max_executions_per_day: Number(form.max_executions_per_day) || 50,
        priority: Number(form.priority) || 10,
        conditions: form.conditions.map((c) => ({
          ...c,
          value: Number(c.value) || 0,
        })),
      };
      await onSave(payload, editingRule?.id);
      onClose();
    } catch (err) {
      console.error('Failed to save rule:', err);
    } finally {
      setSaving(false);
    }
  };

  const previewText = (() => {
    const entity = form.entity_level?.charAt(0).toUpperCase() + form.entity_level?.slice(1);
    const action = formatAction(form);
    const conds = formatConditions(form.conditions, form.logic_operator);
    const window = timeWindowLabels[form.time_window] || form.time_window;
    return `${action} on ${entity} when ${conds} over ${window} (Triple Whale data). Cooldown: ${form.cooldown_minutes} min. Max ${form.max_executions_per_day}/day.${form.dry_run ? ' [DRY RUN]' : ''}`;
  })();

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="max-w-2xl w-full bg-[#111] border border-white/[0.08] rounded-2xl max-h-[90vh] overflow-y-auto"
      >
        {/* Modal header */}
        <div className="sticky top-0 bg-[#111] border-b border-white/[0.06] px-6 py-4 flex items-center justify-between z-10 rounded-t-2xl">
          <div>
            <h2 className="text-base font-semibold text-white">
              {editingRule ? 'Edit Rule' : 'Create Rule'}
            </h2>
            <p className="text-xs text-white/30 mt-0.5">Define conditions and actions for ad automation</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/[0.06] text-white/30 hover:text-white/60 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* Section 1: Basics */}
          <div>
            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Settings size={12} /> Basics
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className={labelClass}>Name</label>
                <input
                  className={inputClass}
                  placeholder="e.g. Kill Zero Purchase Ads"
                  value={form.name}
                  onChange={(e) => setField('name', e.target.value)}
                />
              </div>
              <div className="col-span-2">
                <label className={labelClass}>Description</label>
                <textarea
                  className={`${inputClass} resize-none h-16`}
                  placeholder="Optional description..."
                  value={form.description}
                  onChange={(e) => setField('description', e.target.value)}
                />
              </div>
              <div>
                <label className={labelClass}>Rule Type</label>
                <select
                  className={`${selectClass} w-full`}
                  value={form.rule_type}
                  onChange={(e) => setField('rule_type', e.target.value)}
                >
                  <option value="kill">Kill</option>
                  <option value="scale">Scale</option>
                  <option value="alert">Alert</option>
                  <option value="protect">Protect</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Entity Level</label>
                <select
                  className={`${selectClass} w-full`}
                  value={form.entity_level}
                  onChange={(e) => setField('entity_level', e.target.value)}
                >
                  <option value="ad">Ad</option>
                  <option value="adset">Ad Set</option>
                  <option value="campaign">Campaign</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Priority</label>
                <input
                  type="number"
                  className={inputClass}
                  value={form.priority}
                  onChange={(e) => setField('priority', e.target.value)}
                  min={1}
                  max={100}
                />
              </div>
            </div>
          </div>

          {/* Section 2: Conditions */}
          <div>
            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Target size={12} /> Conditions
            </h3>
            <div className="space-y-2">
              {form.conditions.map((cond, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  {idx > 0 && (
                    <button
                      className="text-[10px] px-2 py-1 rounded-md bg-white/[0.04] text-white/40 hover:text-white/60 cursor-pointer transition-colors shrink-0"
                      onClick={() =>
                        setField('logic_operator', form.logic_operator === 'AND' ? 'OR' : 'AND')
                      }
                    >
                      {form.logic_operator}
                    </button>
                  )}
                  {idx === 0 && <div className="w-[42px] shrink-0" />}
                  <select
                    className={`${selectClass} flex-1`}
                    value={cond.metric}
                    onChange={(e) => setCondition(idx, 'metric', e.target.value)}
                  >
                    {metricOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className={`${selectClass} w-16`}
                    value={cond.operator}
                    onChange={(e) => setCondition(idx, 'operator', e.target.value)}
                  >
                    {operatorOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    className={`${inputClass} w-24`}
                    placeholder="Value"
                    value={cond.value}
                    onChange={(e) => setCondition(idx, 'value', e.target.value)}
                  />
                  {form.conditions.length > 1 && (
                    <button
                      onClick={() => removeCondition(idx)}
                      className="p-1.5 rounded-lg hover:bg-red-500/10 text-white/20 hover:text-red-400 transition-colors cursor-pointer shrink-0"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={addCondition}
              className="mt-2 text-xs text-blue-400 hover:text-blue-300 cursor-pointer flex items-center gap-1 transition-colors"
            >
              <Plus size={12} /> Add Condition
            </button>
          </div>

          {/* Section 3: Evaluation */}
          <div>
            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Gauge size={12} /> Evaluation
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Time Window</label>
                <select
                  className={`${selectClass} w-full`}
                  value={form.time_window}
                  onChange={(e) => setField('time_window', e.target.value)}
                >
                  {timeWindowOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Min Spend ($)</label>
                <input
                  type="number"
                  className={inputClass}
                  value={form.min_spend}
                  onChange={(e) => setField('min_spend', e.target.value)}
                  min={0}
                />
              </div>
            </div>
          </div>

          {/* Section 4: Action */}
          <div>
            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Zap size={12} /> Action
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Action</label>
                <select
                  className={`${selectClass} w-full`}
                  value={form.action}
                  onChange={(e) => setField('action', e.target.value)}
                >
                  {actionOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              {budgetActions.has(form.action) && (
                <div>
                  <label className={labelClass}>
                    {form.action.includes('pct') ? 'Percentage' : 'Amount ($)'}
                  </label>
                  <input
                    type="number"
                    className={inputClass}
                    placeholder={form.action.includes('pct') ? 'e.g. 20' : 'e.g. 50'}
                    value={form.action_value || ''}
                    onChange={(e) => setField('action_value', e.target.value)}
                    min={0}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Section 5: Safety */}
          <div>
            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3 flex items-center gap-2">
              <ShieldCheck size={12} /> Safety
            </h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>Cooldown (min)</label>
                <input
                  type="number"
                  className={inputClass}
                  value={form.cooldown_minutes}
                  onChange={(e) => setField('cooldown_minutes', e.target.value)}
                  min={0}
                />
              </div>
              <div>
                <label className={labelClass}>Max Exec/Day</label>
                <input
                  type="number"
                  className={inputClass}
                  value={form.max_executions_per_day}
                  onChange={(e) => setField('max_executions_per_day', e.target.value)}
                  min={1}
                />
              </div>
              <div>
                <label className={labelClass}>Dry Run</label>
                <div className="flex items-center gap-2 mt-1">
                  <Toggle
                    checked={form.dry_run}
                    onChange={(v) => setField('dry_run', v)}
                  />
                  <span className="text-xs text-white/30">{form.dry_run ? 'Enabled' : 'Disabled'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Section 6: Preview */}
          <div>
            <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Eye size={12} /> Preview
            </h3>
            <div className="bg-white/[0.02] rounded-xl border border-white/[0.06] px-4 py-3">
              <p className="text-xs text-white/50 leading-relaxed">{previewText}</p>
            </div>
          </div>
        </div>

        {/* Modal footer */}
        <div className="sticky bottom-0 bg-[#111] border-t border-white/[0.06] px-6 py-4 flex items-center justify-end gap-3 rounded-b-2xl">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-white/[0.08] text-white/50 hover:text-white hover:bg-white/[0.04] transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !form.name.trim()}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving && <RefreshCw size={13} className="animate-spin" />}
            {editingRule ? 'Update Rule' : 'Create Rule'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function AdsControlCenter() {
  const [rules, setRules] = useState([]);
  const [activity, setActivity] = useState([]);
  const [promising, setPromising] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState({ rules: true, activity: true, promising: true });
  const [date, setDate] = useState(todayStr);
  const [showModal, setShowModal] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [evaluating, setEvaluating] = useState(false);
  const [activityFilter, setActivityFilter] = useState('all');

  // ── Data fetching ──────────────────────────────────────────────────────

  const fetchRules = useCallback(async (silent = false) => {
    if (!silent) setLoading((p) => ({ ...p, rules: true }));
    try {
      const { data } = await api.get('/ads-control/rules');
      if (data.success) setRules(data.data || []);
    } catch (err) {
      console.error('Failed to fetch rules:', err);
    } finally {
      setLoading((p) => ({ ...p, rules: false }));
    }
  }, []);

  const fetchActivity = useCallback(async (silent = false) => {
    if (!silent) setLoading((p) => ({ ...p, activity: true }));
    try {
      const { data } = await api.get('/ads-control/activity', { params: { limit: 50, offset: 0 } });
      if (data.success) setActivity(data.data?.entries || []);
    } catch (err) {
      console.error('Failed to fetch activity:', err);
    } finally {
      setLoading((p) => ({ ...p, activity: false }));
    }
  }, []);

  const fetchPromising = useCallback(
    async (silent = false) => {
      if (!silent) setLoading((p) => ({ ...p, promising: true }));
      try {
        const { data } = await api.get('/ads-control/promising', { params: { date } });
        if (data.success) setPromising(data.data || []);
      } catch (err) {
        console.error('Failed to fetch promising:', err);
      } finally {
        setLoading((p) => ({ ...p, promising: false }));
      }
    },
    [date],
  );

  const fetchStatus = useCallback(async () => {
    try {
      const { data } = await api.get('/ads-control/status');
      if (data.success) setStatus(data.data);
    } catch (err) {
      console.error('Failed to fetch status:', err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchRules();
    fetchActivity();
    fetchPromising();
    fetchStatus();
  }, [fetchRules, fetchActivity, fetchPromising, fetchStatus]);

  // Refresh promising when date changes
  useEffect(() => {
    fetchPromising();
  }, [fetchPromising]);

  // Auto-refresh every 30s (silent)
  useEffect(() => {
    const interval = setInterval(() => {
      fetchActivity(true);
      fetchStatus();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchActivity, fetchStatus]);

  // ── Actions ────────────────────────────────────────────────────────────

  const handleEvaluate = async () => {
    if (evaluating) return; // Guard against double-click race
    setEvaluating(true);
    try {
      await api.post('/ads-control/evaluate');
      await Promise.all([fetchRules(), fetchActivity(true), fetchStatus(), fetchPromising(true)]);
    } catch (err) {
      console.error('Evaluation failed:', err);
    } finally {
      setEvaluating(false);
    }
  };

  const handleToggle = async (rule) => {
    try {
      const { data } = await api.post(`/ads-control/rules/${rule.id}/toggle`);
      if (data.success) {
        setRules((prev) => prev.map((r) => (r.id === rule.id ? data.data : r)));
      }
    } catch (err) {
      console.error('Toggle failed:', err);
    }
  };

  const handleSaveRule = async (payload, existingId) => {
    if (existingId) {
      const { data } = await api.put(`/ads-control/rules/${existingId}`, payload);
      if (data.success) {
        setRules((prev) => prev.map((r) => (r.id === existingId ? data.data : r)));
      }
    } else {
      const { data } = await api.post('/ads-control/rules', payload);
      if (data.success) {
        setRules((prev) => [...prev, data.data]);
      }
    }
  };

  const handleDeleteRule = async (rule) => {
    if (!window.confirm(`Delete rule "${rule.name}"? This cannot be undone.`)) return;
    try {
      const { data } = await api.delete(`/ads-control/rules/${rule.id}`);
      if (data.success) {
        setRules((prev) => prev.filter((r) => r.id !== rule.id));
      }
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const handleDuplicateRule = (rule) => {
    const copy = { ...rule };
    delete copy.id;
    delete copy.created_at;
    delete copy.updated_at;
    delete copy.times_triggered;
    delete copy.last_triggered_at;
    copy.name = `${rule.name} (Copy)`;
    copy.enabled = false;
    // Deep copy conditions to avoid shared reference
    copy.conditions = Array.isArray(rule.conditions)
      ? rule.conditions.map(c => ({ ...c }))
      : [{ metric: 'spend', operator: '>', value: '' }];
    setEditingRule(copy);
    setShowModal(true);
  };

  const openCreate = () => {
    setEditingRule(null);
    setShowModal(true);
  };

  const openEdit = (rule) => {
    setEditingRule(rule);
    setShowModal(true);
  };

  // ── Computed ───────────────────────────────────────────────────────────

  const activeRulesCount = rules.filter((r) => r.enabled).length;
  const todayActivity = activity.filter(
    (a) => new Date(a.created_at).toISOString().slice(0, 10) === todayStr(),
  );
  const actionsToday = todayActivity.length;
  const pausedToday = todayActivity.filter((a) => a.action === 'pause_ad').length;
  const budgetIncreasesToday = todayActivity.filter(
    (a) => a.action === 'increase_budget_pct' || a.action === 'increase_budget_fixed',
  ).length;
  const budgetDecreasesToday = todayActivity.filter(
    (a) => a.action === 'decrease_budget_pct' || a.action === 'decrease_budget_fixed',
  ).length;
  const errorsToday = todayActivity.filter((a) => a.execution_status === 'error').length;

  const filteredActivity = (() => {
    if (activityFilter === 'all') return activity;
    if (activityFilter === 'paused') return activity.filter((a) => a.action === 'pause_ad');
    if (activityFilter === 'budget')
      return activity.filter((a) => a.action?.includes('budget'));
    if (activityFilter === 'promising') return activity.filter((a) => a.action === 'flag_promising');
    if (activityFilter === 'errors') return activity.filter((a) => a.execution_status === 'error');
    return activity;
  })();

  const filterTabs = [
    { key: 'all', label: 'All' },
    { key: 'paused', label: 'Paused' },
    { key: 'budget', label: 'Budget Changed' },
    { key: 'promising', label: 'Promising' },
    { key: 'errors', label: 'Errors' },
  ];

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6 min-h-screen">
      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <Zap size={16} className="text-blue-400" />
            </div>
            <h1 className="text-xl font-bold text-white">Ads Control Center</h1>
          </div>
          <p className="text-sm text-white/40 mt-1 ml-[42px]">
            Command center for automated ad optimization powered by Triple Whale
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Live indicator */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            <span className="text-xs text-white/50">Live</span>
          </div>

          <DatePicker value={date} onChange={setDate} period="daily" />

          <button
            onClick={handleEvaluate}
            disabled={evaluating}
            className="px-3.5 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-2"
          >
            <RefreshCw size={14} className={evaluating ? 'animate-spin' : ''} />
            Evaluate Now
          </button>
        </div>
      </div>

      {/* ── KPI SUMMARY STRIP ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        <StatCard
          icon={Shield}
          label="Active Rules"
          value={activeRulesCount}
          accent="blue"
          loading={loading.rules}
        />
        <StatCard
          icon={Activity}
          label="Actions Today"
          value={actionsToday}
          accent="purple"
          loading={loading.activity}
        />
        <StatCard
          icon={PauseCircle}
          label="Ads Paused"
          value={pausedToday}
          accent="red"
          loading={loading.activity}
        />
        <StatCard
          icon={ArrowUpRight}
          label="Budget ++"
          value={budgetIncreasesToday}
          accent="green"
          loading={loading.activity}
        />
        <StatCard
          icon={ArrowDownRight}
          label="Budget --"
          value={budgetDecreasesToday}
          accent="orange"
          loading={loading.activity}
        />
        <StatCard
          icon={Sparkles}
          label="Promising"
          value={promising.length}
          accent="emerald"
          loading={loading.promising}
        />
        <StatCard
          icon={AlertTriangle}
          label="Errors"
          value={errorsToday}
          accent="amber"
          loading={loading.activity}
        />
        <StatCard
          icon={Clock}
          label="Last Sync"
          value={status?.lastEvaluatedAt ? timeAgo(status.lastEvaluatedAt) : '-'}
          accent="cyan"
          loading={false}
        />
      </div>

      {/* ── ACTIVE RULES ────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-white/30" />
            <h2 className="text-sm font-semibold text-white">Automation Rules</h2>
            <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-white/[0.04] text-white/30">
              {rules.length}
            </span>
          </div>
          <button
            onClick={openCreate}
            className="px-3 py-1.5 text-xs rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/60 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <Plus size={13} /> Create Rule
          </button>
        </div>

        {loading.rules ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <SkeletonCards count={3} className="h-48" />
          </div>
        ) : rules.length === 0 ? (
          <div className={`${cardGlass} p-12 text-center`}>
            <div className="w-12 h-12 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3">
              <Shield size={20} className="text-white/15" />
            </div>
            <p className="text-sm text-white/30 mb-1">No rules created yet</p>
            <p className="text-xs text-white/15 mb-4">Create your first automation rule to get started</p>
            <button
              onClick={openCreate}
              className="px-4 py-2 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors cursor-pointer inline-flex items-center gap-1.5"
            >
              <Plus size={13} /> New Rule
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {rules.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                onToggle={handleToggle}
                onEdit={openEdit}
                onDuplicate={handleDuplicateRule}
                onDelete={handleDeleteRule}
              />
            ))}
            {/* Create new card */}
            <button
              onClick={openCreate}
              className="border-2 border-dashed border-white/[0.06] hover:border-white/[0.12] rounded-2xl p-8 flex flex-col items-center justify-center gap-2 transition-colors cursor-pointer group min-h-[180px]"
            >
              <div className="w-10 h-10 rounded-xl bg-white/[0.03] flex items-center justify-center group-hover:bg-white/[0.06] transition-colors">
                <Plus size={18} className="text-white/20 group-hover:text-white/40 transition-colors" />
              </div>
              <span className="text-xs text-white/20 group-hover:text-white/40 transition-colors">
                New Rule
              </span>
            </button>
          </div>
        )}
      </div>

      {/* ── ACTIVITY FEED + PROMISING ADS ───────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Activity Feed (60%) */}
        <div className={`${cardGlass} p-5 lg:col-span-3`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Activity size={16} className="text-white/30" />
              <h2 className="text-sm font-semibold text-white">Activity Feed</h2>
            </div>
          </div>

          {/* Filter tabs */}
          <div className="flex items-center gap-1.5 mb-4 overflow-x-auto pb-1">
            {filterTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActivityFilter(tab.key)}
                className={`px-2.5 py-1 text-[11px] rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  activityFilter === tab.key
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                    : 'text-white/30 hover:text-white/50 border border-transparent hover:bg-white/[0.03]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {loading.activity ? (
            <div className="space-y-3">
              <SkeletonCards count={5} className="h-16" />
            </div>
          ) : filteredActivity.length === 0 ? (
            <div className="py-16 text-center">
              <Activity size={24} className="text-white/10 mx-auto mb-2" />
              <p className="text-sm text-white/25">No activity yet</p>
              <p className="text-xs text-white/15 mt-0.5">
                Rules will log actions here when triggered
              </p>
            </div>
          ) : (
            <div className="max-h-[500px] overflow-y-auto space-y-0.5 pr-1 scrollbar-thin">
              {filteredActivity.map((entry) => (
                <ActivityEntry key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>

        {/* Promising Ads (40%) */}
        <div className={`${cardGlass} p-5 lg:col-span-2`}>
          <div className="flex items-center gap-2 mb-4">
            <Sparkles size={16} className="text-emerald-400/60" />
            <h2 className="text-sm font-semibold text-white">Promising Ads</h2>
            {promising.length > 0 && (
              <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400">
                {promising.length}
              </span>
            )}
          </div>

          {loading.promising ? (
            <div className="space-y-3">
              <SkeletonCards count={4} className="h-24" />
            </div>
          ) : promising.length === 0 ? (
            <div className="py-16 text-center">
              <Sparkles size={24} className="text-white/10 mx-auto mb-2" />
              <p className="text-sm text-white/25">No promising ads detected yet</p>
              <p className="text-xs text-white/15 mt-0.5">
                Ads meeting promising criteria will appear here
              </p>
            </div>
          ) : (
            <div className="max-h-[500px] overflow-y-auto pr-1 scrollbar-thin">
              {promising.map((ad, idx) => (
                <PromisingAdCard key={ad.id || idx} ad={ad} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── SYSTEM STATUS BAR ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className={`${cardGlass} px-4 py-3 flex items-center gap-3`}>
          <div className="w-7 h-7 rounded-lg bg-white/[0.03] flex items-center justify-center">
            <Clock size={13} className="text-white/25" />
          </div>
          <div>
            <p className="text-[10px] text-white/25 uppercase tracking-wider">Last Evaluated</p>
            <p className="text-xs text-white/60 font-medium mt-0.5">
              {status?.lastEvaluatedAt ? timeAgo(status.lastEvaluatedAt) : 'Never'}
            </p>
          </div>
        </div>
        <div className={`${cardGlass} px-4 py-3 flex items-center gap-3`}>
          <div className="w-7 h-7 rounded-lg bg-white/[0.03] flex items-center justify-center">
            <Timer size={13} className="text-white/25" />
          </div>
          <div>
            <p className="text-[10px] text-white/25 uppercase tracking-wider">Next Evaluation</p>
            <p className="text-xs text-white/60 font-medium mt-0.5">
              {status?.nextEvaluation ? timeAgo(status.nextEvaluation) : '~30 min'}
            </p>
          </div>
        </div>
        <div className={`${cardGlass} px-4 py-3 flex items-center gap-3`}>
          <div className="w-7 h-7 rounded-lg bg-white/[0.03] flex items-center justify-center">
            <Gauge size={13} className="text-white/25" />
          </div>
          <div>
            <p className="text-[10px] text-white/25 uppercase tracking-wider">Eval Status</p>
            <p className="text-xs font-medium mt-0.5">
              {evaluating ? (
                <span className="text-amber-400">Running...</span>
              ) : (
                <span className="text-green-400/60">Idle</span>
              )}
            </p>
          </div>
        </div>
        <div className={`${cardGlass} px-4 py-3 flex items-center gap-3`}>
          <div className="w-7 h-7 rounded-lg bg-white/[0.03] flex items-center justify-center">
            <Radio size={13} className="text-white/25" />
          </div>
          <div>
            <p className="text-[10px] text-white/25 uppercase tracking-wider">Scheduler</p>
            <p className="text-xs font-medium mt-0.5">
              {status?.schedulerActive !== false ? (
                <span className="text-green-400/60">Active</span>
              ) : (
                <span className="text-red-400/60">Inactive</span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* ── RULE MODAL ──────────────────────────────────────────────────── */}
      <RuleModal
        show={showModal}
        onClose={() => {
          setShowModal(false);
          setEditingRule(null);
        }}
        editingRule={editingRule}
        onSave={handleSaveRule}
      />
    </div>
  );
}

