import { useState } from 'react'
import { Link, Outlet, useLocation, useOutletContext } from 'react-router-dom'
import { ArrowLeft, FileSpreadsheet, FileText, Printer } from 'lucide-react'
import { ApiError, type Me } from '../../auth'
import { useCrumbName } from '../../components/crumbs'
import { Button, flatten, PageHeader, useApi, useToast } from '../../components/ui'
import { downloadReport } from './download'
import FilterBar from './FilterBar'
import { filterSearch } from './filters'
import { apiPathFor, ENABLED_REPORTS, REPORT_NAV, reportSlug } from './reportNav'
import { useReportParams } from './useReportParams'
import type { FilterOptions } from './types'

function ExportButtons() {
  const { pathname } = useLocation()
  const { params } = useReportParams()
  const toast = useToast()
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null)
  const path = apiPathFor(pathname)

  async function get(file: 'xlsx' | 'pdf') {
    if (!path || busy) return
    setBusy(file)
    try {
      await downloadReport(path, params, file)
    } catch (e) {
      const why = e instanceof ApiError ? flatten(e.data).join(' ') : ''
      toast(why || 'Could not create the file. Try again.', 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-wrap gap-2 print:hidden" role="group" aria-label="Export this report">
      <Button variant="secondary" loading={busy === 'xlsx'} onClick={() => get('xlsx')}><FileSpreadsheet size={16} aria-hidden />Excel</Button>
      <Button variant="secondary" loading={busy === 'pdf'} onClick={() => get('pdf')}><FileText size={16} aria-hidden />PDF</Button>
      <Button variant="secondary" onClick={() => window.print()}><Printer size={16} aria-hidden />Print</Button>
    </div>
  )
}

/**
 * Frame shared by every report: title, Excel / PDF / Print, a tab strip across the twelve reports, and the filter bar.
 * Switching tabs keeps the filters (they live in the URL) but drops report-specific options such as search and page.
 */
export default function ReportsLayout() {
  const { me } = useOutletContext<{ me: Me }>()
  const { pathname } = useLocation()
  const { filters, setFilters } = useReportParams()
  const options = useApi<FilterOptions>('/api/reports/options/')
  const crumbName = useCrumbName()

  const slug = reportSlug(pathname)
  const link = REPORT_NAV.find((r) => r.slug === slug)
  const detail = /^\/reports\/[a-z-]+\/\d+\/?$/.test(pathname)
  const keep = filterSearch(filters)
  const title = detail ? (crumbName ?? 'Loading…') : (link?.title ?? 'Reports')

  return (
    <>
      <div className="print:hidden">
        {detail && link && (
          <Link to={`/reports/${link.slug}${keep}`} className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"><ArrowLeft size={14} aria-hidden />{link.title}</Link>
        )}
        <PageHeader title={title} subtitle={detail ? 'Complete history for this period. Pick “All time” for everything.' : link?.hint} action={<ExportButtons />} />
      </div>

      {/* A tab strip over a single report would only repeat the page title, so it shows once there is more than one to switch between. */}
      {ENABLED_REPORTS.length > 1 && (
        <nav aria-label="Reports" className="-mx-4 mb-5 border-b px-4 print:hidden sm:mx-0 sm:px-0">
          <ul className="flex gap-1 overflow-x-auto pb-px">
            {ENABLED_REPORTS.map((r) => {
              const cur = r.slug === slug
              return (
                <li key={r.slug} className="shrink-0">
                  <Link to={`/reports/${r.slug}${keep}`} aria-current={cur ? 'page' : undefined}
                    className={`block whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${cur ? 'border-accent text-primary' : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'}`}>{r.label}</Link>
                </li>
              )
            })}
          </ul>
        </nav>
      )}

      <FilterBar filters={filters} options={options.data} setFilters={setFilters} />
      <Outlet context={{ me, options: options.data }} />
    </>
  )
}
