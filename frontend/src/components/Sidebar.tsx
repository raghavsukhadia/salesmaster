import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ChevronDown, Hourglass, X } from 'lucide-react'
import { activeLabel, RANGE_ROUTES, type NavItem } from './nav'
import Tooltip from './Tooltip'
import { useToast } from './ui'
import { useFollowupSummary } from '../visit/followupBadge'

const ROW = 'group relative flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors'

interface Props {
  items: NavItem[]
  /** Desktop icon-only mode. On small screens the drawer is always full width, whatever this says. */
  collapsed: boolean
  /** Mobile drawer state. */
  open: boolean
  onNavigate: () => void
  onExpand: () => void
}

export default function Sidebar({ items, collapsed, open, onNavigate, onExpand }: Props) {
  const { pathname, search } = useLocation()
  const toast = useToast()
  const active = activeLabel(items, pathname)
  const range = new URLSearchParams(search).get('range')
  const [groups, setGroups] = useState<Record<string, boolean>>({})
  const hide = collapsed ? 'lg:hidden' : ''
  const center = collapsed ? 'lg:justify-center lg:px-0' : ''
  const home = items.find((i) => i.to)?.to ?? '/'
  // The count only exists for the salesman menu; for everyone else the hook does nothing and makes no request.
  const followups = useFollowupSummary(items.some((i) => i.badge === 'followups'), pathname)

  const target = (to: string) => (RANGE_ROUTES.includes(to) && range ? { pathname: to, search: `?range=${range}` } : to)

  return (
    <aside aria-label="Primary" id="primary-nav"
      className={`fixed inset-y-0 left-0 z-40 flex w-72 print:hidden flex-col border-r bg-white transition-[width,translate] duration-200 lg:translate-none ${open ? 'translate-x-0' : '-translate-x-full'} ${collapsed ? 'lg:w-16' : 'lg:w-64'}`}>
      <div className={`flex h-20 shrink-0 items-center justify-between px-5 ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}>
        <button type="button" onClick={onNavigate} aria-label="Close navigation" className="order-2 -mr-2 grid size-10 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 lg:hidden"><X size={20} aria-hidden /></button>
        <Link to={home} onClick={onNavigate} className="rounded-lg">
          <img src="/logo-trimmed.png" alt="Sales Master" width={638} height={439} className={`h-14 w-auto ${collapsed ? 'lg:hidden' : ''}`} />
          <img src="/logo-mark.png" alt="Sales Master" width={464} height={332} className={`hidden h-8 w-auto ${collapsed ? 'lg:block' : ''}`} />
        </Link>
      </div>

      <nav className="flex flex-1 flex-col overflow-y-auto px-3 pb-4 pt-2">
        {/* Mobile drawer: items sit at the bottom edge (thumb reach). mt-auto, not justify-end, so a long list scrolls instead of clipping. */}
        <ul className="mt-auto space-y-1 lg:mt-0">
          {items.map((it) => {
            const Icon = it.icon
            const icon = <Icon size={18} strokeWidth={1.75} className="shrink-0" aria-hidden />

            if (it.soon) {
              const why = `${it.label}: ${it.soon}`
              return (
                <li key={it.label}>
                  <Tooltip text={why}>
                    <button type="button" aria-disabled="true" onClick={() => toast(why, 'info')}
                      className={`${ROW} cursor-not-allowed text-slate-400 hover:bg-slate-50 ${center}`}>
                      {icon}
                      <span className={`truncate ${hide}`}>{it.label}<span className="sr-only"> (not available yet)</span></span>
                      <span aria-hidden className={`ml-auto flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 ${hide}`}><Hourglass size={10} />Soon</span>
                    </button>
                  </Tooltip>
                </li>
              )
            }

            if (it.children) {
              const isActive = active === it.label
              const isOpen = groups[it.label] ?? isActive
              return (
                <li key={it.label}>
                  <Tooltip text={it.label} disabled={!collapsed}>
                    <button type="button" aria-expanded={isOpen} aria-controls={`grp-${it.label}`}
                      onClick={() => {
                        if (collapsed && window.matchMedia('(min-width: 1024px)').matches) { onExpand(); setGroups({ ...groups, [it.label]: true }) }
                        else setGroups({ ...groups, [it.label]: !isOpen })
                      }}
                      className={`${ROW} ${isActive ? 'bg-primary-soft text-primary' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'} ${center}`}>
                      {icon}
                      <span className={`truncate ${hide}`}>{it.label}</span>
                      <ChevronDown size={16} aria-hidden className={`ml-auto shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''} ${hide}`} />
                    </button>
                  </Tooltip>
                  {isOpen && (
                    <ul id={`grp-${it.label}`} className={`ml-[21px] mt-1 space-y-1 border-l pl-3 ${hide}`}>
                      {it.children.map((c) => {
                        const cur = pathname === c.to || pathname.startsWith(`${c.to}/`)
                        return (
                          <li key={c.to}>
                            <Link to={c.to} onClick={onNavigate} aria-current={cur ? 'page' : undefined}
                              className={`flex h-9 items-center rounded-lg px-3 text-sm transition-colors ${cur ? 'bg-primary-soft font-medium text-primary' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>{c.label}</Link>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            }

            const isActive = active === it.label
            return (
              <li key={it.label}>
                <Tooltip text={it.label} disabled={!collapsed}>
                  <Link to={target(it.to!)} onClick={onNavigate} aria-current={isActive ? 'page' : undefined}
                    className={`${ROW} ${isActive ? 'bg-primary-soft text-primary' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'} ${center}`}>
                    {isActive && <span aria-hidden className="absolute -left-3 bottom-2 top-2 w-[3px] rounded-r bg-accent" />}
                    {icon}
                    <span className={`truncate ${hide}`}>{it.label}</span>
                    {it.badge === 'followups' && followups && followups.attention > 0 && (
                      <>
                        {/* Full pill in the expanded menu, a dot on the icon when the menu is collapsed to icons. */}
                        <span data-testid="followup-badge" className={`ml-auto min-w-5 shrink-0 rounded-full px-1.5 text-center text-xs font-semibold leading-5 tabular-nums text-white ${followups.overdue > 0 ? 'bg-red-600' : 'bg-accent-ink'} ${hide}`}>
                          {followups.attention > 99 ? '99+' : followups.attention}
                          <span className="sr-only"> follow-ups need attention{followups.overdue > 0 ? `, ${followups.overdue} overdue` : ''}</span>
                        </span>
                        {collapsed && <span aria-hidden className={`absolute right-2 top-2 hidden size-2.5 rounded-full ring-2 ring-white lg:block ${followups.overdue > 0 ? 'bg-red-600' : 'bg-accent'}`} />}
                      </>
                    )}
                  </Link>
                </Tooltip>
              </li>
            )
          })}
        </ul>
      </nav>
    </aside>
  )
}
