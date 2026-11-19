import { Link, useLocation } from 'react-router-dom'
import { activeLabel, type NavItem } from './nav'
import type { FollowupSummary } from '../visit/followupBadge'

/**
 * Salesman phone navigation: every real route side by side along the bottom edge (thumb reach).
 * Below 1024px only; from `lg` up the sidebar does this job. Items with no route are skipped.
 */
export default function BottomNav({ items, followups }: { items: NavItem[]; followups: FollowupSummary | null }) {
  const { pathname } = useLocation()
  const active = activeLabel(items, pathname)
  const links = items.filter((i) => i.to)

  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t bg-white pb-[env(safe-area-inset-bottom)] lg:hidden print:hidden">
      <ul className="mx-auto flex max-w-2xl">
        {links.map((it) => {
          const Icon = it.icon
          const isActive = active === it.label
          const count = it.badge === 'followups' && followups ? followups.attention : 0
          return (
            <li key={it.label} className="min-w-0 flex-1">
              <Link to={it.to!} aria-current={isActive ? 'page' : undefined}
                className={`relative flex h-16 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium transition-colors ${isActive ? 'bg-primary-soft text-primary' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}>
                {isActive && <span aria-hidden className="absolute inset-x-4 top-0 h-[3px] rounded-b bg-accent" />}
                <span className="relative">
                  <Icon size={22} strokeWidth={isActive ? 2 : 1.75} aria-hidden />
                  {count > 0 && (
                    <span data-testid="followup-badge" className={`absolute -right-2.5 -top-1.5 min-w-4 rounded-full px-1 text-center text-[10px] font-semibold leading-4 tabular-nums text-white ring-2 ring-white ${followups!.overdue > 0 ? 'bg-red-600' : 'bg-accent-ink'}`}>
                      {count > 99 ? '99+' : count}
                      <span className="sr-only"> follow-ups need attention{followups!.overdue > 0 ? `, ${followups!.overdue} overdue` : ''}</span>
                    </span>
                  )}
                </span>
                <span className="max-w-full truncate">{it.label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
