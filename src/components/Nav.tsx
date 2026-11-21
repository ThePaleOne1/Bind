import { NavLink, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ScanLine, LayoutGrid, BookOpen, Monitor, Settings } from 'lucide-react'

const tabs = [
  { to: '/collection', label: 'Cards', Icon: LayoutGrid },
  { to: '/binder', label: 'Binder', Icon: BookOpen },
  { to: '/scan', label: 'Scan', Icon: ScanLine, scan: true },
  { to: '/companion', label: 'Desk', Icon: Monitor },
  { to: '/settings', label: 'Setup', Icon: Settings },
]

export function Nav() {
  const { pathname } = useLocation()
  return (
    <nav className="tabbar">
      <div className="brand">DEX</div>
      {tabs.map(({ to, label, Icon, scan }) => {
        const active = pathname.startsWith(to)
        return (
          <NavLink key={to} to={to} className={`tab ${scan ? 'tab--scan' : ''} ${active ? 'tab--active' : ''}`} aria-label={label}>
            {active && !scan && <motion.span layoutId="tab-pill" className="tab__pill" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
            {scan ? (
              <span className="tab__lens"><Icon size={26} strokeWidth={2.5} /></span>
            ) : (
              <Icon size={22} strokeWidth={active ? 2.6 : 2} />
            )}
            <span style={scan ? { color: active ? 'var(--accent)' : 'var(--muted)' } : undefined}>{label}</span>
          </NavLink>
        )
      })}
    </nav>
  )
}
