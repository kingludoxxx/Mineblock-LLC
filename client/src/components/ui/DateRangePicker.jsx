import { useState, useRef, useEffect } from 'react';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';

const PRESETS = [
  { label: 'Today', days: 0 },
  { label: 'Yesterday', days: 1, offset: true },
  { label: 'Last 7 Days', days: 7 },
  { label: 'Last 14 Days', days: 14 },
  { label: 'Last 30 Days', days: 30 },
  { label: 'Last 90 Days', days: 90 },
  { label: 'Last 365 Days', days: 365 },
  { label: 'Last Month', custom: 'lastMonth' },
];

function toDateStr(d) {
  // Use local date components — toISOString() converts to UTC which shifts the
  // date by one day in positive-UTC-offset timezones (e.g. Europe/Berlin).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isInRange(day, start, end) {
  return day >= start && day <= end;
}

function getPresetDates(preset) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (preset.custom === 'lastMonth') {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return { startDate: toDateStr(start), endDate: toDateStr(end) };
  }
  if (preset.offset) {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return { startDate: toDateStr(d), endDate: toDateStr(d) };
  }
  if (preset.days === 0) {
    return { startDate: toDateStr(today), endDate: toDateStr(today) };
  }
  const start = new Date(today);
  start.setDate(start.getDate() - preset.days);
  return { startDate: toDateStr(start), endDate: toDateStr(today) };
}

