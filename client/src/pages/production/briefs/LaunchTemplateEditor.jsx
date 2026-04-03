import { useState, useEffect, useCallback } from 'react';
import {
  X, ArrowLeft, RefreshCw, Loader2, Check, ChevronDown, Plus,
  Users, Target, DollarSign, BarChart3, Tag, Languages, Layout,
  Link2, Eye, Save, Megaphone,
} from 'lucide-react';
import api from '../../../services/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONVERSION_LOCATIONS = ['WEBSITE', 'APP', 'MESSAGING', 'CALLS'];

const CONVERSION_EVENTS = [
  'PURCHASE', 'LEAD', 'COMPLETE_REGISTRATION', 'ADD_TO_CART',
  'INITIATE_CHECKOUT', 'SUBSCRIBE', 'VIEW_CONTENT', 'CONTACT',
  'SEARCH', 'ADD_PAYMENT_INFO', 'ADD_TO_WISHLIST', 'CUSTOMIZE_PRODUCT',
  'FIND_LOCATION', 'SCHEDULE', 'START_TRIAL', 'SUBMIT_APPLICATION',
];

const OPTIMIZATION_GOALS = ['PURCHASE', 'VALUE', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'IMPRESSIONS', 'REACH'];

const BID_STRATEGIES = ['LOWEST_COST', 'MINIMUM_ROAS', 'COST_CAP', 'BID_CAP'];

const PERFORMANCE_GOALS = [
  'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_VALUE', 'MAXIMIZE_REACH',
  'MAXIMIZE_LINK_CLICKS', 'MAXIMIZE_LANDING_PAGE_VIEWS',
];

const ATTRIBUTION_WINDOWS = [
  { value: '7d_click', label: '7-day click only' },
  { value: '1d_click', label: '1-day click' },
  { value: '7d_click_1d_view', label: '7d click + 1d view' },
];

const AD_FORMATS = ['Flexible Ads', 'Single Image', 'Single Video', 'Carousel'];

const GENDERS = ['All', 'Male', 'Female'];

const TRANSLATION_LANGUAGES = [
  'Spanish', 'French', 'German', 'Dutch', 'Italian',
  'Portuguese', 'Polish', 'Swedish', 'Danish', 'Romanian',
];

const NAMING_VARIABLES = ['{date}', '{angle}', '{batch}', '{num}', '{product}'];

const DEFAULT_FORM = {
  name: '',
  accountId: '',
  pageMode: 'single', // 'single' | 'round-robin'
  selectedPages: [],
  pixelId: '',
  campaignId: '',
  adSetNamePattern: '{date} - {angle} - Batch {batch}',
  adNamePattern: '{angle} - {num}',
  conversionLocation: 'WEBSITE',
  conversionEvent: 'PURCHASE',
  dailyBudget: '',
  performanceGoal: 'MAXIMIZE_CONVERSIONS',
  optimizationGoal: 'PURCHASE',
  bidStrategy: 'LOWEST_COST',
  targetRoas: '',
  attribution: '7d_click_1d_view',
  includeAudiences: [],
  excludeAudiences: [],
  countries: [],
  ageMin: 18,
  ageMax: 65,
  gender: 'All',
  adFormat: 'Single Video',
  utmParams: 'utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}',
  translationLanguages: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionLabel({ icon: Icon, children }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {Icon && <Icon className="w-3.5 h-3.5 text-[#c9a84c]" />}
      <h4 className="font-mono text-[10px] text-[#c9a84c] uppercase tracking-[0.15em] font-semibold">
        {children}
      </h4>
    </div>
  );
}

function Input({ value, onChange, type = 'text', placeholder, className = '', ...rest }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full px-3 py-2 bg-white/[0.03] border border-white/[0.06] rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20 transition ${className}`}
      {...rest}
    />
  );
}

function Select({ value, onChange, children, className = '' }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full px-3 py-2 bg-white/[0.03] border border-white/[0.06] rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/30 focus:border-[#c9a84c]/20 appearance-none cursor-pointer transition ${className}`}
      >
        {children}
      </select>
      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
    </div>
  );
}

function FieldLabel({ children }) {
  return <label className="block text-xs text-zinc-400 mb-1.5">{children}</label>;
}

