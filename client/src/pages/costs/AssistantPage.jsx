// AssistantPage — the third surface of the costs lane (NEW FILE, costs lane).
//
// Three tabs over one idea: get a cost into the catalog without typing into a
// grid, and leave a trail that says where it came from.
//
//   Assistant   — say it in words; Claude maps it to variants and PROPOSES.
//   Quote scan  — upload the supplier's sheet; Claude reads it into a table
//                 you edit and confirm.
//   Audit       — every batch that was actually written, by whom, off what.
//
// NOTHING ON THIS PAGE WRITES A COST EXCEPT AN APPLY. The chat and the scan
// return proposals, which are inert data; the apply posts them to a server
// door that re-validates every one and writes them through the SAME
// append-only path the manual rate drawer uses. So a cost entered here has
// exactly the same history, the same effective-dating and the same
// null-vs-zero behaviour as one typed by hand — it just has a paper trail
// attached.
import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import Card from '../../components/ui/Card';
import Tabs from '../../components/ui/Tabs';
import { usePermissions } from '../../hooks/usePermissions';
import CostsSubnav from './components/CostsSubnav';
import AssistantChatTab from './components/AssistantChatTab';
import QuoteScanPanel from './components/QuoteScanPanel';
import AssistantAuditTab from './components/AssistantAuditTab';
import { fetchVariants, rowsOf } from './costsApi';

const TABS = [
  { value: 'chat', label: 'Assistant' },
  { value: 'scan', label: 'Quote scan' },
  { value: 'audit', label: 'Audit' },
];

export default function AssistantPage() {
  const { hasPermission } = usePermissions();
  // The server gates every write on funnels access; the UI gates the same way
  // so it never renders a control that would 403.
  const canEdit = hasPermission('funnels:access');

  const [tab, setTab] = useState('chat');
  const [rows, setRows] = useState([]);
  // Bumped after any apply so the audit tab and the variant picker re-read.
  const [reloadKey, setReloadKey] = useState(0);

  // The catalog is a CONVENIENCE here (it fills the variant picker and shows
  // "now $3.90" beside a proposal). The server holds the real catalog and
  // re-validates every write against it, so a failed read must not block the
  // page — it just makes the picker emptier.
  //
  // A promise chain, not an awaited helper: every setState then sits inside a
  // callback that runs after the effect body has returned, and the `cancelled`
  // flag stops a late response writing into an unmounted tree.
  useEffect(() => {
    let cancelled = false;
    fetchVariants({ limit: 500 })
      .then((data) => { if (!cancelled) setRows(rowsOf(data)); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const onApplied = useCallback(() => setReloadKey((k) => k + 1), []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
            <Sparkles className="w-5 h-5 text-accent" /> Cost assistant
          </h1>
          <p className="text-sm text-text-muted">
            Enter costs in words, or from a supplier&rsquo;s quote. Every proposal is reviewed by you
            before anything is written.
          </p>
        </div>
        <CostsSubnav />
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="px-4 pt-3">
          <Tabs tabs={TABS} activeTab={tab} onChange={setTab} />
        </div>
        <div className="p-4">
          {tab === 'chat' && <AssistantChatTab canEdit={canEdit} onApplied={onApplied} />}
          {tab === 'scan' && (
            <QuoteScanPanel canEdit={canEdit} catalogRows={rows} onApplied={onApplied} />
          )}
          {tab === 'audit' && <AssistantAuditTab reloadKey={reloadKey} />}
        </div>
      </Card>
    </div>
  );
}
