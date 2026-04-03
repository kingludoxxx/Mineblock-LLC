import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

const variants = {
  primary:
    'bg-accent text-bg-main font-semibold hover:bg-accent-hover shadow-[0_1px_12px_rgba(201,162,39,0.25)] hover:shadow-[0_1px_20px_rgba(201,162,39,0.35)] focus:ring-accent/40',
  secondary:
    'bg-bg-elevated text-text-primary border border-border-default hover:bg-bg-hover hover:border-border-strong focus:ring-white/10',
  ghost:
    'bg-transparent text-text-muted hover:text-text-primary hover:bg-bg-hover focus:ring-white/10',
  danger:
    'bg-danger/90 text-white hover:bg-danger shadow-[0_1px_8px_rgba(239,68,68,0.2)] focus:ring-danger/40',
};

const sizes = {
  sm: 'px-2.5 py-1 text-xs gap-1.5',
  md: 'px-3.5 py-1.5 text-sm gap-2',
  lg: 'px-5 py-2.5 text-sm gap-2',
};

const Button = forwardRef(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    disabled = false,
    children,
    className = '',
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center font-medium rounded-lg transition-colors
        focus:outline-none focus:ring-2 disabled:opacity-50 disabled:pointer-events-none cursor-pointer
        ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
});

export default Button;
