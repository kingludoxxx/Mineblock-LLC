import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import { useAuth } from '../hooks/useAuth';
import {
  Users,
  UserPlus,
  Shield,
  Mail,
  Clock,
  Check,
  X,
  Copy,
  AlertTriangle,
  Loader2,
  ChevronDown,
  Eye,
  EyeOff,
  Settings2,
} from 'lucide-react';

// ── Page categories for custom access ────────────────────────────────────────

const PAGE_CATEGORIES = [
  {
    label: 'Intelligence',
    pages: [
      { key: 'meta-ads', label: 'Meta Ads' },
      { key: 'google-ads', label: 'Google Ads' },
      { key: 'youtube-ads', label: 'YouTube Ads' },
      { key: 'tiktok-ads', label: 'TikTok Ads' },
      { key: 'tiktok-shop', label: 'TikTok Shop' },
      { key: 'tiktok-organic', label: 'TikTok Organic' },
      { key: 'brands', label: 'Brands' },
      { key: 'following', label: 'Following' },
      { key: 'saved', label: 'Saved' },
      { key: 'creative-intelligence', label: 'Creative Intelligence' },
    ],
  },
  {
    label: 'Production',
    pages: [
      { key: 'brief-pipeline', label: 'Brief Pipeline' },
      { key: 'brief-agent', label: 'Brief Agent' },
      { key: 'magic-ads', label: 'Magic Ads' },
      { key: 'iteration-king', label: 'Iteration King' },
      { key: 'images', label: 'Images' },
      { key: 'video', label: 'Video' },
      { key: 'audio', label: 'Audio' },
      { key: 'statics-generation', label: 'Statics' },
      { key: 'ads-launcher', label: 'Ads Launcher' },
    ],
  },
  {
    label: 'Performance',
    pages: [
      { key: 'creative-analysis', label: 'Creative Analysis' },
      { key: 'kpi-system', label: 'KPI System' },
      { key: 'attribution', label: 'Attribution' },
      { key: 'live-metrics', label: 'Live Metrics' },
      { key: 'ltv', label: 'LTV' },
      { key: 'roas', label: 'ROAS' },
      { key: 'ads-control-center', label: 'Ads Control Center' },
    ],
  },
  {
    label: 'Lab',
    pages: [
      { key: 'avatars', label: 'Avatars' },
      { key: 'mechanisms', label: 'Mechanisms' },
      { key: 'offers', label: 'Offers' },
      { key: 'products', label: 'Products' },
      { key: 'funnels', label: 'Funnels' },
    ],
  },
  {
    label: 'Library',
    pages: [
      { key: 'team-hub', label: 'Team Hub' },
      { key: 'assets', label: 'Assets' },
      { key: 'todo', label: 'Todo' },
    ],
  },
  {
    label: 'Ops',
    pages: [
      { key: 'support', label: 'Support' },
      { key: 'api-runs', label: 'API Runs' },
      { key: 'ops-dashboard', label: 'Ops Dashboard' },
      { key: 'scrape-runs', label: 'Scrape Runs' },
      { key: 'status', label: 'Status' },
    ],
  },
];

const ALL_PAGE_KEYS = PAGE_CATEGORIES.flatMap((c) => c.pages.map((p) => p.key));

