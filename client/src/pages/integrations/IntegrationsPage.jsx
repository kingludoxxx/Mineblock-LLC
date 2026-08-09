// Integrations — the marketing-integration hub. Klaviyo is live; the rest of
// the grid is HONEST stubs (coming soon, not clickable).
//
// INTEGRATION HOOK (one additive line each, flagged in the lane report):
//   App.jsx    <Route path="integrations" element={<PageGate permission="funnels:access"><IntegrationsPage /></PageGate>} />
//   Sidebar.jsx { to: '/app/integrations', icon: Plug, label: 'Integrations', permission: 'funnels:access' },
//
// Key semantics mirror the server (write-only): the password field left blank
// KEEPS the stored key, "Clear key" sends null to remove it, a typed value
// replaces it. The key itself never round-trips — reads carry api_key_set.
import { useCallback, useEffect, useState } from 'react';
import { Plug, CheckCircle2, XCircle, Loader2, Trash2 } from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';

function StatusChip({ connected }) {
  return connected ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-success/15 text-success border border-success/30">
      <CheckCircle2 size={12} /> CONNECTED
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-bg-elevated text-text-muted border border-border-default">
      <XCircle size={12} /> NOT CONNECTED
    </span>
  );
}

function KlaviyoMark() {
  return (
    <div className="w-9 h-9 rounded-lg bg-[#232426] border border-border-default flex items-center justify-center">
      <span className="text-lg font-black text-[#8ffe81]">K</span>
    </div>
  );
}

