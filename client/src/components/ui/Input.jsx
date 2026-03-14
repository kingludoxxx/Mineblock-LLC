import { forwardRef } from 'react';

const Input = forwardRef(function Input(
  { label, error, className = '', ...props },
  ref
) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label className="block text-sm font-medium text-text-muted">
          {label}
        </label>
      )}
      <input
        ref={ref}
        className={`w-full px-3 py-2 text-sm bg-bg-elevated border border-border-default rounded-lg
          text-text-primary placeholder:text-text-faint
          focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
          disabled:opacity-50 transition-colors
          ${error ? 'border-danger' : ''} ${className}`}
        {...props}
      />
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
});

export default Input;
