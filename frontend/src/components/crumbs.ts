import { useEffect, useSyncExternalStore } from 'react'

import { REPORT_NAV } from '../pages/reports/reportNav.ts'

export interface Crumb { label: string; to?: string }

const reportCrumbs: Record<string, Crumb[]> = Object.fromEntries(
  REPORT_NAV.map((r) => [`/reports/${r.slug}`, [{ label: 'Reports & Analytics', to: '/reports/overview' }, { label: r.title }]]),
)

const STATIC: Record<string, Crumb[]> = {
  ...reportCrumbs,
  '/dashboard': [{ label: 'Dashboard' }],
  '/dealers': [{ label: 'Dealers' }],
  '/salesmen': [{ label: 'Salesman' }],
  '/visits': [{ label: 'Visits' }],
  '/followups-management': [{ label: 'Follow-ups' }],
  '/products': [{ label: 'Management' }, { label: 'Products' }],
  '/dealers/ownership-cleanup': [{ label: 'Management' }, { label: 'Ownership Cleanup' }],
  '/dealers/access-grants': [{ label: 'Management' }, { label: 'Access Grants' }],
  '/dealers/transfer': [{ label: 'Management' }, { label: 'Transfer Area' }],
  '/my-dealers': [{ label: 'My Dealers' }],
  '/dealer-locations': [{ label: 'Management' }, { label: 'Dealer Locations' }],
  '/field-map': [{ label: 'Live Salesman Tracking' }],
  '/settings': [{ label: 'Settings' }],
  '/record-visit': [{ label: 'Record Visit' }],
  '/visit-history': [{ label: 'Visit History' }],
  '/followups': [{ label: 'Follow-ups' }],
}

const DETAIL: [RegExp, Crumb, (id: string) => string][] = [
  [/^\/my-dealers\/(\d+)$/, { label: 'My Dealers', to: '/my-dealers' }, () => 'Dealer'],
  [/^\/dealers\/(\d+)$/, { label: 'Dealers', to: '/dealers' }, () => 'Dealer'],
  [/^\/salesmen\/(\d+)$/, { label: 'Salesman', to: '/salesmen' }, () => 'Salesman'],
  [/^\/visits\/(\d+)$/, { label: 'Visits', to: '/visits' }, (id) => `Visit #${id}`],
  [/^\/followups-management\/(\d+)$/, { label: 'Follow-ups', to: '/followups-management' }, (id) => `Follow-up #${id}`],
  [/^\/visit-history\/(\d+)$/, { label: 'Visit History', to: '/visit-history' }, (id) => `Visit #${id}`],
  [/^\/reports\/salesman-wise\/(\d+)$/, { label: 'Salesman-Wise Reports', to: '/reports/salesman-wise' }, () => 'Salesman'],
  [/^\/reports\/dealer-wise\/(\d+)$/, { label: 'Dealer-Wise Reports', to: '/reports/dealer-wise' }, () => 'Dealer'],
]

export function crumbsFor(pathname: string, name?: string): Crumb[] {
  const p = pathname.replace(/\/+$/, '') || '/'
  if (STATIC[p]) return STATIC[p]
  for (const [re, parent, fallback] of DETAIL) {
    const m = p.match(re)
    if (m) return [parent, { label: name ?? fallback(m[1]) }]
  }
  return []
}

/* A detail page can name its own breadcrumb ("Dealers › Sharma Motors") once its data has loaded. */
let current: string | undefined
const subs = new Set<() => void>()
function setCrumbName(n?: string) {
  if (n === current) return
  current = n
  subs.forEach((f) => f())
}
export const useCrumbName = () => useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, () => current)
export function useCrumb(name?: string) {
  useEffect(() => { setCrumbName(name); return () => setCrumbName(undefined) }, [name])
}
