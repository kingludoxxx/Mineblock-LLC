import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

// ── Helpers ──────────────────────────────────────────────────────────────────

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function toDateStr(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDate(str) {
  const [y, m, d] = (str || '').split('-').map(Number);
  return { year: y || new Date().getFullYear(), month: (m || 1) - 1, day: d || 1 };
}

function isSameDay(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function getToday() {
  const t = new Date();
  return { year: t.getFullYear(), month: t.getMonth(), day: t.getDate() };
}

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year, month) {
  return new Date(year, month, 1).getDay();
}

/** Get the Sunday-start week row index (0-based) for a given day in the calendar grid */
function getWeekRow(year, month, day) {
  const firstDay = getFirstDayOfWeek(year, month);
  return Math.floor((firstDay + day - 1) / 7);
}

function formatDisplay(dateStr) {
  const { year, month, day } = parseDate(dateStr);
  return `${MONTHS_SHORT[month]} ${day}, ${year}`;
}

// ── Calendar Grid Builder ────────────────────────────────────────────────────

function buildCalendarGrid(year, month) {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfWeek(year, month);
  const prevMonthDays = getDaysInMonth(year, month - 1);

  const cells = [];

  // Leading days from previous month
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const m = month === 0 ? 11 : month - 1;
    const y = month === 0 ? year - 1 : year;
    cells.push({ day: d, month: m, year: y, outside: true });
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, month, year, outside: false });
  }

  // Trailing days from next month
  const remaining = 42 - cells.length; // always show 6 rows
  for (let d = 1; d <= remaining; d++) {
    const m = month === 11 ? 0 : month + 1;
    const y = month === 11 ? year + 1 : year;
    cells.push({ day: d, month: m, year: y, outside: true });
  }

  // Chunk into weeks (rows of 7)
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}

// ── Day Grid (daily / weekly modes) ─────────────────────────────────────────

