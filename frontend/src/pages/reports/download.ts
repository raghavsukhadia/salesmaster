import { apiFile } from '../../auth'

/**
 * Downloads the Excel or PDF version of the report on screen. The export gets the *same* query string as the screen
 * (period, salesman, dealer, product, category, order, search and report options), so the file always matches the filters.
 * Only the screen's page number is dropped: the file carries every row.
 */
export async function downloadReport(apiPath: string, search: URLSearchParams, file: 'xlsx' | 'pdf') {
  const q = new URLSearchParams(search)
  q.delete('page')
  q.set('file', file)
  const { blob, filename } = await apiFile(`${apiPath}export/?${q}`)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
