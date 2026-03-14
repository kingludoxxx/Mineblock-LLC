const variants = {
  default: 'bg-bg-elevated text-text-muted border border-border-default',
  primary: 'bg-accent-muted text-blue-400 border border-blue-500/20',
  success: 'bg-green-500/15 text-green-400 border border-green-500/20',
  warning: 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/20',
  danger: 'bg-red-500/15 text-red-400 border border-red-500/20',
};

export default function Badge({ variant = 'default', children, className = '' }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
