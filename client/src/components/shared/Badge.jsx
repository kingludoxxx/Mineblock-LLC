const colorMap = {
  blue: 'bg-accent-muted text-accent-text border-accent/30',
  green: 'bg-emerald-600/20 text-emerald-400 border-emerald-600/30',
  red: 'bg-red-600/20 text-red-400 border-red-600/30',
  yellow: 'bg-yellow-600/20 text-yellow-400 border-yellow-600/30',
  purple: 'bg-purple-600/20 text-purple-400 border-purple-600/30',
  slate: 'bg-slate-600/20 text-slate-400 border-slate-600/30',
};

const roleColors = {
  SuperAdmin: 'purple',
  Admin: 'blue',
  Manager: 'green',
  User: 'slate',
};

export default function Badge({ children, color, role, className = '' }) {
  const resolvedColor = color || roleColors[role] || 'slate';
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border
        ${colorMap[resolvedColor]} ${className}`}
    >
      {children || role}
    </span>
  );
}
