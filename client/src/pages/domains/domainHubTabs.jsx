// Domain Hub — the five tab bodies. All data flows through /api/v1/domain-hub.
import { useCallback, useEffect, useState } from 'react';
import {
  Search, ShoppingCart, RefreshCw, Trash2, Wand2, ExternalLink,
} from 'lucide-react';
import api from '../../services/api';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import {
  DomainStatusPill, CopyButton, EmptyState, ConfirmModal,
} from './domainHubShared.jsx';

const errOf = (e, fallback) => e?.response?.data?.error || fallback;

// ── Buy a domain ────────────────────────────────────────────────────────────
export function BuyTab({ registrar, onPurchased, goToWhois }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [buying, setBuying] = useState(null); // domain being confirmed
  const [busy, setBusy] = useState(false);

  const search = async (e) => {
    e?.preventDefault();
    if (!q.trim() || loading) return;
    setLoading(true); setError(null); setRows(null);
    try {
      const res = await api.get('/domain-hub/search', { params: { q: q.trim() } });
      setRows(res.data?.data?.results || []);
    } catch (err) {
      setError(errOf(err, 'Search failed'));
    } finally {
      setLoading(false);
    }
  };

  const purchase = async () => {
    setBusy(true); setError(null);
    try {
      await api.post('/domain-hub/purchase', { domain: buying.domain, confirm: true });
      setBuying(null);
      onPurchased?.(buying.domain);
      await search();
    } catch (err) {
      const code = errOf(err, 'Purchase failed');
      setBuying(null);
      if (code === 'whois_contact_required') {
        setError('No WHOIS contact stored yet — fill it in on the WHOIS contact tab first.');
        goToWhois?.();
      } else {
        setError(code);
      }
    } finally {
      setBusy(false);
    }
  };

  const registrarReady = registrar?.configured;

  return (
    <div className="space-y-4">
      {!registrarReady && (
        <div className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
          Registrar not connected — set the Namecheap API env vars to enable search and purchase.
        </div>
      )}
      <form onSubmit={search} className="flex gap-2">
        <div className="flex-1">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a name — e.g. glowbrand or glowbrand.com"
            disabled={!registrarReady}
          />
        </div>
        <Button type="submit" loading={loading} disabled={!registrarReady || !q.trim()}>
          <Search size={15} /> Search
        </Button>
      </form>
      {error && <p className="text-xs text-danger">{error}</p>}

      {rows && rows.length === 0 && (
        <EmptyState title="No results" hint="Try a different name." />
      )}
      {rows && rows.length > 0 && (
        <div className="border border-border-default rounded-xl overflow-hidden">
          {rows.map((r) => (
            <div
              key={r.domain}
              className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle last:border-b-0 bg-bg-card"
            >
              <div className="flex items-center gap-3">
                <span className="text-sm text-text-primary font-medium">{r.domain}</span>
                {r.premium && (
                  <span className="px-1.5 py-0.5 text-[10px] rounded border bg-accent-muted text-accent-text border-accent/20">premium</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {r.available ? (
                  <>
                    <span className="text-sm text-text-primary">
                      {r.price != null ? `$${Number(r.price).toFixed(2)}` : 'price n/a'}
                      <span className="text-text-faint text-xs">/yr</span>
                    </span>
                    <Button size="sm" onClick={() => setBuying(r)}>
                      <ShoppingCart size={13} /> Buy
                    </Button>
                  </>
                ) : (
                  <span className="text-xs text-text-faint">taken</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {buying && (
        <ConfirmModal
          title={`Buy ${buying.domain}?`}
          danger
          requireText={buying.domain}
          body={
            <>
              <p>
                This purchase uses your <b>{registrar?.registrar}</b> registrar account and
                spends <b>real money</b>{buying.price != null ? ` (~$${Number(buying.price).toFixed(2)}/yr)` : ''}.
              </p>
              <p>The stored WHOIS contact will be used as the registrant.</p>
            </>
          }
          confirmLabel="Buy domain"
          busy={busy}
          onClose={() => setBuying(null)}
          onConfirm={purchase}
        />
      )}
    </div>
  );
}

// ── My domains (registrar-owned) ────────────────────────────────────────────
export function MyDomainsTab({ registrar, onAttach }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get('/domain-hub/owned');
        if (alive) setRows(res.data?.data?.domains || []);
      } catch (err) {
        if (alive) { setError(errOf(err, 'Failed to load')); setRows([]); }
      }
    })();
    return () => { alive = false; };
  }, []);

  if (!registrar?.configured) {
    return <EmptyState title="Registrar not connected" hint="Connect Namecheap to see the domains in your account." />;
  }
  if (rows === null) return <p className="text-sm text-text-muted py-8 text-center">Loading…</p>;
  if (error) return <p className="text-xs text-danger py-4">{error}</p>;
  if (!rows.length) {
    return <EmptyState title="No domains yet" hint="Head to the Buy tab to register your first domain — it appears here the moment the order settles." />;
  }
  return (
    <div className="border border-border-default rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-text-muted bg-bg-elevated">
            <th className="px-4 py-2 font-medium">Domain</th>
            <th className="px-4 py-2 font-medium">Expires</th>
            <th className="px-4 py-2 font-medium">Auto-renew</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.domain} className="border-t border-border-subtle bg-bg-card">
              <td className="px-4 py-2.5 text-text-primary font-medium">{d.domain}</td>
              <td className="px-4 py-2.5 text-text-muted">{d.expires || '—'}</td>
              <td className="px-4 py-2.5 text-text-muted">{d.auto_renew ? 'on' : 'off'}</td>
              <td className="px-4 py-2.5 text-right">
                <Button size="sm" variant="secondary" onClick={() => onAttach?.(d.domain)}>
                  Attach to funnel
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Connected (attached domains, live-polled) ───────────────────────────────
export function ConnectedTab({ onAttachNew, onShowRecords, refreshKey }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [verifying, setVerifying] = useState(null);
  const [detaching, setDetaching] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/domain-hub/list');
      setRows(res.data?.data || []);
      setError(null);
    } catch (err) {
      setError(errOf(err, 'Failed to load domains'));
    }
  }, []);

  // Live status poll — pending/verifying rows flip to connected as the
  // background sweep progresses.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  const verifyNow = async (domain) => {
    setVerifying(domain);
    try {
      await api.post(`/domain-hub/${encodeURIComponent(domain)}/verify`);
      await load();
    } catch (err) {
      setError(errOf(err, 'Verify failed'));
    } finally {
      setVerifying(null);
    }
  };

  const detach = async () => {
    setBusy(true);
    try {
      await api.delete(`/domain-hub/${encodeURIComponent(detaching.domain)}`, {
        data: { confirm: detaching.domain },
      });
      setDetaching(null);
      await load();
    } catch (err) {
      setError(errOf(err, 'Detach failed'));
      setDetaching(null);
    } finally {
      setBusy(false);
    }
  };

  if (rows === null) return <p className="text-sm text-text-muted py-8 text-center">Loading…</p>;
  if (!rows.length) {
    return (
      <EmptyState
        title="No domains attached yet"
        hint="Attach a domain you already own, or head to the Buy tab to register a new one."
        action={<Button size="sm" onClick={onAttachNew}>Attach a domain</Button>}
      />
    );
  }
  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end">
        <Button size="sm" onClick={onAttachNew}>Attach a domain</Button>
      </div>
      <div className="border border-border-default rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted bg-bg-elevated">
              <th className="px-4 py-2 font-medium">Domain</th>
              <th className="px-4 py-2 font-medium">Funnel</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Provider</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.domain} className="border-t border-border-subtle bg-bg-card">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-text-primary font-medium">{d.domain}</span>
                    {d.status === 'connected' && (
                      <a
                        href={`https://${d.domain}`} target="_blank" rel="noreferrer"
                        className="text-text-faint hover:text-text-primary"
                      >
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                  {/* A reason can accompany a NON-error status too — e.g. a
                      production deploy with no Render credentials holds the row
                      at `verifying` and says why. Only style it as a failure
                      when the row actually parked at `error`. */}
                  {d.error_detail && (
                    <p className={`text-[11px] mt-0.5 ${d.status === 'error' ? 'text-danger' : 'text-yellow-400'}`}>
                      {d.error_detail}
                    </p>
                  )}
                </td>
                <td className="px-4 py-2.5 text-text-muted">{d.funnel_id}</td>
                <td className="px-4 py-2.5"><DomainStatusPill status={d.status} /></td>
                <td className="px-4 py-2.5 text-text-muted">{d.dns_provider || '—'}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => onShowRecords?.(d.domain)}>
                      Records
                    </Button>
                    <Button
                      size="sm" variant="secondary"
                      loading={verifying === d.domain}
                      onClick={() => verifyNow(d.domain)}
                    >
                      <RefreshCw size={12} /> Verify now
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDetaching(d)}>
                      <Trash2 size={13} className="text-danger" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detaching && (
        <ConfirmModal
          title={`Detach ${detaching.domain}?`}
          danger
          requireText={detaching.domain}
          body={
            <p>
              This removes the domain from the Render service and stops it serving
              its funnel. Visitors on this domain will get the default app.
            </p>
          }
          confirmLabel="Detach domain"
          busy={busy}
          onClose={() => setDetaching(null)}
          onConfirm={detach}
        />
      )}
    </div>
  );
}