function Card({ children, className = '' }) {
  return (
    <div className={`glass-card border border-white/[0.05] rounded-xl p-5 ${className}`}>
      {children}
    </div>
  );
}

function StatusDot({ active }) {
  return (
    <span className={`inline-block w-1.5 h-1.5 rounded-full ${active ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
  );
}

function resolvePattern(pattern, vars = {}) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const defaults = {
    date: `${pad(today.getMonth() + 1)}${pad(today.getDate())}`,
    angle: 'Dad Bod',
    batch: '1',
    num: '01',
    product: 'Product',
    ...vars,
  };
  return pattern.replace(/\{(\w+)\}/g, (_, k) => defaults[k] ?? `{${k}}`);
}

// ---------------------------------------------------------------------------
// Meta icon (inline SVG)
// ---------------------------------------------------------------------------
function MetaIcon({ className = 'w-5 h-5' }) {
  return (
    <svg viewBox="0 0 36 36" className={className} fill="currentColor">
      <path d="M6.8 18c0-3.2 1.1-6 2.6-7.8 1.2-1.4 2.6-2.2 4-2.2 1.8 0 3.2 1 4.8 3.2l.8 1.2c1.2 1.8 2 2.8 2.4 3.2.6.6 1.2 1 2 1 2.2 0 4-3.2 4-6.4 0-2.2-.6-4.2-1.8-5.8C23.8 2.8 21.2 1.6 18 1.6c-4 0-7.6 2.2-10.2 5.8C5.4 10.8 4 15.2 4 18c0 5.4 2.4 10.4 6.6 13 .6-1 1.4-2.4 2-3.2C10 25.8 6.8 22.2 6.8 18zM18 34.4c3.8 0 7.2-2 9.6-5.4C30 25.8 32 21.2 32 18c0-5.2-2.2-10.2-6.2-13-.6 1-1.4 2.2-2 3.2 2.6 2 5.4 5.6 5.4 9.8 0 3-1 5.8-2.4 7.6-1.2 1.4-2.6 2.2-4 2.2-1.8 0-3.2-1-4.8-3.2l-.8-1.2c-1.2-1.8-2-2.8-2.4-3.2-.6-.6-1.2-1-2-1-2.2 0-4 3.2-4 6.4 0 2.2.6 4.2 1.8 5.8 1.8 1.6 4.4 2.8 7.4 2.8z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// LaunchTemplateEditor
// ---------------------------------------------------------------------------

export default function LaunchTemplateEditor({ open, onClose, template, onSaved }) {
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [accounts, setAccounts] = useState([]);
  const [pages, setPages] = useState([]);
  const [pixels, setPixels] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [audiences, setAudiences] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [countryInput, setCountryInput] = useState('');

  const isEdit = !!template;

  // -- Populate form from template ------------------------------------------
  useEffect(() => {
    if (!open) return;
    if (template) {
      setForm({
        ...DEFAULT_FORM,
        name: template.name || '',
        accountId: template.ad_account_id || '',
        pageMode: template.page_mode === 'round_robin' ? 'round-robin' : 'single',
        selectedPages: (template.page_ids || []).filter(p => p.selected !== false).map(p => p.id),
        pixelId: template.pixel_id || '',
        campaignId: template.campaign_id || '',
        adSetNamePattern: template.adset_name_pattern || DEFAULT_FORM.adSetNamePattern,
        adNamePattern: template.ad_name_pattern || DEFAULT_FORM.adNamePattern,
        conversionLocation: template.conversion_location || 'WEBSITE',
        conversionEvent: template.conversion_event || 'PURCHASE',
        dailyBudget: template.daily_budget ?? '',
        performanceGoal: template.performance_goal || 'MAXIMIZE_CONVERSIONS',
        optimizationGoal: template.optimization_goal || 'PURCHASE',
        bidStrategy: template.bid_strategy === 'LOWEST_COST_WITHOUT_CAP' ? 'LOWEST_COST' : template.bid_strategy === 'LOWEST_COST_WITH_MIN_ROAS' ? 'MINIMUM_ROAS' : template.bid_strategy || 'LOWEST_COST',
        targetRoas: template.target_roas ?? '',
        attribution: template.attribution_window || '7d_click',
        includeAudiences: (template.include_audiences || []).map(a => a.id || a),
        excludeAudiences: (template.exclude_audiences || []).map(a => a.id || a),
        countries: template.countries || [],
        ageMin: template.age_min ?? 18,
        ageMax: template.age_max ?? 65,
        gender: template.gender ? template.gender.charAt(0).toUpperCase() + template.gender.slice(1) : 'All',
        adFormat: template.ad_format === 'FLEXIBLE' ? 'Flexible Ads' : (template.ad_format || 'Flexible Ads').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        utmParams: template.utm_parameters || DEFAULT_FORM.utmParams,
        translationLanguages: template.translation_languages || [],
      });
    } else {
      setForm({ ...DEFAULT_FORM });
    }
  }, [open, template]);

  // -- Load ad accounts on mount --------------------------------------------
  useEffect(() => {
    if (!open) return;
    loadAccounts();
  }, [open]);

  const loadAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const { data } = await api.get('/brief-pipeline/meta/accounts');
      setAccounts(data.data || []);
    } catch (err) {
      console.error('Failed to load ad accounts:', err);
    } finally {
      setLoadingAccounts(false);
    }
  };

  // -- Sync account data when account changes -------------------------------
  const syncAccount = useCallback(async (accountId) => {
    if (!accountId) return;
    setSyncing(true);
    try {
      const { data } = await api.get(`/brief-pipeline/meta/sync/${accountId}`);
      const d = data.data || data || {};
      setPages(d.pages || []);
      setPixels(d.pixels || []);
      setCampaigns(d.campaigns || []);
      setAudiences(d.audiences || []);
    } catch (err) {
      console.error('Failed to sync account:', err);
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    if (form.accountId) syncAccount(form.accountId);
  }, [form.accountId, syncAccount]);

  // -- Field updater ---------------------------------------------------------
  const set = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));

  const toggleArrayItem = (field, item) => {
    setForm((f) => {
      const arr = f[field] || [];
      return { ...f, [field]: arr.includes(item) ? arr.filter((i) => i !== item) : [...arr, item] };
    });
  };

  const addCountry = () => {
    const c = countryInput.trim().toUpperCase();
    if (c && !form.countries.includes(c)) {
      setForm((f) => ({ ...f, countries: [...f.countries, c] }));
    }
    setCountryInput('');
  };

  const removeCountry = (c) => {
    setForm((f) => ({ ...f, countries: f.countries.filter((x) => x !== c) }));
  };

  // -- Save -----------------------------------------------------------------
  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      // When sync data is available, use it; otherwise preserve original template data
      const resolvedPages = pages.length
        ? pages.filter(p => form.selectedPages.includes(p.id)).map(p => ({ id: p.id, name: p.name, selected: true }))
        : (template?.page_ids || []).filter(p => form.selectedPages.includes(p.id));
      const resolvedInclude = audiences.length
        ? audiences.filter(a => form.includeAudiences.includes(a.id))
        : (template?.include_audiences || []).filter(a => form.includeAudiences.includes(a.id || a));
      const resolvedExclude = audiences.length
        ? audiences.filter(a => form.excludeAudiences.includes(a.id))
        : (template?.exclude_audiences || []).filter(a => form.excludeAudiences.includes(a.id || a));

      const payload = {
        name: form.name,
        ad_account_id: form.accountId,
        ad_account_name: accounts.find(a => a.id === form.accountId)?.name || form.accountId,
        page_mode: form.pageMode === 'round-robin' ? 'round_robin' : 'single',
        page_ids: resolvedPages,
        pixel_id: form.pixelId,
        pixel_name: pixels.find(p => p.id === form.pixelId)?.name || (template?.pixel_name || ''),
        campaign_id: form.campaignId,
        campaign_name: campaigns.find(c => c.id === form.campaignId)?.name || (template?.campaign_name || ''),
        adset_name_pattern: form.adSetNamePattern,
        ad_name_pattern: form.adNamePattern,
        conversion_location: form.conversionLocation,
        conversion_event: form.conversionEvent,
        daily_budget: parseFloat(form.dailyBudget) || 150,
        performance_goal: form.performanceGoal,
        optimization_goal: form.optimizationGoal,
        bid_strategy: form.bidStrategy === 'MINIMUM_ROAS' ? 'LOWEST_COST_WITH_MIN_ROAS' : form.bidStrategy === 'LOWEST_COST' ? 'LOWEST_COST_WITHOUT_CAP' : form.bidStrategy,
        target_roas: form.bidStrategy === 'MINIMUM_ROAS' ? (parseFloat(form.targetRoas) ?? null) : null,
        attribution_window: form.attribution,
        include_audiences: resolvedInclude,
        exclude_audiences: resolvedExclude,
        countries: form.countries.length ? form.countries : ['US'],
        age_min: form.ageMin ?? 18,
        age_max: form.ageMax ?? 65,
        gender: form.gender.toLowerCase(),
        ad_format: form.adFormat === 'Flexible Ads' ? 'FLEXIBLE' : form.adFormat.toUpperCase().replace(/ /g, '_'),
        utm_parameters: form.utmParams,
        translation_languages: form.translationLanguages,
        product_id: null,
      };
      if (isEdit && template.id) {
        await api.put(`/brief-pipeline/launch-templates/${template.id}`, payload);
      } else {
        await api.post('/brief-pipeline/launch-templates', payload);
      }
      onSaved?.();
      onClose();
    } catch (err) {
      console.error('Failed to save template:', err);
      setSaveError(err.response?.data?.error?.message || err.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  // -- Guard ----------------------------------------------------------------
  if (!open) return null;

  // -- Round-robin next indicator -------------------------------------------
  const rrSelectedPages = pages.filter((p) => form.selectedPages.includes(p.id));
  const rrNextPage = rrSelectedPages[0];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div
        className="relative w-full max-w-[720px] h-full bg-[#111113] border-l border-white/[0.06] shadow-2xl flex flex-col"
        style={{ animation: 'slideInRight 0.25s ease-out' }}
      >
        {/* ---------------------------------------------------------------- */}
        {/* Header                                                           */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-white/[0.06] shrink-0">
          <button onClick={onClose} className="text-zinc-400 hover:text-white transition-colors cursor-pointer">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <MetaIcon className="w-5 h-5 text-[#0081FB]" />
          <h2 className="text-base font-semibold text-white flex-1 truncate">
            {isEdit ? form.name || 'Edit Template' : 'New Launch Template'}
          </h2>
          <button
            onClick={() => form.accountId && syncAccount(form.accountId)}
            disabled={!form.accountId || syncing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg transition disabled:opacity-40 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            Sync
          </button>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Scrollable body                                                  */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">

          {/* 1. Template Name */}
          <Card>
            <SectionLabel icon={Tag}>Template Name</SectionLabel>
            <Input
              value={form.name}
              onChange={set('name')}
              placeholder="e.g. US - Purchase - CBO"
            />
          </Card>

          {/* 2. Ad Account */}
          <Card>
            <SectionLabel icon={Users}>Ad Account</SectionLabel>
            {loadingAccounts ? (
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading accounts...
              </div>
            ) : (
              <Select value={form.accountId} onChange={set('accountId')}>
                <option value="">Select ad account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name || a.id}
                  </option>
                ))}
              </Select>
            )}
          </Card>

          {/* 3. Facebook Page */}
          <Card>
            <SectionLabel icon={Megaphone}>Facebook Page</SectionLabel>
            {/* Mode toggle */}
            <div className="flex items-center gap-1 mb-4 p-0.5 bg-white/[0.03] rounded-lg w-fit">
              {['single', 'round-robin'].map((mode) => (
                <button
                  key={mode}
                  onClick={() => set('pageMode')(mode)}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition cursor-pointer ${
                    form.pageMode === mode
                      ? 'bg-[#c9a84c] text-[#111113]'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {mode === 'single' ? 'Single' : 'Round-Robin'}
                </button>
              ))}
            </div>

            {form.pageMode === 'round-robin' && rrSelectedPages.length > 0 && (
              <div className="mb-3 text-xs text-zinc-500">
                <span className="text-[#c9a84c]">{rrSelectedPages.length}</span> pages selected
                {rrNextPage && (
                  <span className="ml-2 text-zinc-600">
                    next: <span className="text-zinc-400">{rrNextPage.name}</span>
                  </span>
                )}
              </div>
            )}

            {syncing ? (
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Syncing pages...
              </div>
            ) : pages.length === 0 ? (
              <p className="text-xs text-zinc-600">Select an ad account to load pages</p>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {pages.map((page) => (
                  <label
                    key={page.id}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-white/[0.03] transition cursor-pointer"
                  >
                    <input
                      type={form.pageMode === 'single' ? 'radio' : 'checkbox'}
                      name="fb-page"
                      checked={form.selectedPages.includes(page.id)}
                      onChange={() => {
                        if (form.pageMode === 'single') {
                          set('selectedPages')([page.id]);
                        } else {
                          toggleArrayItem('selectedPages', page.id);
                        }
                      }}
                      className="accent-[#c9a84c]"
                    />
                    <span className="text-sm text-white truncate">{page.name}</span>
                  </label>
                ))}
              </div>
            )}
          </Card>

          {/* 4. Conversion Pixel */}
          <Card>
            <SectionLabel icon={Eye}>Conversion Pixel</SectionLabel>
            <Select value={form.pixelId} onChange={set('pixelId')}>
              <option value="">Select pixel</option>
              {pixels.map((p) => (
                <option key={p.id} value={p.id}>{p.name || p.id}</option>
              ))}
            </Select>
          </Card>

          {/* 5. Campaign */}
          <Card>
            <SectionLabel icon={Target}>Campaign</SectionLabel>
            <Select value={form.campaignId} onChange={set('campaignId')}>
              <option value="">Select campaign</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            {form.campaignId && (() => {
              const camp = campaigns.find((c) => c.id === form.campaignId);
              if (!camp) return null;
              return (
                <div className="flex items-center gap-2 mt-2 text-xs text-zinc-400">
                  <StatusDot active={camp.status === 'ACTIVE'} />
                  <span>{camp.status || 'UNKNOWN'}</span>
                </div>
              );
            })()}
          </Card>

          {/* 6. Naming Convention */}
          <Card>
            <SectionLabel icon={Tag}>Naming Convention</SectionLabel>
            <div className="space-y-4">
              <div>
                <FieldLabel>Ad Set Name Pattern</FieldLabel>
                <Input
                  value={form.adSetNamePattern}
                  onChange={set('adSetNamePattern')}
                  placeholder="{date} - {angle} - Batch {batch}"
                />
                <p className="mt-1.5 text-[11px] text-zinc-600 font-mono">
                  Preview: <span className="text-zinc-400">{resolvePattern(form.adSetNamePattern)}</span>
                </p>
              </div>
              <div>
                <FieldLabel>Ad Name Pattern</FieldLabel>
                <Input
                  value={form.adNamePattern}
                  onChange={set('adNamePattern')}
                  placeholder="{angle} - {num}"
                />
                <p className="mt-1.5 text-[11px] text-zinc-600 font-mono">
                  Preview: <span className="text-zinc-400">{resolvePattern(form.adNamePattern)}</span>
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {NAMING_VARIABLES.map((v) => (
                  <span
                    key={v}
                    className="px-2 py-0.5 text-[10px] font-mono bg-[#c9a84c]/10 text-[#e8d5a3] border border-[#c9a84c]/20 rounded-md"
                  >
                    {v}
                  </span>
                ))}
              </div>
            </div>
          </Card>

          {/* 7. Conversion */}
          <Card>
            <SectionLabel icon={Target}>Conversion</SectionLabel>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <FieldLabel>Conversion Location</FieldLabel>
                <Select value={form.conversionLocation} onChange={set('conversionLocation')}>
                  {CONVERSION_LOCATIONS.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </Select>
              </div>
              <div>
                <FieldLabel>Conversion Event</FieldLabel>
                <Select value={form.conversionEvent} onChange={set('conversionEvent')}>
                  {CONVERSION_EVENTS.map((e) => (
                    <option key={e} value={e}>{e}</option>
                  ))}
                </Select>
              </div>
            </div>
          </Card>

          {/* 8. Budget & Bid */}
          <Card>
            <SectionLabel icon={DollarSign}>Budget &amp; Bid</SectionLabel>
            <div className="space-y-4">
              <div>
                <FieldLabel>Daily Budget ($)</FieldLabel>
                <Input
                  type="number"
                  value={form.dailyBudget}
                  onChange={set('dailyBudget')}
                  placeholder="50"
                  min="0"
                  step="1"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <FieldLabel>Performance Goal</FieldLabel>
                  <Select value={form.performanceGoal} onChange={set('performanceGoal')}>
                    {PERFORMANCE_GOALS.map((g) => (
                      <option key={g} value={g}>{g.replace(/_/g, ' ')}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <FieldLabel>Optimization Goal</FieldLabel>
                  <Select value={form.optimizationGoal} onChange={set('optimizationGoal')}>
                    {OPTIMIZATION_GOALS.map((g) => (
                      <option key={g} value={g}>{g}</option>
                    ))}
                  </Select>
                </div>
              </div>
              <div>
                <FieldLabel>Bid Strategy</FieldLabel>
                <Select value={form.bidStrategy} onChange={set('bidStrategy')}>
                  {BID_STRATEGIES.map((s) => (
                    <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                  ))}
                </Select>
              </div>
              {form.bidStrategy === 'MINIMUM_ROAS' && (
                <div>
                  <FieldLabel>Target ROAS</FieldLabel>
                  <Input
                    type="number"
                    value={form.targetRoas}
                    onChange={set('targetRoas')}
                    placeholder="2.0"
                    min="0"
                    step="0.1"
                  />
                </div>
              )}
            </div>
          </Card>

          {/* 9. Attribution */}
          <Card>
            <SectionLabel icon={BarChart3}>Attribution</SectionLabel>
            <Select value={form.attribution} onChange={set('attribution')}>
              {ATTRIBUTION_WINDOWS.map((a) => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </Select>
          </Card>

          {/* 10. Audience */}
          <Card>
            <SectionLabel icon={Users}>Audience</SectionLabel>
            <div className="space-y-4">
              {/* Include */}
              <div>
                <FieldLabel>Include Audiences</FieldLabel>
                {audiences.length === 0 ? (
                  <p className="text-xs text-zinc-600">Sync an account to load audiences</p>
                ) : (
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {audiences.map((aud) => (
                      <label
                        key={aud.id}
                        className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-white/[0.03] transition cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={form.includeAudiences.includes(aud.id)}
                          onChange={() => toggleArrayItem('includeAudiences', aud.id)}
                          className="accent-[#c9a84c]"
                        />
                        <span className="text-sm text-white truncate">{aud.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Exclude */}
              <div>
                <FieldLabel>Exclude Audiences</FieldLabel>
                {audiences.length === 0 ? (
                  <p className="text-xs text-zinc-600">Sync an account to load audiences</p>
                ) : (
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {audiences.map((aud) => (
                      <label
                        key={aud.id}
                        className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-white/[0.03] transition cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={form.excludeAudiences.includes(aud.id)}
                          onChange={() => toggleArrayItem('excludeAudiences', aud.id)}
                          className="accent-[#c9a84c]"
                        />
                        <span className="text-sm text-white truncate">{aud.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Countries */}
              <div>
                <FieldLabel>Countries</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    value={countryInput}
                    onChange={setCountryInput}
                    placeholder="e.g. US"
                    className="flex-1"
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCountry())}
                  />
                  <button
                    onClick={addCountry}
                    className="px-3 py-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg text-zinc-400 hover:text-white transition cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                {form.countries.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {form.countries.map((c) => (
                      <span
                        key={c}
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono bg-white/[0.04] border border-white/[0.06] rounded-md text-zinc-300"
                      >
                        {c}
                        <button
                          onClick={() => removeCountry(c)}
                          className="text-zinc-600 hover:text-red-400 transition cursor-pointer"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Age */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <FieldLabel>Age Min</FieldLabel>
                  <Input
                    type="number"
                    value={form.ageMin}
                    onChange={(v) => set('ageMin')(Number(v))}
                    min="13"
                    max="65"
                  />
                </div>
                <div>
                  <FieldLabel>Age Max</FieldLabel>
                  <Input
                    type="number"
                    value={form.ageMax}
                    onChange={(v) => set('ageMax')(Number(v))}
                    min="13"
                    max="65"
                  />
                </div>
              </div>

              {/* Gender */}
              <div>
                <FieldLabel>Gender</FieldLabel>
                <div className="flex items-center gap-1 p-0.5 bg-white/[0.03] rounded-lg w-fit">
                  {GENDERS.map((g) => (
                    <button
                      key={g}
                      onClick={() => set('gender')(g)}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition cursor-pointer ${
                        form.gender === g
                          ? 'bg-[#c9a84c] text-[#111113]'
                          : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Card>

          {/* 11. Ad Format */}
          <Card>
            <SectionLabel icon={Layout}>Ad Format</SectionLabel>
            <Select value={form.adFormat} onChange={set('adFormat')}>
              {AD_FORMATS.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </Select>
          </Card>

          {/* 12. UTM Parameters */}
          <Card>
            <SectionLabel icon={Link2}>UTM Parameters</SectionLabel>
            <Input
              value={form.utmParams}
              onChange={set('utmParams')}
              placeholder="utm_source=facebook&utm_medium=paid..."
            />
            <p className="mt-1.5 text-[11px] text-zinc-600">
              Available macros: <span className="font-mono text-zinc-500">{'{{campaign.name}}'}</span>{' '}
              <span className="font-mono text-zinc-500">{'{{adset.name}}'}</span>{' '}
              <span className="font-mono text-zinc-500">{'{{ad.name}}'}</span>{' '}
              <span className="font-mono text-zinc-500">{'{{ad.id}}'}</span>
            </p>
          </Card>

          {/* 13. Translation Languages */}
          <Card>
            <SectionLabel icon={Languages}>Translation Languages</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {TRANSLATION_LANGUAGES.map((lang) => {
                const selected = form.translationLanguages.includes(lang);
                return (
                  <button
                    key={lang}
                    onClick={() => toggleArrayItem('translationLanguages', lang)}
                    className={`px-3 py-1 text-xs font-medium rounded-full border transition cursor-pointer ${
                      selected
                        ? 'bg-[#c9a84c]/15 text-[#e8d5a3] border-[#c9a84c]/30'
                        : 'bg-white/[0.02] text-zinc-500 border-white/[0.06] hover:text-zinc-300 hover:border-white/[0.1]'
                    }`}
                  >
                    {lang}
                  </button>
                );
              })}
            </div>
          </Card>

          {/* 14. Launch Summary */}
          <Card>
            <SectionLabel icon={BarChart3}>Launch Summary</SectionLabel>
            <div className="divide-y divide-white/[0.04]">
              {[
                ['Template', form.name || '—'],
                ['Account', accounts.find((a) => a.id === form.accountId)?.name || form.accountId || '—'],
                ['Page Mode', form.pageMode === 'round-robin' ? `Round-Robin (${rrSelectedPages.length})` : 'Single'],
                ['Pixel', pixels.find((p) => p.id === form.pixelId)?.name || form.pixelId || '—'],
                ['Campaign', campaigns.find((c) => c.id === form.campaignId)?.name || '—'],
                ['Conversion', `${form.conversionEvent} on ${form.conversionLocation}`],
                ['Budget', form.dailyBudget ? `$${form.dailyBudget}/day` : '—'],
                ['Bid Strategy', form.bidStrategy.replace(/_/g, ' ')],
                ...(form.bidStrategy === 'MINIMUM_ROAS' ? [['Target ROAS', form.targetRoas || '—']] : []),
                ['Attribution', ATTRIBUTION_WINDOWS.find((a) => a.value === form.attribution)?.label || '—'],
                ['Countries', form.countries.length ? form.countries.join(', ') : '—'],
                ['Age', `${form.ageMin} – ${form.ageMax}`],
                ['Gender', form.gender],
                ['Ad Format', form.adFormat],
                ['Languages', form.translationLanguages.length ? form.translationLanguages.join(', ') : 'None'],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
                  <span className="text-xs text-zinc-500">{label}</span>
                  <span className="text-xs text-zinc-300 text-right max-w-[60%] truncate">{value}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Footer                                                           */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/[0.06] shrink-0">
          <button
            onClick={onClose}
            className="flex items-center gap-2 px-4 py-2 text-sm text-zinc-400 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg transition cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Templates
          </button>
          <button
            onClick={handleSave}
            disabled={saving || syncing || !form.name}
            className="flex items-center gap-2 px-5 py-2 text-sm font-semibold bg-[#c9a84c] hover:bg-[#d4b55a] text-[#111113] rounded-lg transition disabled:opacity-50 cursor-pointer"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : syncing ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {syncing ? 'Syncing...' : 'Save Template'}
          </button>
        </div>
        {saveError && (
          <div className="px-6 py-2 bg-red-950/50 border-t border-red-500/20 text-red-300 text-xs">
            {saveError}
          </div>
        )}
      </div>
    </div>
  );
}