const PAGE_KEY_TO_LABEL = {};
PAGE_CATEGORIES.forEach((c) => c.pages.forEach((p) => { PAGE_KEY_TO_LABEL[p.key] = p.label; }));

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(dateStr) {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd}/${yy} ${hh}:${min}`;
}

/** Extract page keys from a role's permissions JSONB */
function extractPagesFromPermissions(permissions) {
  if (!permissions) return [];
  if (typeof permissions === 'string') {
    try { permissions = JSON.parse(permissions); } catch { return []; }
  }
  if (typeof permissions === 'object' && !Array.isArray(permissions)) {
    return Object.keys(permissions).filter((k) => k !== 'dashboard' && k !== 'all' && k !== 'settings' && k !== 'team');
  }
  return [];
}

/** Get display-friendly page labels from a member's roles */
function getMemberPageLabels(member) {
  const roles = member.roles || [];
  const pageSet = new Set();
  for (const role of roles) {
    const perms = role.permissions;
    if (!perms) continue;
    let parsed = perms;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { continue; }
    }
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Check for "all" access
      if (parsed.all) return [{ key: 'all', label: 'All Pages' }];
      for (const key of Object.keys(parsed)) {
        if (key !== 'dashboard' && key !== 'settings' && key !== 'team') {
          pageSet.add(key);
        }
      }
    }
  }
  return Array.from(pageSet).map((key) => ({
    key,
    label: PAGE_KEY_TO_LABEL[key] || key.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
  }));
}

// ── Sub-components ───────────────────────────────────────────────────────────

function RoleBadge({ roleName }) {
  const colors = {
    SuperAdmin: 'bg-accent-muted text-accent-text border-accent/20',
    Admin: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    Editor: 'bg-green-500/10 text-green-400 border-green-500/20',
    Viewer: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
  };
  const isCustom = roleName?.startsWith('Custom -');
  const cls = isCustom
    ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
    : colors[roleName] || 'bg-white/5 text-white/60 border-white/10';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      <Shield className="w-3 h-3" />
      {isCustom ? 'Custom Access' : roleName}
    </span>
  );
}

function PageBadges({ member }) {
  const pages = getMemberPageLabels(member);
  if (pages.length === 0) return null;
  if (pages.length === 1 && pages[0].key === 'all') {
    return (
      <div className="flex flex-wrap gap-1 mt-1.5">
        <span className="px-1.5 py-0.5 bg-accent-muted text-accent-text rounded text-[10px] font-medium">
          All Pages
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {pages.slice(0, 5).map((p) => (
        <span key={p.key} className="px-1.5 py-0.5 bg-white/5 text-text-muted rounded text-[10px]">
          {p.label}
        </span>
      ))}
      {pages.length > 5 && (
        <span className="px-1.5 py-0.5 bg-white/5 text-text-faint rounded text-[10px]">
          +{pages.length - 5} more
        </span>
      )}
    </div>
  );
}

function StatusDot({ active }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={`w-2 h-2 rounded-full ${active ? 'bg-success' : 'bg-danger'}`} />
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

function ConfirmDialog({ open, title, message, onConfirm, onCancel, loading }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-bg-elevated border border-border-default rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-danger/10 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-danger" />
          </div>
          <h3 className="text-lg font-semibold text-text-primary">{title}</h3>
        </div>
        <p className="text-text-muted text-sm mb-6">{message}</p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm rounded-lg border border-border-default text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-4 py-2 text-sm rounded-lg bg-danger hover:bg-danger-hover text-white transition-colors cursor-pointer flex items-center gap-2"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Deactivate
          </button>
        </div>
      </div>
    </div>
  );
}

function RoleDropdown({ roles, currentRoleId, onChange, loading }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={loading}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border-default text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
      >
        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
        Change Role
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 bg-bg-elevated border border-border-default rounded-lg shadow-2xl py-1 min-w-[180px]">
            {roles.map((role) => (
              <button
                key={role.id}
                onClick={() => {
                  if (role.id !== currentRoleId) onChange(role.id);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-sm transition-colors cursor-pointer flex items-center justify-between
                  ${role.id === currentRoleId ? 'bg-bg-active text-accent-text' : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'}`}
              >
                <span>{role.name}</span>
                {role.id === currentRoleId && <Check className="w-3.5 h-3.5 text-accent" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Page checkboxes component ────────────────────────────────────────────────

function PageCheckboxes({ selectedPages, onChange }) {
  const toggle = (key) => {
    if (selectedPages.includes(key)) {
      onChange(selectedPages.filter((p) => p !== key));
    } else {
      onChange([...selectedPages, key]);
    }
  };

  const toggleCategory = (cat) => {
    const catKeys = cat.pages.map((p) => p.key);
    const allSelected = catKeys.every((k) => selectedPages.includes(k));
    if (allSelected) {
      onChange(selectedPages.filter((p) => !catKeys.includes(p)));
    } else {
      const merged = new Set([...selectedPages, ...catKeys]);
      onChange(Array.from(merged));
    }
  };

  const selectAll = () => {
    if (selectedPages.length === ALL_PAGE_KEYS.length) {
      onChange([]);
    } else {
      onChange([...ALL_PAGE_KEYS]);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-faint font-medium uppercase tracking-wider">Page Access</span>
        <button
          type="button"
          onClick={selectAll}
          className="text-xs text-accent hover:text-accent-hover transition-colors cursor-pointer"
        >
          {selectedPages.length === ALL_PAGE_KEYS.length ? 'Deselect All' : 'Select All'}
        </button>
      </div>
      {PAGE_CATEGORIES.map((cat) => {
        const catKeys = cat.pages.map((p) => p.key);
        const allSelected = catKeys.every((k) => selectedPages.includes(k));
        const someSelected = catKeys.some((k) => selectedPages.includes(k));
        return (
          <div key={cat.label} className="bg-bg-main border border-border-subtle rounded-lg p-3">
            <label className="flex items-center gap-2 mb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                onChange={() => toggleCategory(cat)}
                className="w-3.5 h-3.5 rounded border-border-default text-accent focus:ring-accent/30 bg-bg-main cursor-pointer"
              />
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">{cat.label}</span>
            </label>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pl-1">
              {cat.pages.map((page) => (
                <label key={page.key} className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={selectedPages.includes(page.key)}
                    onChange={() => toggle(page.key)}
                    className="w-3.5 h-3.5 rounded border-border-default text-accent focus:ring-accent/30 bg-bg-main cursor-pointer"
                  />
                  <span className="text-sm text-text-muted group-hover:text-text-primary transition-colors">{page.label}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Edit Access Modal ────────────────────────────────────────────────────────

function EditAccessModal({ open, onClose, member, onSaved }) {
  const [selectedPages, setSelectedPages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open && member) {
      // Pre-check based on current permissions
      const roles = member.roles || [];
      const currentPages = new Set();
      for (const role of roles) {
        for (const key of extractPagesFromPermissions(role.permissions)) {
          currentPages.add(key);
        }
      }
      setSelectedPages(Array.from(currentPages));
      setError('');
    }
  }, [open, member]);

  const handleSave = async () => {
    if (selectedPages.length === 0) {
      setError('Select at least one page.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const memberId = member.id || member.userId;
      await api.put(`/team/${memberId}/pages`, { pages: selectedPages });
      onSaved();
      onClose();
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.message || 'Failed to update page access.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  const memberName = [member?.firstName, member?.lastName].filter(Boolean).join(' ') || member?.email || '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-bg-elevated border border-border-default rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-purple-500/10 flex items-center justify-center">
              <Settings2 className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Edit Page Access</h3>
              <p className="text-xs text-text-muted">{memberName}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-text-faint hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="bg-danger/10 border border-danger/30 rounded-lg px-4 py-3 text-sm text-danger flex items-center gap-2 mb-4">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        <PageCheckboxes selectedPages={selectedPages} onChange={setSelectedPages} />

        <div className="flex gap-3 justify-end mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-border-default text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={loading || selectedPages.length === 0}
            className="px-4 py-2.5 text-sm rounded-lg bg-accent hover:bg-accent-hover text-white font-medium transition-colors cursor-pointer flex items-center gap-2 disabled:opacity-50"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Save Access
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Invite Modal ─────────────────────────────────────────────────────────────

function InviteModal({ open, onClose, roles, onInvited }) {
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', roleId: '' });
  const [accessMode, setAccessMode] = useState('preset'); // 'preset' | 'custom'
  const [selectedPages, setSelectedPages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [selectedRolePermissions, setSelectedRolePermissions] = useState([]);

  useEffect(() => {
    if (form.roleId && roles.length > 0) {
      const role = roles.find((r) => String(r.id) === String(form.roleId));
      if (role) {
        const perms = role.permissions;
        let parsed = perms;
        if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { parsed = null; } }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          setSelectedRolePermissions(
            Object.keys(parsed).map((k) => PAGE_KEY_TO_LABEL[k] || k.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')),
          );
        } else {
          setSelectedRolePermissions([]);
        }
      } else {
        setSelectedRolePermissions([]);
      }
    } else {
      setSelectedRolePermissions([]);
    }
  }, [form.roleId, roles]);

  const reset = () => {
    setForm({ email: '', firstName: '', lastName: '', roleId: '' });
    setAccessMode('preset');
    setSelectedPages([]);
    setError('');
    setResult(null);
    setCopied(false);
    setShowPassword(false);
    setSelectedRolePermissions([]);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.email || !form.firstName || !form.lastName) {
      setError('Name and email are required.');
      return;
    }
    if (accessMode === 'preset' && !form.roleId) {
      setError('Please select a role.');
      return;
    }
    if (accessMode === 'custom' && selectedPages.length === 0) {
      setError('Please select at least one page.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const payload = {
        email: form.email,
        firstName: form.firstName,
        lastName: form.lastName,
      };
      if (accessMode === 'custom') {
        payload.pages = selectedPages;
      } else {
        payload.roleId = form.roleId;
      }
      const res = await api.post('/team/invite', payload);
      setResult(res.data);
      onInvited();
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.message || 'Failed to invite team member.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    const pw = result?.temporaryPassword || result?.password || '';
    if (!pw) return;
    try {
      await navigator.clipboard.writeText(pw);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const el = document.createElement('textarea');
      el.value = pw;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!open) return null;

  const tempPassword = result?.temporaryPassword || result?.password || '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-bg-elevated border border-border-default rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-accent-muted flex items-center justify-center">
              <UserPlus className="w-5 h-5 text-accent" />
            </div>
            <h3 className="text-lg font-semibold text-text-primary">Invite Team Member</h3>
          </div>
          <button onClick={handleClose} className="p-1.5 rounded-lg text-text-faint hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {result ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-success text-sm">
              <Check className="w-4 h-4" />
              <span>Team member invited successfully!</span>
            </div>
            {tempPassword && (
              <div className="bg-warning/10 border border-warning/30 rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2 text-warning text-sm font-medium">
                  <AlertTriangle className="w-4 h-4" />
                  Temporary Password
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-black/40 text-text-primary px-3 py-2 rounded-lg text-sm font-mono">
                    {showPassword ? tempPassword : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                  </code>
                  <button
                    onClick={() => setShowPassword(!showPassword)}
                    className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                    title={showPassword ? 'Hide' : 'Show'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={handleCopy}
                    className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                    title="Copy"
                  >
                    {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-xs text-warning/80">
                  Share this password securely. They will be asked to change it on first login.
                </p>
              </div>
            )}
            <button
              onClick={handleClose}
              className="w-full mt-2 px-4 py-2 text-sm rounded-lg bg-accent hover:bg-accent-hover text-white transition-colors cursor-pointer"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-danger/10 border border-danger/30 rounded-lg px-4 py-3 text-sm text-danger flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-text-muted mb-1.5">First Name</label>
                <input
                  type="text"
                  value={form.firstName}
                  onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  className="w-full bg-bg-main border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-faint focus:border-accent/50 focus:outline-none transition-colors"
                  placeholder="John"
                />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1.5">Last Name</label>
                <input
                  type="text"
                  value={form.lastName}
                  onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  className="w-full bg-bg-main border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-faint focus:border-accent/50 focus:outline-none transition-colors"
                  placeholder="Doe"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-text-muted mb-1.5">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-faint" />
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full bg-bg-main border border-border-default rounded-lg pl-10 pr-3 py-2 text-sm text-text-primary placeholder:text-text-faint focus:border-accent/50 focus:outline-none transition-colors"
                  placeholder="john@example.com"
                />
              </div>
            </div>

            {/* Access mode toggle */}
            <div>
              <label className="block text-xs text-text-muted mb-2">Access Type</label>
              <div className="flex rounded-lg border border-border-default overflow-hidden">
                <button
                  type="button"
                  onClick={() => setAccessMode('preset')}
                  className={`flex-1 px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
                    accessMode === 'preset'
                      ? 'bg-accent text-white'
                      : 'bg-bg-main text-text-muted hover:text-text-primary hover:bg-bg-hover'
                  }`}
                >
                  Preset Role
                </button>
                <button
                  type="button"
                  onClick={() => setAccessMode('custom')}
                  className={`flex-1 px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
                    accessMode === 'custom'
                      ? 'bg-accent text-white'
                      : 'bg-bg-main text-text-muted hover:text-text-primary hover:bg-bg-hover'
                  }`}
                >
                  Custom Pages
                </button>
              </div>
            </div>

            {accessMode === 'preset' ? (
              <>
                <div>
                  <label className="block text-xs text-text-muted mb-1.5">Role</label>
                  <select
                    value={form.roleId}
                    onChange={(e) => setForm({ ...form, roleId: e.target.value })}
                    className="w-full bg-bg-main border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary focus:border-accent/50 focus:outline-none transition-colors cursor-pointer"
                  >
                    <option value="">Select a role...</option>
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                </div>

                {selectedRolePermissions.length > 0 && (
                  <div className="bg-bg-main border border-border-subtle rounded-lg p-3">
                    <p className="text-xs text-text-faint mb-2 font-medium uppercase tracking-wider">Access granted</p>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedRolePermissions.map((perm) => (
                        <span key={perm} className="px-2 py-0.5 bg-accent-muted text-accent-text rounded-md text-xs">
                          {perm}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <PageCheckboxes selectedPages={selectedPages} onChange={setSelectedPages} />
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-2.5 text-sm rounded-lg bg-accent hover:bg-accent-hover text-white font-medium transition-colors cursor-pointer flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Send Invite
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function TeamManagement() {
  const { user } = useAuth();
  const [members, setMembers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(null);
  const [editAccessMember, setEditAccessMember] = useState(null);
  const [actionLoading, setActionLoading] = useState({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [membersRes, rolesRes] = await Promise.all([
        api.get('/team'),
        api.get('/users/roles'),
      ]);
      setMembers(membersRes.data?.members || membersRes.data || []);
      setRoles(rolesRes.data?.roles || rolesRes.data || []);
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.message || 'Failed to load team data.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleChangeRole = async (userId, roleId) => {
    setActionLoading((prev) => ({ ...prev, [`role-${userId}`]: true }));
    try {
      await api.put(`/team/${userId}/role`, { roleId });
      await fetchData();
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.message || 'Failed to change role.';
      setError(msg);
    } finally {
      setActionLoading((prev) => ({ ...prev, [`role-${userId}`]: false }));
    }
  };

  const handleDeactivate = async (userId) => {
    setActionLoading((prev) => ({ ...prev, [`deactivate-${userId}`]: true }));
    try {
      await api.delete(`/team/${userId}`);
      setConfirmDeactivate(null);
      await fetchData();
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.message || 'Failed to deactivate member.';
      setError(msg);
    } finally {
      setActionLoading((prev) => ({ ...prev, [`deactivate-${userId}`]: false }));
    }
  };

  const handleReactivate = async (userId) => {
    setActionLoading((prev) => ({ ...prev, [`reactivate-${userId}`]: true }));
    try {
      await api.patch(`/team/${userId}/activate`);
      await fetchData();
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.message || 'Failed to reactivate member.';
      setError(msg);
    } finally {
      setActionLoading((prev) => ({ ...prev, [`reactivate-${userId}`]: false }));
    }
  };

  const currentUserId = user?.id || user?.userId;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Users className="w-7 h-7 text-accent" />
            Team Management
          </h1>
          <p className="text-text-muted text-sm mt-1">Manage your team members, roles, and permissions</p>
        </div>
        <button
          onClick={() => setInviteOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 text-sm rounded-lg bg-accent hover:bg-accent-hover text-white font-medium transition-colors cursor-pointer"
        >
          <UserPlus className="w-4 h-4" />
          Invite Member
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-danger/10 border border-danger/30 rounded-xl px-4 py-3 text-sm text-danger flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="p-1 hover:bg-danger/20 rounded transition-colors cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-accent" />
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && members.length === 0 && (
        <div className="bg-bg-card border border-border-default rounded-xl p-12 text-center">
          <Users className="w-12 h-12 text-text-faint mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2">No team members yet</h3>
          <p className="text-text-muted text-sm mb-6">Invite your first team member to get started.</p>
          <button
            onClick={() => setInviteOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm rounded-lg bg-accent hover:bg-accent-hover text-white font-medium transition-colors cursor-pointer"
          >
            <UserPlus className="w-4 h-4" />
            Invite Member
          </button>
        </div>
      )}

      {/* Members table -- desktop */}
      {!loading && members.length > 0 && (
        <div className="bg-bg-card border border-border-default rounded-xl overflow-hidden">
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="text-left px-5 py-3 text-xs font-medium text-text-faint uppercase tracking-wider">Member</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-text-faint uppercase tracking-wider">Role / Access</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-text-faint uppercase tracking-wider">Status</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-text-faint uppercase tracking-wider">Last Login</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-text-faint uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {members.map((member) => {
                  const memberId = member.id || member.userId;
                  const isCurrentUser = String(memberId) === String(currentUserId);
                  const memberName = [member.firstName, member.lastName].filter(Boolean).join(' ') || member.name || member.email;
                  const primaryRole = member.roles?.[0] || {};
                  const roleName = primaryRole.name || member.roleName || member.role?.name || member.role || '-';
                  const roleId = primaryRole.id || member.roleId || member.role?.id;
                  const isActive = member.isActive !== false && member.active !== false;

                  return (
                    <tr key={memberId} className="hover:bg-bg-hover/50 transition-colors">
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-accent-muted flex items-center justify-center text-accent-text text-sm font-semibold shrink-0">
                            {(member.firstName?.[0] || member.email?.[0] || '?').toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="text-text-primary font-medium truncate flex items-center gap-2">
                              {memberName}
                              {isCurrentUser && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-muted text-accent-text font-medium">You</span>
                              )}
                            </div>
                            <div className="text-text-faint text-xs truncate">{member.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <RoleBadge roleName={roleName} />
                        <PageBadges member={member} />
                      </td>
                      <td className="px-5 py-4">
                        <StatusDot active={isActive} />
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-text-muted text-xs flex items-center gap-1.5">
                          <Clock className="w-3 h-3" />
                          {fmtDate(member.lastLogin || member.lastLoginAt)}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-2 justify-end">
                          {!isCurrentUser && (
                            <>
                              <button
                                onClick={() => setEditAccessMember(member)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-purple-500/30 text-purple-400 hover:bg-purple-500/10 transition-colors cursor-pointer"
                              >
                                <Settings2 className="w-3 h-3" />
                                Edit Access
                              </button>
                              <RoleDropdown
                                roles={roles}
                                currentRoleId={roleId}
                                loading={actionLoading[`role-${memberId}`]}
                                onChange={(newRoleId) => handleChangeRole(memberId, newRoleId)}
                              />
                              {isActive ? (
                                <button
                                  onClick={() => setConfirmDeactivate(member)}
                                  disabled={actionLoading[`deactivate-${memberId}`]}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-danger/30 text-danger hover:bg-danger/10 transition-colors cursor-pointer"
                                >
                                  <X className="w-3 h-3" />
                                  Deactivate
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleReactivate(memberId)}
                                  disabled={actionLoading[`reactivate-${memberId}`]}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-green-500/30 text-green-400 hover:bg-green-500/10 transition-colors cursor-pointer"
                                >
                                  <Check className="w-3 h-3" />
                                  {actionLoading[`reactivate-${memberId}`] ? 'Reactivating…' : 'Reactivate'}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-border-subtle">
            {members.map((member) => {
              const memberId = member.id || member.userId;
              const isCurrentUser = String(memberId) === String(currentUserId);
              const memberName = [member.firstName, member.lastName].filter(Boolean).join(' ') || member.name || member.email;
              const primaryRole = member.roles?.[0] || {};
              const roleName = primaryRole.name || member.roleName || member.role?.name || member.role || '-';
              const roleId = primaryRole.id || member.roleId || member.role?.id;
              const isActive = member.isActive !== false && member.active !== false;

              return (
                <div key={memberId} className="p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-accent-muted flex items-center justify-center text-accent-text text-sm font-semibold shrink-0">
                        {(member.firstName?.[0] || member.email?.[0] || '?').toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="text-text-primary font-medium text-sm flex items-center gap-2">
                          {memberName}
                          {isCurrentUser && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-muted text-accent-text font-medium">You</span>
                          )}
                        </div>
                        <div className="text-text-faint text-xs">{member.email}</div>
                      </div>
                    </div>
                    <StatusDot active={isActive} />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <RoleBadge roleName={roleName} />
                      <PageBadges member={member} />
                    </div>
                    <span className="text-text-muted text-xs flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {fmtDate(member.lastLogin || member.lastLoginAt)}
                    </span>
                  </div>
                  {!isCurrentUser && (
                    <div className="flex gap-2 pt-1 flex-wrap">
                      <button
                        onClick={() => setEditAccessMember(member)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-purple-500/30 text-purple-400 hover:bg-purple-500/10 transition-colors cursor-pointer"
                      >
                        <Settings2 className="w-3 h-3" />
                        Edit Access
                      </button>
                      <RoleDropdown
                        roles={roles}
                        currentRoleId={roleId}
                        loading={actionLoading[`role-${memberId}`]}
                        onChange={(newRoleId) => handleChangeRole(memberId, newRoleId)}
                      />
                      <button
                        onClick={() => setConfirmDeactivate(member)}
                        disabled={actionLoading[`deactivate-${memberId}`]}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-danger/30 text-danger hover:bg-danger/10 transition-colors cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                        Deactivate
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Footer count */}
          <div className="border-t border-border-subtle px-5 py-3 text-xs text-text-faint">
            {members.length} team member{members.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      {/* Invite modal */}
      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        roles={roles}
        onInvited={fetchData}
      />

      {/* Edit Access modal */}
      <EditAccessModal
        open={!!editAccessMember}
        onClose={() => setEditAccessMember(null)}
        member={editAccessMember}
        onSaved={fetchData}
      />

      {/* Deactivate confirmation */}
      <ConfirmDialog
        open={!!confirmDeactivate}
        title="Deactivate Member"
        message={`Are you sure you want to deactivate ${confirmDeactivate?.firstName || confirmDeactivate?.email || 'this member'}? They will lose access to the dashboard immediately.`}
        loading={actionLoading[`deactivate-${confirmDeactivate?.id || confirmDeactivate?.userId}`]}
        onConfirm={() => handleDeactivate(confirmDeactivate?.id || confirmDeactivate?.userId)}
        onCancel={() => setConfirmDeactivate(null)}
      />
    </div>
  );
}
