// The two integration surfaces the named-network cards cannot cover:
//
//   CustomNetworksDetail — operator-defined OUTBOUND postback templates. Any
//     tracker that accepts a click-id postback can be wired here without a code
//     change, and TEST-FIRED before real money rides on it.
//
//   InboundEndpointsDetail — tokenized INBOUND endpoints (/pb/:token) that
//     networks, call centres and partner funnels post conversions back into.
//
// Both write through routes/trackingIntegrations.js.
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft, RefreshCw, Plus, Trash2, FlaskConical, RotateCw, ChevronRight,
} from 'lucide-react';
import api from '../../../services/api';
import Button from '../../ui/Button';
import {
  ConnChip, StatusDot, CopyUrlButton, CheckboxRow, Panel, StatRow, Field,
} from './trackingUi';
import { errOf } from './trackingConstants';

const base = (funnelId) => `/tracking-admin/${encodeURIComponent(funnelId)}`;

// ─────────────────────────────────────────────────────────────────────────────
// A. CUSTOM S2S NETWORKS
// ─────────────────────────────────────────────────────────────────────────────

const BLANK = {
  label: '', url_template: '', click_id_param: '', method: 'GET',
  event_names: ['Purchase'], enabled: true,
};

function MacroHelp({ macros }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-text-faint">
        Available macros — each is URL-encoded when the postback fires, so a value containing
        <code className="px-1 font-mono">&amp;</code> or a line break can never add a parameter of its own:
      </p>
      <div className="flex flex-wrap gap-1">
        {(macros || []).map((m) => (
          <code key={m} className="px-1.5 py-0.5 text-[11px] rounded bg-bg-elevated border border-border-default text-text-muted font-mono">
            {`{${m}}`}
          </code>
        ))}
      </div>
      <p className="text-xs text-text-faint">
        A macro may appear in the path, query or fragment — never in the hostname. A template whose
        host could change per conversion is refused at save time.
      </p>
    </div>
  );
}

