import { ChartColumn, ClipboardCheck, ClipboardPlus, CalendarClock, History, LayoutDashboard, Radar, Settings, SlidersHorizontal, Store, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavChild { label: string; to: string }
export interface NavItem {
  label: string
  icon: LucideIcon
  /** A real route. */
  to?: string
  /** Set instead of `to` when the module has no working backend yet. Shown as unavailable, with this reason. */
  soon?: string
  /** Show a live count pill on this item. Only the salesman follow-ups count exists so far. */
  badge?: 'followups'
  children?: NavChild[]
}

/** Routes whose data depends on the top-bar date range; the sidebar keeps `?range=` when jumping between them. */
export const RANGE_ROUTES = ['/dashboard', '/visits']

export const managementNav: NavItem[] = [
  { label: 'Dashboard', icon: LayoutDashboard, to: '/dashboard' },
  // Admin panel only, and just the Overview Dashboard (see ENABLED_SLUGS in pages/reports/reportNav.ts), so a plain link, not a group.
  { label: 'Reports & Analytics', icon: ChartColumn, to: '/reports/overview' },
  { label: 'Dealers', icon: Store, to: '/dealers' },
  { label: 'Salesman', icon: Users, to: '/salesmen' },
  { label: 'Visits', icon: ClipboardCheck, to: '/visits' },
  { label: 'Follow-ups', icon: CalendarClock, to: '/followups-management' },
  { label: 'Live Salesman Tracking', icon: Radar, to: '/field-map' },
  {
    label: 'Management', icon: SlidersHorizontal,
    children: [
      { label: 'Products', to: '/products' },
      { label: 'Ownership Cleanup', to: '/dealers/ownership-cleanup' },
      { label: 'Access Grants', to: '/dealers/access-grants' },
      { label: 'Transfer Area', to: '/dealers/transfer' },
      { label: 'Dealer Locations', to: '/dealer-locations' },
    ],
  },
  { label: 'Settings', icon: Settings, to: '/settings' },
]

export const salesmanNav: NavItem[] = [
  { label: 'Record Visit', icon: ClipboardPlus, to: '/record-visit' },
  { label: 'My Dealers', icon: Store, to: '/my-dealers' },
  { label: 'Visit History', icon: History, to: '/visit-history' },
  { label: 'Follow-ups', icon: CalendarClock, to: '/followups', badge: 'followups' },
]

/** Which top-level item is "current" for a path. Management sub-pages light up Management, not Dealers. */
export function activeLabel(items: NavItem[], pathname: string): string | null {
  // Prefix match, so a drill-down such as /reports/salesman-wise/5 still lights up its group.
  for (const it of items) if (it.children?.some((c) => pathname === c.to || pathname.startsWith(`${c.to}/`))) return it.label
  let best: { label: string; len: number } | null = null
  for (const it of items) {
    if (!it.to) continue
    if ((pathname === it.to || pathname.startsWith(it.to + '/')) && (!best || it.to.length > best.len)) best = { label: it.label, len: it.to.length }
  }
  return best?.label ?? null
}
