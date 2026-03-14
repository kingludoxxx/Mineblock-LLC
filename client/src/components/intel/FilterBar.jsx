import { useState, useRef, useEffect } from 'react';
import { Search, X, ChevronDown, Calendar } from 'lucide-react';

function Dropdown({ label, value, options, onChange, multi = false, selected = [] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const displayValue = multi
    ? selected.length > 0
      ? `${label} (${selected.length})`
      : label
    : value || label;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors cursor-pointer whitespace-nowrap ${
          (multi ? selected.length > 0 : value)
            ? 'border-accent/40 bg-accent-muted text-accent'
            : 'border-border-default bg-bg-elevated text-text-muted hover:text-text-primary hover:bg-bg-hover'
        }`}
      >
        {displayValue}
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute top-full mt-1 left-0 z-40 min-w-[160px] bg-bg-card border border-border-default rounded-lg shadow-xl py-1 max-h-60 overflow-y-auto">
          {options.map((opt) => {
            const optValue = typeof opt === 'string' ? opt : opt.value;
            const optLabel = typeof opt === 'string' ? opt : opt.label;
            const isSelected = multi ? selected.includes(optValue) : value === optValue;

            return (
              <button
                key={optValue}
                onClick={() => {
                  if (multi) {
                    const next = isSelected
                      ? selected.filter((s) => s !== optValue)
                      : [...selected, optValue];
                    onChange(next);
                  } else {
                    onChange(isSelected ? '' : optValue);
                    setOpen(false);
                  }
                }}
                className={`w-full text-left px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-accent-muted text-accent'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                {multi && (
                  <span className={`inline-block w-3.5 h-3.5 mr-2 rounded border align-middle ${
                    isSelected ? 'bg-accent border-accent' : 'border-border-strong'
                  }`}>
                    {isSelected && (
                      <svg className="w-3.5 h-3.5 text-white" viewBox="0 0 14 14" fill="none">
                        <path d="M3 7l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                )}
                {optLabel}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const dateRangeOptions = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
];

const sortOptions = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'longest', label: 'Longest running' },
  { value: 'recent', label: 'Recently seen' },
];

export default function FilterBar({
  filters,
  onFilterChange,
  platformOptions = [],
  formatOptions = [],
  languageOptions = [],
  countryOptions = [],
  extraFilters = null,
}) {
  const hasActiveFilters =
    filters.search ||
    filters.dateRange !== 'all' ||
    filters.platform ||
    filters.format ||
    (filters.languages && filters.languages.length > 0) ||
    (filters.countries && filters.countries.length > 0) ||
    filters.sort !== 'newest';

  function clearAll() {
    onFilterChange({
      search: '',
      dateRange: 'all',
      platform: '',
      format: '',
      languages: [],
      countries: [],
      sort: 'newest',
    });
  }

  return (
    <div className="space-y-3">
      {/* Search row */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-faint" />
        <input
          type="text"
          value={filters.search}
          onChange={(e) => onFilterChange({ ...filters, search: e.target.value })}
          placeholder="Search ads by brand, keyword, or URL..."
          className="w-full pl-10 pr-4 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
        />
        {filters.search && (
          <button
            onClick={() => onFilterChange({ ...filters, search: '' })}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-faint hover:text-text-primary cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Filter chips row */}
      <div className="flex items-center gap-2 flex-wrap">
        <Dropdown
          label="Date Range"
          value={filters.dateRange}
          options={dateRangeOptions}
          onChange={(v) => onFilterChange({ ...filters, dateRange: v || 'all' })}
        />

        {platformOptions.length > 0 && (
          <Dropdown
            label="Platform"
            value={filters.platform}
            options={platformOptions}
            onChange={(v) => onFilterChange({ ...filters, platform: v })}
          />
        )}

        {formatOptions.length > 0 && (
          <Dropdown
            label="Ad Format"
            value={filters.format}
            options={formatOptions}
            onChange={(v) => onFilterChange({ ...filters, format: v })}
          />
        )}

        {languageOptions.length > 0 && (
          <Dropdown
            label="Language"
            multi
            selected={filters.languages || []}
            options={languageOptions}
            onChange={(v) => onFilterChange({ ...filters, languages: v })}
          />
        )}

        {countryOptions.length > 0 && (
          <Dropdown
            label="Country"
            multi
            selected={filters.countries || []}
            options={countryOptions}
            onChange={(v) => onFilterChange({ ...filters, countries: v })}
          />
        )}

        <Dropdown
          label="Sort"
          value={filters.sort}
          options={sortOptions}
          onChange={(v) => onFilterChange({ ...filters, sort: v || 'newest' })}
        />

        {extraFilters}

        {hasActiveFilters && (
          <button
            onClick={clearAll}
            className="flex items-center gap-1 px-3 py-1.5 text-sm text-danger hover:text-danger-hover transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