function NetworkEditor({ funnel, initial, macros, events, onDone, onCancel }) {
  const isNew = !initial?.id;
  const [form, setForm] = useState(() => ({ ...BLANK, ...(initial || {}) }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [warning, setWarning] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testEvent, setTestEvent] = useState('Purchase');

  useEffect(() => { setForm({ ...BLANK, ...(initial || {}) }); setTestResult(null); setErr(''); setWarning(''); }, [initial]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleEvent = (name, on) => set('event_names',
    on ? [...new Set([...(form.event_names || []), name])] : (form.event_names || []).filter((e) => e !== name));

  const save = async () => {
    setSaving(true); setErr(''); setWarning('');
    try {
      const body = {
        label: form.label,
        url_template: form.url_template,
        click_id_param: form.click_id_param,
        method: form.method,
        event_names: form.event_names,
        enabled: form.enabled === true,
      };
      const res = isNew
        ? await api.post(`${base(funnel.id)}/custom-networks`, body)
        : await api.put(`${base(funnel.id)}/custom-networks/${encodeURIComponent(initial.id)}`, body);
      // A save can succeed WITH a warning — an unresolvable host is stored but
      // will not deliver until it resolves. Saying so beats a silent green tick.
      if (res.data?.data?.warning) setWarning(res.data.data.warning);
      onDone?.(res.data?.data?.network, Boolean(res.data?.data?.warning));
    } catch (e) {
      setErr(errOf(e, 'Failed to save this network'));
    } finally { setSaving(false); }
  };

  const testFire = async () => {
    setTesting(true); setTestResult(null); setErr('');
    try {
      const res = await api.post(
        `${base(funnel.id)}/custom-networks/${encodeURIComponent(initial.id)}/test`,
        { event: testEvent },
      );
      setTestResult(res.data?.data || null);
    } catch (e) {
      setErr(errOf(e, 'Test fire failed'));
    } finally { setTesting(false); }
  };

  return (
    <Panel
      title={isNew ? 'New custom network' : `Edit — ${initial.label}`}
      description="A postback template with {macro} placeholders. It fires through the same delivery rails as every other network: one idempotency claim per conversion, a circuit breaker, and a retry queue."
    >
      <Field label="Name" value={form.label} onChange={(v) => set('label', v)}
        placeholder="Partner Network" mono={false}
        help="Used as this network's identity in the delivery ledger. Renaming it starts a fresh dedupe space." />

      <div className="space-y-1">
        <label className="block text-xs font-medium text-text-muted">Postback URL template</label>
        <textarea
          value={form.url_template}
          onChange={(e) => set('url_template', e.target.value)}
          rows={3}
          placeholder="https://tracker.example.com/postback?cid={click_id}&payout={payout}&cur={currency}&event={event}"
          spellCheck={false}
          className="w-full px-3 py-2 text-xs bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors resize-y"
        />
      </div>
      <MacroHelp macros={macros} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Click-id parameter (optional)" value={form.click_id_param}
          onChange={(v) => set('click_id_param', v)} placeholder="pclid"
          help="The URL parameter this network stamps on the landing page. Captured into the click vault." />
        <div className="space-y-1">
          <label className="block text-xs font-medium text-text-muted">Method</label>
          <select
            value={form.method}
            onChange={(e) => set('method', e.target.value)}
            className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent cursor-pointer"
          >
            <option value="GET">GET (tracker default)</option>
            <option value="POST">POST (same macros as a JSON body)</option>
          </select>
        </div>
      </div>

      <div className="space-y-2">
        <label className="block text-xs font-medium text-text-muted">Send these events</label>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {(events || []).map((name) => (
            <CheckboxRow
              key={name}
              label={name}
              checked={(form.event_names || []).includes(name)}
              onChange={(on) => toggleEvent(name, on)}
            />
          ))}
        </div>
        {(form.event_names || []).length === 0 && (
          <p className="text-xs text-amber-400">
            No events selected — this network is configured but will never fire.
          </p>
        )}
      </div>

      <CheckboxRow label="Enabled" checked={form.enabled === true} onChange={(v) => set('enabled', v)} />

      {err && <p className="text-sm text-danger">{err}</p>}
      {warning && <p className="text-sm text-amber-400">{warning}</p>}

      <div className="flex items-center gap-3 pt-1 flex-wrap">
        <Button onClick={save} loading={saving}>{isNew ? 'Create network' : 'Save changes'}</Button>
        <button onClick={onCancel} className="text-sm text-text-muted hover:text-text-primary cursor-pointer">Cancel</button>
        {!isNew && (
          <>
            <span className="ml-auto" />
            <select
              value={testEvent}
              onChange={(e) => setTestEvent(e.target.value)}
              className="px-2 py-1.5 text-xs bg-bg-elevated border border-border-default rounded-lg text-text-primary cursor-pointer"
            >
              {(events || []).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <Button variant="secondary" onClick={testFire} loading={testing}>
              <FlaskConical className="w-4 h-4 mr-1.5" /> Test fire
            </Button>
          </>
        )}
      </div>

      {testResult && (
        <div className="rounded-lg border border-border-default bg-bg-elevated/60 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <StatusDot state={testResult.ok ? 'connected' : 'unknown'} />
            <span className="text-sm font-semibold text-text-primary">
              {testResult.ok ? 'The endpoint accepted the request' : 'The endpoint did not accept the request'}
            </span>
          </div>
          <StatRow label="Resolved URL">
            <code className="text-[11px] font-mono break-all select-all">{testResult.rendered_url || '—'}</code>
          </StatRow>
          <StatRow label="Method">{testResult.method}</StatRow>
          <StatRow label="Response code" tone={testResult.ok ? 'text-emerald-400' : 'text-red-400'}>
            {testResult.status ?? '—'}
          </StatRow>
          {testResult.response?.raw != null && (
            <StatRow label="Response body">
              <code className="text-[11px] font-mono break-all">{String(testResult.response.raw).slice(0, 200) || '(empty)'}</code>
            </StatRow>
          )}
          {testResult.error && <StatRow label="Error" tone="text-red-400">{testResult.error}</StatRow>}
          <p className="text-xs text-text-faint">{testResult.note}</p>
        </div>
      )}
    </Panel>
  );
}

export function CustomNetworksDetail({ funnel, macros, events, focusId, onBack, onChanged }) {
  const [rows, setRows] = useState(null);       // null=loading, 'error', or []
  const [health, setHealth] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const [editing, setEditing] = useState(null); // null | {} (new) | row
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    try {
      const [l, h] = await Promise.all([
        api.get(`${base(funnel.id)}/custom-networks`),
        api.get(`${base(funnel.id)}/custom-networks/health`),
      ]);
      const list = l.data?.data?.networks;
      // A 200 with a malformed body is the ERROR path — never coerce it to []
      // and paint a confident "no networks" off garbage.
      if (!Array.isArray(list)) throw new Error('malformed_response');
      setRows(list);
      setHealth(Array.isArray(h.data?.data?.health) ? h.data.data.health : []);
      setLoadErr('');
    } catch (e) {
      setRows((prev) => (Array.isArray(prev) ? prev : 'error'));
      setLoadErr(errOf(e, 'Failed to load custom networks'));
    }
  }, [funnel.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (focusId && Array.isArray(rows)) {
      const hit = rows.find((r) => r.id === focusId);
      if (hit) setEditing(hit);
    }
  }, [focusId, rows]);

  const remove = async (row) => {
    setBusyId(row.id);
    try {
      await api.delete(`${base(funnel.id)}/custom-networks/${encodeURIComponent(row.id)}`);
      if (editing?.id === row.id) setEditing(null);
      await load(); onChanged?.();
    } catch (e) {
      setLoadErr(errOf(e, 'Failed to delete'));
    } finally { setBusyId(''); }
  };

  const toggle = async (row, on) => {
    setBusyId(row.id);
    try {
      await api.put(`${base(funnel.id)}/custom-networks/${encodeURIComponent(row.id)}`, { enabled: on });
      await load(); onChanged?.();
    } catch (e) {
      setLoadErr(errOf(e, 'Failed to change enabled'));
    } finally { setBusyId(''); }
  };

  const healthOf = (id) => health.find((h) => h.id === id) || null;

  return (
    <div className="space-y-5 max-w-2xl">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary cursor-pointer">
        <ArrowLeft className="w-4 h-4" /> All networks
      </button>

      <div>
        <h3 className="text-base font-semibold text-text-primary">Custom S2S networks</h3>
        <p className="mt-1 text-sm text-text-muted">
          Any tracker that accepts a click-id postback can be wired here — no code change. Write the
          network&apos;s postback URL with <code className="font-mono">{'{macro}'}</code> placeholders,
          pick the events, and test-fire it. Conversions then ride the same rails as every other
          network: one send per conversion, a circuit breaker per network, and a retry queue.
        </p>
      </div>

      {loadErr && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/10 text-xs text-amber-400">
          <span>{loadErr}</span>
          <button onClick={load} className="underline cursor-pointer shrink-0">Retry</button>
        </div>
      )}

      {rows === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : rows === 'error' ? (
        <p className="text-sm text-danger">Could not load custom networks.</p>
      ) : (
        <div className="space-y-3">
          {rows.length === 0 && !editing && (
            <div className="rounded-lg border border-dashed border-border-default bg-bg-elevated/40 px-4 py-6 text-center text-sm text-text-muted">
              No custom networks yet.
            </div>
          )}
          {rows.map((row) => {
            const h = healthOf(row.id);
            return (
              <div key={row.id} className="rounded-xl border border-border-default bg-bg-card p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusDot state={row.enabled ? 'connected' : 'not_connected'} />
                      <span className="text-sm font-semibold text-text-primary truncate">{row.label}</span>
                      <ConnChip state={row.enabled ? 'connected' : 'not_connected'} />
                    </div>
                    <div className="mt-1 text-xs text-text-muted">
                      {row.method} · {(row.event_names || []).join(', ') || 'no events selected'}
                      {row.click_id_param ? ` · click id: ${row.click_id_param}` : ''}
                    </div>
                    {h && (
                      <div className="mt-1 text-xs text-text-faint">
                        24h: {h.sent_24h} sent · {h.failed_24h} failed · {h.deduped_24h} deduped
                        {h.queued_now > 0 ? ` · ${h.queued_now} queued` : ''}
                        {h.breaker?.state === 'open' ? ' · breaker OPEN' : ''}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <CheckboxRow label="" checked={row.enabled} disabled={busyId === row.id}
                      onChange={(v) => toggle(row, v)} />
                    <button
                      onClick={() => setEditing(row)}
                      className="px-2.5 py-1.5 text-xs rounded-lg border border-border-default bg-bg-elevated text-text-primary hover:bg-bg-hover cursor-pointer"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => remove(row)}
                      disabled={busyId === row.id}
                      title="Delete this network"
                      className="p-1.5 rounded-lg border border-border-default bg-bg-elevated text-text-muted hover:text-red-400 cursor-pointer disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <code className="block px-3 py-2 text-[11px] bg-bg-elevated border border-border-default rounded-lg text-text-muted font-mono break-all">
                  {row.url_template}
                </code>
              </div>
            );
          })}

          {editing ? (
            <NetworkEditor
              funnel={funnel}
              initial={editing.id ? editing : null}
              macros={macros}
              events={events}
              onCancel={() => setEditing(null)}
              onDone={async (saved) => { setEditing(saved || null); await load(); onChanged?.(); }}
            />
          ) : (
            <Button onClick={() => setEditing({})}>
              <Plus className="w-4 h-4 mr-1.5" /> Add a custom network
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B. INBOUND POSTBACK ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

export function InboundEndpointsDetail({ funnel, allowedEvents, onBack }) {
  const [rows, setRows] = useState(null);
  const [events, setEvents] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const [l, e] = await Promise.all([
        api.get(`${base(funnel.id)}/inbound-endpoints`),
        api.get(`${base(funnel.id)}/inbound-events`, { params: { limit: 50 } }),
      ]);
      const list = l.data?.data?.endpoints;
      if (!Array.isArray(list)) throw new Error('malformed_response');
      setRows(list);
      setEvents(Array.isArray(e.data?.data?.events) ? e.data.data.events : []);
      setLoadErr('');
    } catch (err) {
      setRows((prev) => (Array.isArray(prev) ? prev : 'error'));
      setLoadErr(errOf(err, 'Failed to load inbound endpoints'));
    }
  }, [funnel.id]);

  useEffect(() => { load(); }, [load]);

  const act = async (fn, key) => {
    setBusy(key);
    try { await fn(); await load(); } catch (e) { setLoadErr(errOf(e, 'Request failed')); } finally { setBusy(''); }
  };

  // The server returns '' for `url` when PUBLIC_BASE_URL is unset — the browser
  // origin is then the honest base, and the server must not guess one.
  const fullUrl = (ep) => ep.url || `${window.location.origin}${ep.path}`;

  return (
    <div className="space-y-5 max-w-2xl">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary cursor-pointer">
        <ArrowLeft className="w-4 h-4" /> All networks
      </button>

      <div>
        <h3 className="text-base font-semibold text-text-primary">Inbound postbacks</h3>
        <p className="mt-1 text-sm text-text-muted">
          The mirror image of the outbound networks: a tokenized URL that ad networks, call centres
          and partner funnels post conversions INTO. Paste one of these into the network&apos;s postback
          field. The token is the only credential — treat the whole URL as a secret, and rotate it if
          it leaks.
        </p>
      </div>

      <Panel title="What the endpoint accepts" description="Send these as query parameters on a GET, or as a JSON or form body on a POST.">
        <div className="space-y-1 text-sm">
          <StatRow label="event"><span className="font-mono text-xs">{(allowedEvents || []).join(' · ')}</span></StatRow>
          <StatRow label="identifier"><span className="font-mono text-xs">order_id (or transaction_id) — or any click id</span></StatRow>
          <StatRow label="money"><span className="font-mono text-xs">payout (or value / amount) · currency</span></StatRow>
          <StatRow label="click ids"><span className="font-mono text-xs">fbclid, gclid, ttclid, … or your custom network&apos;s param, or click_id</span></StatRow>
        </div>
        <p className="text-xs text-text-faint">
          A call with neither an order id nor a click id records nothing — that is what stops link
          previews and crawlers from inventing conversions. The endpoint always answers
          <code className="px-1 font-mono">{'{"ok":true}'}</code> whatever happens, including for an
          unknown token, so nobody can probe it for valid tokens. What actually landed is the ledger
          below.
        </p>
      </Panel>

      {loadErr && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/10 text-xs text-amber-400">
          <span>{loadErr}</span>
          <button onClick={load} className="underline cursor-pointer shrink-0">Retry</button>
        </div>
      )}

      {rows === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : rows === 'error' ? (
        <p className="text-sm text-danger">Could not load inbound endpoints.</p>
      ) : (
        <div className="space-y-3">
          {rows.length === 0 && (
            <div className="rounded-lg border border-dashed border-border-default bg-bg-elevated/40 px-4 py-6 text-center text-sm text-text-muted">
              No inbound endpoints yet.
            </div>
          )}
          {rows.map((ep) => (
            <div key={ep.id} className="rounded-xl border border-border-default bg-bg-card p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusDot state={ep.enabled ? 'connected' : 'not_connected'} />
                    <span className="text-sm font-semibold text-text-primary truncate">{ep.label || 'Incoming postbacks'}</span>
                    <ConnChip state={ep.enabled ? 'connected' : 'not_connected'} />
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    {ep.hits} hit{ep.hits === 1 ? '' : 's'}
                    {ep.last_hit_at ? ` · last ${new Date(ep.last_hit_at).toLocaleString()}` : ' · never called'}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <CheckboxRow label="" checked={ep.enabled} disabled={busy === ep.id}
                    onChange={(v) => act(() => api.put(`${base(funnel.id)}/inbound-endpoints/${encodeURIComponent(ep.id)}`, { enabled: v }), ep.id)} />
                  <button
                    onClick={() => act(() => api.post(`${base(funnel.id)}/inbound-endpoints/${encodeURIComponent(ep.id)}/rotate`), ep.id)}
                    disabled={busy === ep.id}
                    title="Rotate the token — the old URL stops working immediately"
                    className="p-1.5 rounded-lg border border-border-default bg-bg-elevated text-text-muted hover:text-text-primary cursor-pointer disabled:opacity-50"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => act(() => api.delete(`${base(funnel.id)}/inbound-endpoints/${encodeURIComponent(ep.id)}`), ep.id)}
                    disabled={busy === ep.id}
                    title="Delete this endpoint"
                    className="p-1.5 rounded-lg border border-border-default bg-bg-elevated text-text-muted hover:text-red-400 cursor-pointer disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <code className="flex-1 min-w-0 block px-3 py-2 text-xs bg-bg-elevated border border-border-default rounded-lg text-text-primary font-mono break-all select-all">
                  {fullUrl(ep)}
                </code>
                <CopyUrlButton value={fullUrl(ep)} />
              </div>
              <p className="text-xs text-text-faint">
                Example: <code className="font-mono break-all">{`${fullUrl(ep)}?event=Purchase&order_id={order_id}&payout={payout}`}</code>
              </p>
            </div>
          ))}
          <Button onClick={() => act(() => api.post(`${base(funnel.id)}/inbound-endpoints`, { label: 'Incoming postbacks' }), 'new')}>
            <Plus className="w-4 h-4 mr-1.5" /> Mint an endpoint
          </Button>
        </div>
      )}

      <Panel>
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-text-primary">Received conversions</div>
          <button onClick={load} className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary cursor-pointer">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
        {events.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-default bg-bg-elevated/40 px-4 py-6 text-center text-sm text-text-muted">
            Nothing received yet. This is the only place a valid postback shows up — the endpoint
            itself deliberately tells the caller nothing.
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {events.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <span className="text-text-primary font-medium">{e.event}</span>
                  {e.payout != null && (
                    <span className="ml-2 text-text-muted">
                      {Number(e.payout).toFixed(2)} {e.currency || ''}
                    </span>
                  )}
                  <div className="text-xs text-text-faint truncate">
                    {e.order_id ? `order ${e.order_id}` : ''}
                    {e.click_id ? ` · ${e.click_key}=${e.click_id}` : ''}
                    {e.network ? ` · ${e.network}` : ''}
                  </div>
                </div>
                <span className="text-xs text-text-faint shrink-0">{e.ts ? new Date(e.ts).toLocaleString() : '—'}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

// The two full-width entry cards the directory shows under the network grid.
export function IntegrationCard({ title, subtitle, meta, onClick, accent }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between gap-3 rounded-xl border border-border-default bg-bg-card p-4 text-left cursor-pointer hover:bg-bg-hover/40 transition-colors"
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="w-9 h-9 rounded-lg shrink-0 grid place-items-center text-xs font-bold"
          style={{ background: `${accent}1a`, color: accent }}>S2S</span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary">{title}</div>
          <div className="text-xs text-text-muted">{subtitle}</div>
          {meta && <div className="mt-1 text-xs text-text-faint">{meta}</div>}
        </div>
      </div>
      <ChevronRight className="w-4 h-4 text-text-faint shrink-0" />
    </button>
  );
}
