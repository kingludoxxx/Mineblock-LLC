// Domain Hub — buy, transfer, attach, and manage every domain in one place.
// Tabs: Buy a domain · My domains · Connected · DNS records · WHOIS contact.
//
// INTEGRATION HOOK (one additive line each, flagged in the lane report):
//   App.jsx    <Route path="domains" element={<PageGate permission="funnels:access"><DomainHubPage /></PageGate>} />
//   Sidebar.jsx { to: '/app/domains', icon: Globe, label: 'Domain Hub', permission: 'funnels:access' },
import { useCallback, useEffect, useState } from 'react';
import { Globe, BadgeCheck, Plus } from 'lucide-react';
import api from '../../services/api';
import Tabs from '../../components/ui/Tabs';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import {
  BuyTab, MyDomainsTab, ConnectedTab, DnsRecordsTab, WhoisTab,
} from './domainHubTabs.jsx';
import { DomainStatusPill } from './domainHubShared.jsx';

const TABS = [
  { value: 'buy', label: 'Buy a domain' },
  { value: 'mine', label: 'My domains' },
  { value: 'connected', label: 'Connected' },
  { value: 'records', label: 'DNS records' },
  { value: 'whois', label: 'WHOIS contact' },
];

function AttachModal({ prefillDomain, onClose, onAttached }) {
  const [domain, setDomain] = useState(prefillDomain || '');
  const [funnels, setFunnels] = useState([]);
  const [funnelId, setFunnelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    api.get('/funnels')
      .then((res) => setFunnels(res.data?.data?.funnels || []))
      .catch(() => setFunnels([]));
  }, []);

  const attach = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const res = await api.post('/domain-hub/attach', {
        domain: domain.trim(), funnel_id: funnelId,
      });
      setResult(res.data?.data || null);
      onAttached?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Attach failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-bg-card border border-border-default rounded-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {!result ? (
          <form onSubmit={attach} className="space-y-4">
            <h3 className="text-base font-semibold text-text-primary">Attach a domain</h3>
            <Input
              label="Domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="shop.yourbrand.com or yourbrand.com"
              autoFocus
            />
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-text-muted">Funnel</label>
              <select
                value={funnelId}
                onChange={(e) => setFunnelId(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                <option value="" disabled>Select the funnel this domain serves…</option>
                {funnels.map((f) => (
                  <option key={f.id} value={f.id}>{f.name} ({f.slug})</option>
                ))}
              </select>
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" type="button" onClick={onClose}>Cancel</Button>
              <Button size="sm" type="submit" loading={busy} disabled={!domain.trim() || !funnelId}>
                Attach & auto-connect
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-text-primary">{result.domain?.domain}</h3>
              <DomainStatusPill status={result.domain?.status} />
            </div>
            {result.domain?.status === 'connected' ? (
              <p className="text-sm text-text-muted">DNS already points at us — the domain is live.</p>
            ) : (
              <>
                <p className="text-sm text-text-muted">
                  {result.cloudflare?.auto?.ok
                    ? 'Records were created in Cloudflare automatically — verification runs in the background.'
                    : `Create these records at your DNS provider${result.provider && result.provider !== 'unknown' ? ` (detected: ${result.provider})` : ''}. We re-check every minute.`}
                </p>
                <div className="border border-border-default rounded-lg divide-y divide-border-subtle">
                  {(result.records || []).map((r, i) => (
                    <div key={i} className="px-3 py-2 text-xs font-mono flex items-center gap-2">
                      <span className="text-text-muted">{r.type}</span>
                      <span className="text-text-primary">{r.host}</span>
                      <span className="text-text-faint">→</span>
                      <span className="text-text-primary truncate">{r.value}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className="flex justify-end">
              <Button size="sm" onClick={onClose}>Done</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function DomainHubPage() {
  const [tab, setTab] = useState('connected');
  const [registrar, setRegistrar] = useState(null);
  const [domains, setDomains] = useState([]);
  const [selectedDomain, setSelectedDomain] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachPrefill, setAttachPrefill] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api.get('/domain-hub/registrar/status')
      .then((res) => setRegistrar(res.data?.data || null))
      .catch(() => setRegistrar(null));
  }, []);

  const loadDomains = useCallback(async () => {
    try {
      const res = await api.get('/domain-hub/list');
      const rows = res.data?.data || [];
      setDomains(rows);
      setSelectedDomain((cur) => cur || rows[0]?.domain || '');
    } catch { /* list poll owns error surfacing */ }
  }, []);
  useEffect(() => { loadDomains(); }, [loadDomains, refreshKey]);

  const openAttach = (prefill = '') => {
    setAttachPrefill(prefill);
    setAttachOpen(true);
  };

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5">
            <Globe size={20} className="text-accent" />
            <h1 className="text-xl font-semibold text-text-primary">Domain hub</h1>
            {registrar?.configured && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full border bg-green-500/10 text-green-400 border-green-500/20">
                <BadgeCheck size={12} /> {registrar.registrar} connected
              </span>
            )}
          </div>
          <p className="text-sm text-text-muted mt-1">
            Buy, transfer, attach, and manage every domain in one place.
          </p>
        </div>
        <Button size="sm" onClick={() => openAttach()}>
          <Plus size={14} /> Attach a domain
        </Button>
      </div>

      <Tabs tabs={TABS} activeTab={tab} onChange={setTab} />

      <div>
        {tab === 'buy' && (
          <BuyTab
            registrar={registrar}
            onPurchased={() => setTab('mine')}
            goToWhois={() => setTab('whois')}
          />
        )}
        {tab === 'mine' && (
          <MyDomainsTab registrar={registrar} onAttach={(d) => openAttach(d)} />
        )}
        {tab === 'connected' && (
          <ConnectedTab
            refreshKey={refreshKey}
            onAttachNew={() => openAttach()}
            onShowRecords={(d) => { setSelectedDomain(d); setTab('records'); }}
          />
        )}
        {tab === 'records' && (
          <DnsRecordsTab
            domains={domains}
            selected={selectedDomain}
            onSelect={setSelectedDomain}
          />
        )}
        {tab === 'whois' && <WhoisTab />}
      </div>

      {attachOpen && (
        <AttachModal
          prefillDomain={attachPrefill}
          onClose={() => setAttachOpen(false)}
          onAttached={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </div>
  );
}