function getMatchingPreset(startDate, endDate) {
  for (const preset of PRESETS) {
    const { startDate: ps, endDate: pe } = getPresetDates(preset);
    if (ps === startDate && pe === endDate) return preset.label;
  }
  return null;
}

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year, month) {
  return new Date(year, month, 1).getDay();
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function CalendarMonth({ year, month, rangeStart, rangeEnd, hoverDate, onDayClick, onDayHover, selectingEnd }) {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  const cells = [];

  for (let i = 0; i < firstDay; i++) {
    cells.push(<div key={`empty-${i}`} />);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const dateStr = toDateStr(date);

    const isStart = rangeStart && isSameDay(date, rangeStart);
    const isEnd = rangeEnd && isSameDay(date, rangeEnd);
    const effectiveEnd = selectingEnd && hoverDate ? hoverDate : rangeEnd;
    const inRange = rangeStart && effectiveEnd && isInRange(date, rangeStart, effectiveEnd);
    const isHovered = hoverDate && isSameDay(date, hoverDate);
    const isToday = isSameDay(date, new Date());

    let cellClass = 'w-8 h-8 flex items-center justify-center text-xs rounded-md cursor-pointer transition-all duration-150 ';

    if (isStart || isEnd) {
      cellClass += 'bg-accent text-white font-semibold ';
    } else if (inRange) {
      cellClass += 'bg-accent/20 text-accent-text ';
    } else if (isToday) {
      cellClass += 'text-accent-text font-semibold hover:bg-white/10 ';
    } else {
      cellClass += 'text-gray-300 hover:bg-white/10 ';
    }

    cells.push(
      <div
        key={d}
        className={cellClass}
        onClick={() => onDayClick(date)}
        onMouseEnter={() => onDayHover(date)}
      >
        {d}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-7 gap-0.5">
      {DAYS.map((day) => (
        <div key={day} className="w-8 h-7 flex items-center justify-center text-[10px] text-gray-500 font-medium uppercase">
          {day}
        </div>
      ))}
      {cells}
    </div>
  );
}

export default function DateRangePicker({ startDate, endDate, onChange }) {
  const [open, setOpen] = useState(false);
  const [tempStart, setTempStart] = useState(startDate);
  const [tempEnd, setTempEnd] = useState(endDate);
  const [selectingEnd, setSelectingEnd] = useState(false);
  const [hoverDate, setHoverDate] = useState(null);
  const [activePreset, setActivePreset] = useState(() => getMatchingPreset(startDate, endDate));
  const [calMonth, setCalMonth] = useState(() => {
    const d = parseDate(endDate);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    setActivePreset(getMatchingPreset(startDate, endDate));
  }, [startDate, endDate]);

  const handlePresetClick = (preset) => {
    const { startDate: s, endDate: e } = getPresetDates(preset);
    setTempStart(s);
    setTempEnd(e);
    setActivePreset(preset.label);
    setSelectingEnd(false);
    const d = parseDate(e);
    setCalMonth({ year: d.getFullYear(), month: d.getMonth() });
  };

  const handleDayClick = (date) => {
    const dateStr = toDateStr(date);
    if (!selectingEnd) {
      setTempStart(dateStr);
      setTempEnd(dateStr);
      setSelectingEnd(true);
      setActivePreset(null);
    } else {
      if (date < parseDate(tempStart)) {
        setTempStart(dateStr);
        setTempEnd(tempStart);
      } else {
        setTempEnd(dateStr);
      }
      setSelectingEnd(false);
      setActivePreset(null);
    }
  };

  const handleApply = () => {
    onChange({ startDate: tempStart, endDate: tempEnd });
    setOpen(false);
  };

  const handleCancel = () => {
    setTempStart(startDate);
    setTempEnd(endDate);
    setSelectingEnd(false);
    setActivePreset(getMatchingPreset(startDate, endDate));
    setOpen(false);
  };

  const prevMonth = () => {
    setCalMonth((prev) => {
      const m = prev.month - 1;
      return m < 0 ? { year: prev.year - 1, month: 11 } : { year: prev.year, month: m };
    });
  };

  const nextMonth = () => {
    setCalMonth((prev) => {
      const m = prev.month + 1;
      return m > 11 ? { year: prev.year + 1, month: 0 } : { year: prev.year, month: m };
    });
  };

  const formatShortDate = (d) => {
    const [y, m, day] = d.split('-');
    return `${MONTHS[parseInt(m, 10) - 1].slice(0, 3)} ${parseInt(day, 10)}`;
  };
  const triggerLabel = getMatchingPreset(startDate, endDate) || `${formatShortDate(startDate)} – ${formatShortDate(endDate)}`;

  const rangeStart = parseDate(tempStart);
  const rangeEnd = parseDate(tempEnd);

  return (
    <div className="relative" ref={ref}>
      {/* Trigger button */}
      <button
        onClick={() => {
          if (!open) {
            setTempStart(startDate);
            setTempEnd(endDate);
            setSelectingEnd(false);
            setActivePreset(getMatchingPreset(startDate, endDate));
            const d = parseDate(endDate);
            setCalMonth({ year: d.getFullYear(), month: d.getMonth() });
          }
          setOpen(!open);
        }}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#111] border border-white/[0.08] hover:border-accent/40 text-white text-sm transition-all cursor-pointer whitespace-nowrap"
      >
        <Calendar className="w-4 h-4 text-accent-text" />
        <span>{triggerLabel}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 flex bg-[#0d0d0d] border border-white/[0.08] rounded-xl shadow-2xl overflow-hidden">
          {/* Presets */}
          <div className="w-44 border-r border-white/[0.06] py-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => handlePresetClick(preset)}
                className={`w-full text-left px-4 py-2 text-sm transition-colors cursor-pointer
                  ${activePreset === preset.label
                    ? 'bg-accent/15 text-accent-text font-medium'
                    : 'text-gray-400 hover:bg-white/[0.04] hover:text-white'
                  }`}
              >
                {preset.label}
                {activePreset === preset.label && (
                  <span className="float-right text-accent-text">✓</span>
                )}
              </button>
            ))}
          </div>

          {/* Calendar */}
          <div className="p-4 w-72">
            {/* Month nav */}
            <div className="flex items-center justify-between mb-3">
              <button onClick={prevMonth} className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors cursor-pointer">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-sm font-medium text-white">
                {MONTHS[calMonth.month]} {calMonth.year}
              </span>
              <button onClick={nextMonth} className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors cursor-pointer">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <CalendarMonth
              year={calMonth.year}
              month={calMonth.month}
              rangeStart={rangeStart}
              rangeEnd={rangeEnd}
              hoverDate={hoverDate}
              selectingEnd={selectingEnd}
              onDayClick={handleDayClick}
              onDayHover={(d) => selectingEnd && setHoverDate(d)}
            />

            {/* Date display */}
            <div className="flex items-center gap-2 mt-4 text-xs text-gray-400">
              <span className="px-2 py-1 rounded bg-white/[0.04] border border-white/[0.06] text-white">{tempStart}</span>
              <span>→</span>
              <span className="px-2 py-1 rounded bg-white/[0.04] border border-white/[0.06] text-white">{tempEnd}</span>
            </div>

            {/* Buttons */}
            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                onClick={handleCancel}
                className="px-4 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleApply}
                className="px-4 py-1.5 rounded-lg text-sm bg-accent hover:bg-accent-hover text-white font-medium transition-colors cursor-pointer"
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
