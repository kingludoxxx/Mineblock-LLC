import { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';

const Select = forwardRef(function Select(
  { label, error, options = [], placeholder, className = '', ...props },
  ref
) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label className="block text-sm font-medium text-text-muted">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          ref={ref}
          className={`w-full appearance-none px-3 py-2 pr-8 text-sm bg-bg-elevated border border-border-default rounded-lg
            text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
            disabled:opacity-50 transition-colors cursor-pointer
            ${error ? 'border-danger' : ''} ${className}`}
          {...props}
        >
          {placeholder && (
            <option value="" className="text-text-faint">
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
});

export default Select;
