// Order line arithmetic. Money is handled in whole paise (integers) so 3 x 1250.50 never becomes 3751.4999999.

/** Must match ORDER_UNITS in backend/apps/visits/serializers.py. */
export const UNITS = ['pcs', 'roll', 'box'] as const
export type Unit = (typeof UNITS)[number]

export interface OrderLine {
  key: string
  /** Set for a catalogue product, absent for a custom item typed in by hand. */
  product_id?: number
  product_name: string
  quantity: number
  unit: Unit
  /** Exactly what was typed ("1,250.50"), so the field never rewrites itself under the cursor. */
  unit_price: string
}

/** The server stores up to 12 digits with 2 decimals. */
const MAX_PAISE = 999_999_999_999

/** "" is a valid, unpriced line (0). Returns null for anything that is not a non-negative amount with at most 2 decimals. */
export function parsePaise(typed: string): number | null {
  const t = typed.replace(/[,\s₹]/g, '')
  if (t === '') return 0
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  const [whole, frac = ''] = t.split('.')
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  return Number.isSafeInteger(paise) && paise <= MAX_PAISE ? paise : null
}

export const parsePrice = (typed: string): number | null => {
  const p = parsePaise(typed)
  return p === null ? null : p / 100
}

/** What to tell the user about a typed price, or '' when it is fine. */
export const priceError = (typed: string): string => (parsePaise(typed) === null ? 'Enter an amount like 1250 or 1250.50' : '')

/** Line total in paise. A line whose price is invalid counts as 0 so one typo does not blank the whole total. */
export const lineTotalPaise = (l: Pick<OrderLine, 'quantity' | 'unit_price'>) => l.quantity * (parsePaise(l.unit_price) ?? 0)

export const orderTotalPaise = (lines: Pick<OrderLine, 'quantity' | 'unit_price'>[]) => lines.reduce((sum, l) => sum + lineTotalPaise(l), 0)

/** Rupees with Indian digit grouping: 125000.5 -> "₹1,25,000.50"; whole amounts drop the decimals. */
export function fmtInr(rupees: number): string {
  const whole = Number.isInteger(rupees)
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(rupees)
}

export const fmtPaise = (paise: number) => fmtInr(paise / 100)

/** The request body for the server: one entry per line, price as a plain decimal string. */
export function toOrderItems(lines: OrderLine[]) {
  return lines.map((l) => ({
    ...(l.product_id ? { product_id: l.product_id } : { product_name: l.product_name }),
    quantity: l.quantity,
    unit: l.unit,
    unit_price: ((parsePaise(l.unit_price) ?? 0) / 100).toFixed(2),
  }))
}