function DayGrid({ viewYear, viewMonth, selected, today, period, pendingDate, onSelect }) {
  const weeks = useMemo(() => buildCalendarGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  const sel = parseDate(pendingDate);
  const selectedWeekRow = period === 'weekly' && !sel.outside
    ? getWeekRow(viewYear, viewMonth, sel.day)
    : -1;

  // For weekly mode, check if the selected date is in the viewed month
  const selInView = sel.year === viewYear && sel.month === viewMonth;

  return (
    <div className="px-3 pb-2">
      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 mb-1">
        {DAYS.map((d) => (
          <div key={d} className="text-center text-[10px] font-medium text-[#888] py-1.5 select-none">
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="space-y-0.5">
        {weeks.map((week, wi) => {
          const isSelectedWeek = period === 'weekly' && selInView && wi === selectedWeekRow;
          return (
            <div
              key={wi}
              className={`grid grid-cols-7 rounded-lg transition-colors ${
                isSelectedWeek ? 'bg-accent/15' : ''
              }`}
            >
              {week.map((cell, ci) => {
                const isToday = isSameDay(cell, today);
                const isSelected = isSameDay(cell, sel);
                const key = `${cell.year}-${cell.month}-${cell.day}`;

                let cellClass =
                  'relative w-full aspect-square flex items-center justify-center text-xs rounded-full cursor-pointer transition-all duration-150 select-none';

                if (isSelected) {
                  cellClass += ' bg-accent text-white font-semibold';
                } else if (cell.outside) {
                  cellClass += ' text-[#555] hover:bg-white/[0.06]';
                } else {
                  cellClass += ' text-white hover:bg-white/[0.06]';
                }

                if (isToday && !isSelected) {
                  cellClass += ' ring-1 ring-accent/50';
                }

                return (
                  <button
                    key={key + ci}
                    type="button"
                    className={cellClass}
                    onClick={() => onSelect(toDateStr(cell.year, cell.month, cell.day))}
                  >
                    {cell.day}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Month Grid (monthly mode) ───────────────────────────────────────────────

function MonthGrid({ viewYear, selected, today, onSelect }) {
  const sel = parseDate(selected);

  return (
    <div className="px-3 pb-2">
      <div className="grid grid-cols-3 gap-2">
        {MONTHS_SHORT.map((name, i) => {
          const isSelected = sel.year === viewYear && sel.month === i;
          const isCurrentMonth = today.year === viewYear && today.month === i;

          let cls =
            'py-3 rounded-lg text-sm font-medium cursor-pointer transition-all duration-150 select-none text-center';

          if (isSelected) {
            cls += ' bg-accent text-white';
          } else if (isCurrentMonth) {
            cls += ' text-white ring-1 ring-accent/50 hover:bg-white/[0.06]';
          } else {
            cls += ' text-[#ccc] hover:bg-white/[0.06]';
          }

          return (
            <button
              key={name}
              type="button"
              className={cls}
              onClick={() => {
                // Select the 1st of the chosen month (or keep the selected day if valid)
                const maxDay = getDaysInMonth(viewYear, i);
                const day = Math.min(sel.day, maxDay);
                onSelect(toDateStr(viewYear, i, day));
              }}
            >
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Preset Shortcuts ─────────────────────────────────────────────────────────

const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function getPresetDate(key) {
  const t = new Date();
  const todayDate = toDateStr(t.getFullYear(), t.getMonth(), t.getDate());
  switch (key) {
    case 'today': return todayDate;
    case 'yesterday': {
      t.setDate(t.getDate() - 1);
      return toDateStr(t.getFullYear(), t.getMonth(), t.getDate());
    }
    case 'last7': {
      t.setDate(t.getDate() - 7);
      return toDateStr(t.getFullYear(), t.getMonth(), t.getDate());
    }
    case 'last14': {
      t.setDate(t.getDate() - 14);
      return toDateStr(t.getFullYear(), t.getMonth(), t.getDate());
    }
    case 'last30': {
      t.setDate(t.getDate() - 30);
      return toDateStr(t.getFullYear(), t.getMonth(), t.getDate());
    }
    case 'last90': {
      t.setDate(t.getDate() - 90);
      return toDateStr(t.getFullYear(), t.getMonth(), t.getDate());
    }
    case 'last365': {
      t.setDate(t.getDate() - 365);
      return toDateStr(t.getFullYear(), t.getMonth(), t.getDate());
    }
    case 'lastMonth': {
      const lm = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      return toDateStr(lm.getFullYear(), lm.getMonth(), 1);
    }
    default: return todayDate;
  }
}

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 Days' },
  { key: 'last14', label: 'Last 14 Days' },
  { key: 'last30', label: 'Last 30 Days' },
  { key: 'last90', label: 'Last 90 Days' },
  { key: 'last365', label: 'Last 365 Days' },
  { key: 'lastMonth', label: 'Last Month' },
];

// ── Main DatePicker Component ───────────────────────────────────────────────

export default function DatePicker({ value, onChange, period = 'daily' }) {
  const [open, setOpen] = useState(false);
  const [pendingDate, setPendingDate] = useState(value);
  const [activePreset, setActivePreset] = useState(null);
  const containerRef = useRef(null);

  // View state for navigation (which month/year is shown)
  const initial = parseDate(value);
  const [viewYear, setViewYear] = useState(initial.year);
  const [viewMonth, setViewMonth] = useState(initial.month);

  const today = useMemo(() => getToday(), []);

  // Detect which preset matches on open
  useEffect(() => {
    if (open) {
      const match = PRESETS.find((p) => getPresetDate(p.key) === value);
      setActivePreset(match ? match.key : null);
    }
  }, [open, value]);

  // Sync pending date and view when value prop changes externally
  useEffect(() => {
    if (!open) {
      setPendingDate(value);
      const p = parseDate(value);
      setViewYear(p.year);
      setViewMonth(p.month);
    }
  }, [value, open]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    function handleKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  // Navigation handlers
  const goPrev = useCallback(() => {
    if (period === 'monthly') {
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => {
        if (m === 0) {
          setViewYear((y) => y - 1);
          return 11;
        }
        return m - 1;
      });
    }
  }, [period]);

  const goNext = useCallback(() => {
    if (period === 'monthly') {
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => {
        if (m === 11) {
          setViewYear((y) => y + 1);
          return 0;
        }
        return m + 1;
      });
    }
  }, [period]);

  const handleDaySelect = useCallback((dateStr) => {
    setPendingDate(dateStr);
    setActivePreset(null);
    const p = parseDate(dateStr);
    setViewMonth(p.month);
    setViewYear(p.year);
  }, []);

  const handlePresetSelect = useCallback((key) => {
    const dateStr = getPresetDate(key);
    setPendingDate(dateStr);
    setActivePreset(key);
    const p = parseDate(dateStr);
    setViewMonth(p.month);
    setViewYear(p.year);
  }, []);

  const handleApply = useCallback(() => {
    onChange(pendingDate);
    setOpen(false);
  }, [onChange, pendingDate]);

  const handleCancel = useCallback(() => {
    setPendingDate(value);
    const p = parseDate(value);
    setViewYear(p.year);
    setViewMonth(p.month);
    setOpen(false);
  }, [value]);

  const headerTitle = period === 'monthly'
    ? String(viewYear)
    : `${MONTHS[viewMonth]}  ${viewYear}`;

  const showPresets = period === 'daily';

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white px-3 py-2 text-sm
                   hover:border-white/20 focus:outline-none focus:border-white/20 transition-colors cursor-pointer select-none"
      >
        <Calendar size={14} className="text-[#888]" />
        <span>{formatDisplay(value)}</span>
      </button>

      {/* Popover */}
      {open && (
        <div
          className={`absolute top-full mt-2 right-0 z-50 bg-[#1a1a1a] border border-white/[0.08]
                     rounded-xl shadow-2xl shadow-black/40 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150
                     ${showPresets ? 'flex w-[480px]' : 'w-[280px]'}`}
        >
          {/* Preset shortcuts sidebar */}
          {showPresets && (
            <div className="w-[160px] border-r border-white/[0.06] py-2 shrink-0">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => handlePresetSelect(p.key)}
                  className={`w-full text-left px-4 py-2 text-sm cursor-pointer transition-colors ${
                    activePreset === p.key
                      ? 'text-accent-text font-medium bg-accent-muted'
                      : 'text-white/70 hover:bg-white/[0.04] hover:text-white'
                  }`}
                >
                  <span className="flex items-center justify-between">
                    {p.label}
                    {activePreset === p.key && (
                      <svg className="w-4 h-4 text-accent-text" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Calendar side */}
          <div className={showPresets ? 'flex-1' : 'w-full'}>
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-3">
              <button
                type="button"
                onClick={goPrev}
                className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/[0.08] transition-colors cursor-pointer"
              >
                <ChevronLeft size={16} className="text-[#888]" />
              </button>
              <span className="text-sm font-semibold text-accent select-none">
                {headerTitle}
              </span>
              <button
                type="button"
                onClick={goNext}
                className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/[0.08] transition-colors cursor-pointer"
              >
                <ChevronRight size={16} className="text-[#888]" />
              </button>
            </div>

            {/* Separator */}
            <div className="border-t border-white/[0.06]" />

            {/* Body */}
            <div className="pt-2">
              {period === 'monthly' ? (
                <MonthGrid
                  viewYear={viewYear}
                  selected={pendingDate}
                  today={today}
                  onSelect={handleDaySelect}
                />
              ) : (
                <DayGrid
                  viewYear={viewYear}
                  viewMonth={viewMonth}
                  selected={value}
                  today={today}
                  period={period}
                  pendingDate={pendingDate}
                  onSelect={handleDaySelect}
                />
              )}
            </div>

            {/* Timezone */}
            <div className="px-3 pb-2">
              <p className="text-[11px] text-white/30">Timezone: {TIMEZONE}</p>
            </div>

            {/* Separator */}
            <div className="border-t border-white/[0.06]" />

            {/* Footer buttons */}
            <div className="flex items-center justify-end gap-2 px-3 py-2.5">
              <button
                type="button"
                onClick={handleCancel}
                className="px-4 py-1.5 text-xs font-medium text-white/70 border border-white/[0.1] rounded-md
                           hover:bg-white/[0.06] hover:text-white transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApply}
                className="px-4 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover
                           rounded-md transition-colors cursor-pointer"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
