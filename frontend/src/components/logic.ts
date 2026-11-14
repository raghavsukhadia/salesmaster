// Pure helpers (no React, no DOM) so they can be unit-tested with `npm test`. ui.tsx re-exports them.

export const qs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')

export const fmtDate = (s?: string | null, short = false) =>
  s ? new Date(s.length === 10 ? s + 'T00:00:00' : s).toLocaleDateString('en-GB', { day: short ? 'numeric' : '2-digit', month: 'short', year: 'numeric' }) : '—'
export const fmtTime = (s: string) =>
  new Date(s).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()

/** "just now", "12 min ago", "3 h ago", "Today, 8:00 am", "Yesterday, 4:10 pm", then a plain date. Never invents a time. */
export function fmtRelative(s?: string | null, now = Date.now()) {
  if (!s) return '—'
  const t = new Date(s).getTime()
  const mins = Math.round((now - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 6) return `${hrs} h ago`
  const sameDay = new Date(t).toDateString() === new Date(now).toDateString()
  if (sameDay) return `Today, ${fmtTime(s)}`
  const yesterday = new Date(now - 86400000).toDateString() === new Date(t).toDateString()
  return yesterday ? `Yesterday, ${fmtTime(s)}` : `${fmtDate(s, true)}, ${fmtTime(s)}`
}

// Flattens DRF error bodies ({field: [msgs]} or nested) into readable lines.
export function flatten(data: unknown, prefix = ''): string[] {
  if (typeof data === 'string') return [prefix ? `${prefix}: ${data}` : data]
  if (Array.isArray(data)) return data.flatMap((d) => flatten(d, prefix))
  if (data && typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>).flatMap(([k, v]) =>
      flatten(v, k === 'non_field_errors' || k === 'detail' ? prefix : k.replace(/_/g, ' ')),
    )
  }
  return []
}

/** Field-level messages from a DRF 400 body: {field: ['msg']} -> {field: 'msg'}. Form-level errors are excluded. */
export function fieldErrors(data: unknown): Record<string, string> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>)
      .filter(([k]) => k !== 'non_field_errors' && k !== 'detail')
      .map(([k, v]) => [k, flatten(v).join(' ')]),
  )
}

export const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0)

export type SeverityLabel = 'High' | 'Medium' | 'Low' | 'Clear'
/** A dealer count is judged by its share of all dealers: High at 50%+, Medium at 20%+, otherwise Low; zero is Clear. */
export function dealerSeverity(n: number, total: number): SeverityLabel {
  if (n <= 0) return 'Clear'
  const share = n / Math.max(1, total)
  return share >= 0.5 ? 'High' : share >= 0.2 ? 'Medium' : 'Low'
}
