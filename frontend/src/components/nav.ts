import { ChartColumn, ClipboardCheck, ClipboardPlus, CalendarClock, History, LayoutDashboard, Radar, Settings, SlidersHorizontal, Store, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CSSProperties } from 'react'

/**
 * Each section has its own colour so the app is easy to find your way around: the sidebar icon, the active row, page
 * headings, pills, table headers and primary buttons in that section all use it. Text shades are Tailwind 700s, so white
 * text on them and their text on the soft tint both pass WCAG AA.
 */
export type Tone = 'indigo' | 'violet' | 'emerald' | 'sky' | 'amber' | 'rose' | 'teal' | 'fuchsia' | 'slate'
const TONES: Record<Tone, [base: string, hover: string, soft: string, line: string]> = {
  indigo: ['#4338ca', '#3730a3', '#eef2ff', '#c7d2fe'],
  violet: ['#6d28d9', '#5b21b6', '#f5f3ff', '#ddd6fe'],
  emerald: ['#047857', '#065f46', '#ecfdf5', '#a7f3d0'],
  sky: ['#0369a1', '#075985', '#f0f9ff', '#bae6fd'],
  amber: ['#b45309', '#92400e', '#fffbeb', '#fde68a'],
  rose: ['#be123c', '#9f1239', '#fff1f2', '#fecdd3'],
  teal: ['#0f766e', '#115e59', '#f0fdfa', '#99f6e4'],
  fuchsia: ['#a21caf', '#86198f', '#fdf4ff', '#f5d0fe'],
  slate: ['#334155', '#1e293b', '#f1f5f9', '#cbd5e1'],
}

/** CSS variables that recolour `primary` utilities inside an element (see @theme inline in index.css). */
export function toneStyle(tone: Tone | undefined): CSSProperties | undefined {
  if (!tone) return undefined
  const [base, hover, soft, line] = TONES[tone]
  return { '--section': base, '--section-hover': hover, '--section-soft': soft, '--section-line': line } as CSSProperties
}

export interface NavChild { label: string; to: string }
export interface NavItem {
  label: string
  icon: LucideIcon
  tone: Tone
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
  { label: 'Dashboard', icon: LayoutDashboard, tone: 'indigo', to: '/dashboard' },
  // Admin panel only, and just the Overview Dashboard (see ENABLED_SLUGS in pages/reports/reportNav.ts), so a plain link, not a group.
  { label: 'Reports & Analytics', icon: ChartColumn, tone: 'violet', to: '/reports/overview' },
  { label: 'Dealers', icon: Store, tone: 'emerald', to: '/dealers' },
  { label: 'Salesman', icon: Users, tone: 'sky', to: '/salesmen' },
  { label: 'Visits', icon: ClipboardCheck, tone: 'amber', to: '/visits' },
  { label: 'Follow-ups', icon: CalendarClock, tone: 'rose', to: '/followups-management' },
  { label: 'Live Salesman Tracking', icon: Radar, tone: 'teal', to: '/field-map' },
  {
    label: 'Management', icon: SlidersHorizontal, tone: 'fuchsia',
    children: [
      { label: 'Products', to: '/products' },
      { label: 'Import Dealers', to: '/dealers/import' },
      { label: 'Ownership Cleanup', to: '/dealers/ownership-cleanup' },
      { label: 'Access Grants', to: '/dealers/access-grants' },
      { label: 'Transfer Area', to: '/dealers/transfer' },
      { label: 'Dealer Locations', to: '/dealer-locations' },
    ],
  },
  { label: 'Settings', icon: Settings, tone: 'slate', to: '/settings' },
]

export const salesmanNav: NavItem[] = [
  { label: 'Record Visit', icon: ClipboardPlus, tone: 'amber', to: '/record-visit' },
  { label: 'My Dealers', icon: Store, tone: 'emerald', to: '/my-dealers' },
  { label: 'Visit History', icon: History, tone: 'indigo', to: '/visit-history' },
  { label: 'Follow-ups', icon: CalendarClock, tone: 'rose', to: '/followups', badge: 'followups' },
]

/** The colour of the section a path belongs to (undefined outside the menu: the brand navy is used). */
export function toneFor(items: NavItem[], pathname: string): Tone | undefined {
  const label = activeLabel(items, pathname)
  return items.find((i) => i.label === label)?.tone ?? (pathname.startsWith('/settings') ? 'slate' : undefined)
}

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
