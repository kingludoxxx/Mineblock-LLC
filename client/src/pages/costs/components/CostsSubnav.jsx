// CostsSubnav — the two surfaces of the costs lane, one nav entry
// (NEW FILE, costs lane).
//
// The sidebar carries ONE entry for this lane (the integration fence allows
// exactly one), so the Costs ↔ P&L switch lives inside the pages themselves.
import { NavLink } from 'react-router-dom';

const linkCls = ({ isActive }) =>
  `px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
    isActive
      ? 'bg-bg-elevated text-text-primary border border-border-default'
      : 'text-text-muted hover:text-text-primary border border-transparent'
  }`;

export default function CostsSubnav() {
  return (
    <nav className="flex items-center gap-1" aria-label="Costs area">
      <NavLink to="/app/costs" end className={linkCls}>Costs</NavLink>
      <NavLink to="/app/costs/pnl" className={linkCls}>P&amp;L</NavLink>
      <NavLink to="/app/costs/assistant" className={linkCls}>Assistant</NavLink>
    </nav>
  );
}