function KlaviyoCard() {
  const [view, setView] = useState(null); // { api_key_set, enabled, list_id_default, last_test }
  const [open, setOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [listId, setListId] = useState('');
  const [lists, setLists] = useState(null); // null = not loaded
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, account?, error? }
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get('/integrations/klaviyo');
      const k = res.data?.data?.klaviyo || null;
      setView(k);
      if (k) { setEnabled(Boolean(k.enabled)); setListId(k.list_id_default || ''); }
    } catch (err) {
      setError(err.response?.data?.error?.code === 'internal_error'
        ? 'The server could not read the Klaviyo settings.'
        : 'Could not load the Klaviyo settings.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadLists = useCallback(async () => {
    try {
      const res = await api.get('/integrations/klaviyo/lists');
      const d = res.data?.data;
      if (d?.ok) setLists(d.lists || []);
      else setLists([]);
    } catch { setLists([]); }
  }, []);
  useEffect(() => {
    if (open && view?.api_key_set && lists === null) loadLists();
  }, [open, view, lists, loadLists]);

  const save = async ({ clearKey = false } = {}) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const body = { enabled, list_id_default: listId };
      if (clearKey) body.api_key = null;               // null = remove the key
      else if (keyInput.trim()) body.api_key = keyInput.trim(); // value = replace
      // blank input → api_key omitted → server keeps the stored key
      const res = await api.put('/integrations/klaviyo', body);
      setView(res.data?.data?.klaviyo || null);
      setKeyInput('');
      setTestResult(null);
      if (clearKey) setLists(null);
      else if (body.api_key) { setLists(null); }
    } catch (err) {
      setError(err.response?.data?.error?.code === 'invalid_api_key_type'
        ? 'The API key must be plain text.'
        : 'Saving the Klaviyo settings failed — nothing was changed.');
    } finally { setBusy(false); }
  };

  const test = async () => {
    if (testing) return;
    setTesting(true); setError(''); setTestResult(null);
    try {
      const res = await api.post('/integrations/klaviyo/test', {});
      const d = res.data?.data || {};
      setTestResult(d);
      load(); // last_test is persisted server-side — refresh the chip inputs
    } catch {
      setTestResult({ ok: false, error: 'request_failed' });
    } finally { setTesting(false); }
  };

  const connected = Boolean(view?.api_key_set && view?.enabled && view?.last_test?.ok);

  const testErrorProse = (code) => {
    if (code === 'invalid_api_key') return 'Klaviyo rejected the stored key — paste a current private key (pk_…) and save.';
    if (code === 'not_configured') return 'No API key is stored yet — paste your Klaviyo private key and save first.';
    if (code === 'timeout') return 'Klaviyo did not answer within 15 seconds — try again in a moment.';
    return `The connection test failed (${code || 'unknown'}).`;
  };

  return (
    <div className="bg-bg-card border border-border-default rounded-xl p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <KlaviyoMark />
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Klaviyo</h3>
            <p className="text-xs text-text-muted">Email marketing — profiles, events, lists</p>
          </div>
        </div>
        <StatusChip connected={connected} />
      </div>

      {view?.last_test?.ok && view.last_test.account_name && (
        <p className="text-xs text-text-muted">
          Account: <span className="text-text-primary font-medium">{view.last_test.account_name}</span>
        </p>
      )}

      <div>
        <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? 'Close' : 'Configure'}
        </Button>
      </div>

      {open && (
        <div className="border-t border-border-default pt-4 space-y-4">
          <div className="space-y-1.5">
            <Input
              type="password"
              label={view?.api_key_set ? 'Private API key (saved — leave blank to keep)' : 'Private API key'}
              placeholder={view?.api_key_set ? '••••••••••••' : 'pk_…'}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              autoComplete="off"
            />
            {view?.api_key_set && (
              <button
                type="button"
                onClick={() => save({ clearKey: true })}
                className="inline-flex items-center gap-1 text-xs text-danger hover:underline cursor-pointer"
              >
                <Trash2 size={12} /> Clear key
              </button>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-accent"
            />
            Enabled
          </label>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-text-muted">Default list</label>
            <select
              value={listId}
              onChange={(e) => setListId(e.target.value)}
              disabled={!view?.api_key_set}
              className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50"
            >
              <option value="">No default list</option>
              {listId && !(lists || []).some((l) => l.id === listId) && (
                <option value={listId}>{listId} (saved)</option>
              )}
              {(lists || []).map((l) => (
                <option key={l.id} value={l.id}>{l.name || l.id}</option>
              ))}
            </select>
            {view?.api_key_set && lists !== null && lists.length === 0 && (
              <p className="text-xs text-text-muted">No lists came back — check the key's scopes, then test the connection.</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" loading={busy} onClick={() => save()}>Save</Button>
            <Button size="sm" variant="secondary" loading={testing} onClick={test} disabled={!view?.api_key_set}>
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
          </div>

          {testResult?.ok && (
            <p className="text-xs text-success flex items-center gap-1">
              <CheckCircle2 size={13} /> Connected to <span className="font-semibold">{testResult.account?.name || 'your Klaviyo account'}</span>
            </p>
          )}
          {testResult && !testResult.ok && (
            <p className="text-xs text-danger">{testErrorProse(testResult.error)}</p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}

function StubCard({ name, blurb, mark }) {
  return (
    <div className="bg-bg-card border border-border-default rounded-xl p-5 flex flex-col gap-4 opacity-70">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-bg-elevated border border-border-default flex items-center justify-center text-sm font-bold text-text-muted">
            {mark}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{name}</h3>
            <p className="text-xs text-text-muted">{blurb}</p>
          </div>
        </div>
        <StatusChip connected={false} />
      </div>
      <p className="text-xs text-text-faint">Coming soon.</p>
    </div>
  );
}

export default function IntegrationsPage() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Plug className="text-accent" size={22} />
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Integrations</h1>
          <p className="text-sm text-text-muted">Connect the tools your funnels feed into.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <KlaviyoCard />
        <StubCard name="Google" blurb="Conversions + audiences" mark="G" />
        <StubCard name="GTM" blurb="Tag Manager container" mark="TM" />
        <StubCard name="SMS" blurb="Text-message marketing" mark="SMS" />
      </div>
    </div>
  );
}
