import { useState, useEffect, useCallback } from 'react';
import { X, Bot, Loader2, Play, AlertCircle, CheckCircle2 } from 'lucide-react';
import api from '../../../services/api';

const TIERS = ['BANGER', 'CHAMP', 'A', 'B', 'C'];
const AGES = [
  { label: 'Any age', days: null },
  { label: '7d', days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
];

/**
 * Autopilot Mode.
 *
 * Deliberately has no auto-approve control: Autopilot generates and leaves
 * briefs in the Kanban, the operator reviews and approves. Nothing reaches an
 * editor unseen, so there is no quality gate to configure here.
 *
 * "Preview tonight's batch" is a dry run — it shows exactly which ads would be
 * picked and which would be skipped and why, without queueing anything. That is
 * the intended way to try a config change.
 */
export default function AutopilotModal({ open, onClose }) {
  const [cfg, setCfg] = useState(null);
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [{ data: s }, { data: b }] = await Promise.all([
        api.get('/brief-pipeline/autopilot/settings'),
        api.get('/brief-pipeline/league/brands'),
      ]);
      setCfg(s.config);
      setBrands(b.brands || []);
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open) { load(); setPreview(null); setSaved(false); } }, [open, load]);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const { data } = await api.put('/brief-pipeline/autopilot/settings', { config: cfg });
      setCfg(data.config); setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message);
    } finally { setSaving(false); }
  };

  const runPreview = async () => {
    setPreviewing(true); setError(null); setPreview(null);
    try {
      const { data } = await api.post('/brief-pipeline/autopilot/run', { dry_run: true, overrides: cfg });
      setPreview(data);
    } catch (e) {
      setError(e.response?.data?.error?.message || e.message);
    } finally { setPreviewing(false); }
  };

  if (!open) return null;
  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }));
  const toggleIn = (k, v) => setCfg(c => {
    const cur = new Set(c[k] || []);
    cur.has(v) ? cur.delete(v) : cur.add(v);
    return { ...c, [k]: [...cur] };
  });

  const field = 'w-full bg-black/40 border border-white/[0.08] rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-white/[0.2]';
  const pill = active => `px-2.5 py-1.5 rounded-md text-[11px] font-mono font-semibold uppercase tracking-wide border transition-all cursor-pointer ${
    active ? 'bg-white/[0.06] border-white/[0.15] text-white' : 'bg-white/[0.01] border-white/[0.04] text-zinc-500 hover:text-zinc-300'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl max-h-[88vh] overflow-y-auto bg-[#111113] border border-white/[0.08] rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06] sticky top-0 bg-[#111113]">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-violet-400" />
            <h2 className="text-base font-semibold text-white">Autopilot Mode</h2>
            <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">· league → briefs</span>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white cursor-pointer"><X className="w-5 h-5" /></button>
        </div>

        {loading || !cfg ? (
          <div className="p-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-zinc-500" /></div>
        ) : (
          <div className="p-5 space-y-5">
            <div className="flex items-start justify-between gap-4 p-3 rounded-lg border border-white/[0.06] bg-white/[0.01]">
              <div>
                <div className="text-sm text-white font-medium">Autopilot enabled</div>
                <div className="text-xs text-zinc-500 mt-1">
                  Picks unbriefed ads from the League, queues them for transcription and brief generation.
                  Briefs land in the Kanban for your review — nothing is pushed to ClickUp.
                </div>
              </div>
              <button
                onClick={() => set('enabled', !cfg.enabled)}
                className={`shrink-0 w-12 h-6 rounded-full transition-colors cursor-pointer ${cfg.enabled ? 'bg-violet-500' : 'bg-zinc-700'}`}
              >
                <span className={`block w-5 h-5 bg-white rounded-full transition-transform mx-0.5 ${cfg.enabled ? 'translate-x-6' : ''}`} />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <label className="block">
                <span className="text-xs text-zinc-400">Starts at (Madrid)</span>
                <input type="number" min="0" max="23" className={field} value={cfg.startHour}
                  onChange={e => set('startHour', Math.max(0, Math.min(23, Number(e.target.value))))} />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-400">Briefs per run</span>
                <input type="number" min="1" max="50" className={field} value={cfg.briefsPerRun}
                  onChange={e => set('briefsPerRun', Math.max(1, Number(e.target.value)))} />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-400">Max per brand</span>
                <input type="number" min="1" max="20" className={field} value={cfg.maxPerBrand}
                  onChange={e => set('maxPerBrand', Math.max(1, Number(e.target.value)))} />
              </label>
            </div>

            <div>
              <div className="text-xs text-zinc-400 mb-2">Tiers</div>
              <div className="flex gap-1.5 flex-wrap">
                {TIERS.map(t => (
                  <button key={t} onClick={() => toggleIn('tiers', t)} className={pill((cfg.tiers || []).includes(t))}>{t}</button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs text-zinc-400 mb-2">Only ads started within</div>
              <div className="flex gap-1.5">
                {AGES.map(a => (
                  <button key={a.label} onClick={() => set('maxAgeDays', a.days)} className={pill(cfg.maxAgeDays === a.days)}>{a.label}</button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs text-zinc-400 mb-2">
                Brands {(cfg.brands || []).length === 0 && <span className="text-zinc-600">— none selected means all</span>}
              </div>
              <div className="flex gap-1.5 flex-wrap max-h-32 overflow-y-auto">
                {brands.map(b => (
                  <button key={b.id} onClick={() => toggleIn('brands', b.domain)} className={pill((cfg.brands || []).includes(b.domain))}>
                    {b.domain}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/5 border border-red-500/20 rounded-md p-3">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{error}</span>
              </div>
            )}

            {preview && (
              <div className="rounded-lg border border-white/[0.06] bg-black/30 p-3">
                <div className="text-xs text-zinc-400 mb-2">
                  Preview — considered {preview.considered}, would queue {preview.picked?.length || 0}
                </div>
                {(preview.picked || []).map(p => (
                  <div key={p.id} className="text-xs text-zinc-300 font-mono py-0.5">
                    <span className="text-zinc-500">{p.tier}</span> {p.brand} — {String(p.headline || '').slice(0, 46)}
                  </div>
                ))}
                {!preview.picked?.length && <div className="text-xs text-zinc-500">Nothing matches these filters.</div>}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button onClick={runPreview} disabled={previewing}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-sm border border-white/[0.1] text-zinc-300 hover:text-white hover:bg-white/[0.04] cursor-pointer disabled:opacity-50">
                {previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Preview tonight's batch
              </button>
              <div className="flex-1" />
              {saved && <span className="flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 className="w-4 h-4" /> Saved</span>}
              <button onClick={save} disabled={saving}
                className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-violet-500 hover:bg-violet-400 text-white cursor-pointer disabled:opacity-50">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