// ── DNS records (per selected domain) ───────────────────────────────────────
export function DnsRecordsTab({ domains, selected, onSelect }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [autoBusy, setAutoBusy] = useState(false);

  const load = useCallback(async (domain) => {
    if (!domain) { setData(null); return; }
    setError(null);
    try {
      const res = await api.get(`/domain-hub/${encodeURIComponent(domain)}/records`);
      setData(res.data?.data || null);
    } catch (err) {
      setError(errOf(err, 'Failed to load records'));
      setData(null);
    }
  }, []);

  useEffect(() => { load(selected); }, [selected, load]);

  const autoCreate = async () => {
    setAutoBusy(true); setError(null);
    try {
      await api.post(`/domain-hub/${encodeURIComponent(selected)}/auto-dns`);
      await load(selected);
    } catch (err) {
      setError(errOf(err, 'Auto-create failed'));
    } finally {
      setAutoBusy(false);
    }
  };

  if (!domains.length) {
    return <EmptyState title="No domains yet" hint="Attach a domain first — its required DNS records will show up here." />;
  }

  const observedRows = [];
  if (data?.observed) {
    for (const c of data.observed.cname || []) observedRows.push({ type: 'CNAME', value: c });
    for (const a of data.observed.a || []) observedRows.push({ type: 'A', value: a });
    for (const a of data.observed.aaaa || []) observedRows.push({ type: 'AAAA', value: a });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select
          value={selected || ''}
          onChange={(e) => onSelect(e.target.value)}
          className="px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40"
        >
          <option value="" disabled>Select a domain…</option>
          {domains.map((d) => <option key={d.domain} value={d.domain}>{d.domain}</option>)}
        </select>
        {data && <DomainStatusPill status={data.status} />}
        {data?.provider && <span className="text-xs text-text-muted">provider: {data.provider}</span>}
        {data?.cloudflare_configured && (
          <Button size="sm" variant="secondary" loading={autoBusy} onClick={autoCreate}>
            <Wand2 size={13} /> Auto-create in Cloudflare
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="border border-border-default rounded-xl overflow-hidden">
            <div className="px-4 py-2 text-xs font-medium text-text-muted bg-bg-elevated">
              Required records
            </div>
            {(data.required || []).map((r, i) => (
              <div key={i} className="px-4 py-2.5 border-t border-border-subtle bg-bg-card">
                <div className="flex items-center gap-2 text-sm">
                  <span className="px-1.5 py-0.5 text-[10px] rounded border bg-bg-elevated text-text-muted border-border-default">{r.type}</span>
                  <span className="text-text-primary font-mono text-xs">{r.name}</span>
                  <span className="text-text-faint">→</span>
                  <span className="text-text-primary font-mono text-xs truncate">{r.value}</span>
                  <CopyButton value={r.value} />
                </div>
                {r.note && <p className="text-[11px] text-text-faint mt-1">{r.note}</p>}
              </div>
            ))}
          </div>
          <div className="border border-border-default rounded-xl overflow-hidden">
            <div className="px-4 py-2 text-xs font-medium text-text-muted bg-bg-elevated">
              Currently seen in DNS (live lookup)
            </div>
            {observedRows.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-text-faint bg-bg-card">
                Nothing yet — records can take a few minutes to propagate.
              </div>
            )}
            {observedRows.map((r, i) => (
              <div key={i} className="px-4 py-2.5 border-t border-border-subtle bg-bg-card first:border-t-0">
                <div className="flex items-center gap-2 text-sm">
                  <span className="px-1.5 py-0.5 text-[10px] rounded border bg-bg-elevated text-text-muted border-border-default">{r.type}</span>
                  <span className="text-text-primary font-mono text-xs truncate">{r.value}</span>
                  <CopyButton value={r.value} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── WHOIS contact ───────────────────────────────────────────────────────────
const WHOIS_FIELDS = [
  ['first_name', 'First name'], ['last_name', 'Last name'],
  ['organization', 'Organization (optional)'], ['email', 'Email'],
  ['phone', 'Phone (+1.5551234567)'], ['address1', 'Address'],
  ['address2', 'Address 2 (optional)'], ['city', 'City'],
  ['state_province', 'State / Province'], ['postal_code', 'Postal code'],
  ['country', 'Country (2-letter)'],
];

export function WhoisTab() {
  const [contact, setContact] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get('/domain-hub/whois')
      .then((res) => { if (alive && res.data?.data?.contact) setContact(res.data.data.contact); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setError(null); setSaved(false);
    try {
      await api.put('/domain-hub/whois', { contact });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(errOf(err, 'Save failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="max-w-2xl space-y-4">
      <p className="text-xs text-text-muted">
        Stored once and used as the registrant / admin / tech contact on every
        domain purchase. Namecheap requires all non-optional fields.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {WHOIS_FIELDS.map(([key, label]) => (
          <Input
            key={key}
            label={label}
            value={contact[key] || ''}
            onChange={(e) => setContact((c) => ({ ...c, [key]: e.target.value }))}
          />
        ))}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" loading={saving}>Save contact</Button>
        {saved && <span className="text-xs text-green-400">Saved</span>}
      </div>
    </form>
  );
}
