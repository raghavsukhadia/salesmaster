/** The twelve report screens. Order is the order of the sidebar group and of the tab strip above every report. */
export interface ReportLink { slug: string; label: string; title: string; hint: string }

export const REPORT_NAV: ReportLink[] = [
  { slug: 'overview', label: 'Overview Dashboard', title: 'Overview Dashboard', hint: '' },
  { slug: 'date-wise', label: 'Date-Wise Sales', title: 'Date-Wise Sales', hint: 'What was sold on each day.' },
  { slug: 'salesman-wise', label: 'Salesman-Wise Reports', title: 'Salesman-Wise Reports', hint: 'Performance and leaderboards for every salesman.' },
  { slug: 'dealer-wise', label: 'Dealer-Wise Reports', title: 'Dealer-Wise Reports', hint: 'Top dealers, new versus repeat, and dealers gone quiet.' },
  { slug: 'product-wise', label: 'Product-Wise Reports', title: 'Product-Wise Reports', hint: 'What sells, how often, and to how many dealers.' },
  { slug: 'salesman-product', label: 'Salesman vs Product', title: 'Salesman vs Product', hint: 'Which salesman sells which product.' },
  { slug: 'order-wise', label: 'Order-Wise Reports', title: 'Order-Wise Reports', hint: 'Every order with its items. Search by dealer, salesman, product or order number.' },
  { slug: 'periods', label: 'Monthly / Yearly', title: 'Monthly / Yearly Reports', hint: 'Month-by-month and year-by-year totals with growth.' },
  { slug: 'visit-performance', label: 'Visit Performance', title: 'Visit Performance', hint: 'How many visits turned into orders.' },
  { slug: 'followup-reports', label: 'Follow-up Reports', title: 'Follow-up Reports', hint: 'Pending, completed and overdue follow-ups, and which led to orders.' },
  { slug: 'sales-targets', label: 'Sales Targets', title: 'Sales Targets', hint: 'Monthly order and visit targets against what was achieved.' },
  { slug: 'compare', label: 'Compare', title: 'Advanced Comparison', hint: 'Two salesman, products, dealers, months or date ranges side by side.' },
]

/**
 * Which of those screens the app offers. Only the Overview Dashboard for now. The other eleven (and their API) stay in the code;
 * to bring one back, add its slug here. The sidebar, the tab strip and the routes all read this list, so nothing else changes.
 */
export const ENABLED_SLUGS: readonly string[] = ['overview']
export const ENABLED_REPORTS: ReportLink[] = REPORT_NAV.filter((r) => ENABLED_SLUGS.includes(r.slug))
export const isEnabledReport = (slug: string): boolean => ENABLED_SLUGS.includes(slug)

/** The slug of a /reports/... path, or null. */
export function reportSlug(pathname: string): string | null {
  const m = pathname.match(/^\/reports\/([a-z-]+)/)
  return m && REPORT_NAV.some((r) => r.slug === m[1]) ? m[1] : null
}

/** The API path behind a /reports/... screen: `/reports/salesman-wise/5` -> `/api/reports/salesman-wise/5/`. */
export function apiPathFor(pathname: string): string | null {
  const m = pathname.match(/^\/reports\/([a-z-]+)(?:\/(\d+))?\/?$/)
  if (!m || !REPORT_NAV.some((r) => r.slug === m[1])) return null
  return `/api/reports/${m[1]}/${m[2] ? `${m[2]}/` : ''}`
}
