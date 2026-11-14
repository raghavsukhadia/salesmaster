import assert from 'node:assert/strict'
import { test } from 'node:test'
import { columnPath, compact, labelIndices, nearestIndex, niceAxis } from './chartMath.ts'
import { activeCount, COMPARE_KINDS, customRangeError, DEFAULT_PRESET, EMPTY_FILTERS, filterParams, filterSearch, parseFilters, validCompareValue } from './filters.ts'
import { compareCells, fillPath, fmtCard, fmtCell, fmtChange, fmtDay, fmtMonth, fmtStamp, fmtX } from './format.ts'
import { apiPathFor, ENABLED_REPORTS, ENABLED_SLUGS, isEnabledReport, REPORT_NAV, reportSlug } from './reportNav.ts'
import type { Card } from './types.ts'

const P = (s: string) => new URLSearchParams(s)

test('filters: defaults, parsing and a clean URL', () => {
  assert.deepEqual(parseFilters(P('')), EMPTY_FILTERS)
  assert.deepEqual(filterParams(EMPTY_FILTERS), {})
  assert.equal(filterSearch(EMPTY_FILTERS), '')
  const f = parseFilters(P('preset=custom&from=2026-10-01&to=2026-10-31&salesman=3&dealer=9&product=p4&category=PPF&order=12'))
  assert.equal(f.preset, 'custom')
  assert.deepEqual(filterParams(f), { preset: 'custom', from: '2026-10-01', to: '2026-10-31', salesman: '3', dealer: '9', product: 'p4', category: 'PPF', order: '12' })
  assert.equal(activeCount(f), 6)  // period + salesman + dealer + product + category + order
  assert.equal(activeCount({ ...f, unit: 'roll' }), 7)
  assert.equal(filterParams({ ...EMPTY_FILTERS, unit: 'sq ft' }).unit, 'sq ft')
  assert.equal(parseFilters(P('unit=sq%20ft')).unit, 'sq ft')
  assert.equal(parseFilters(P('unit=%3Cb%3E')).unit, '')
})

test('filters: junk in the URL falls back instead of breaking a report', () => {
  const f = parseFilters(P('preset=whenever&from=yesterday&salesman=abc&dealer=-1&order=1e3'))
  assert.equal(f.preset, DEFAULT_PRESET)
  assert.equal(f.from, '')
  assert.equal(f.salesman, '')
  assert.equal(f.dealer, '')
  assert.equal(f.order, '')
})

test('filters: a custom range only sends its dates, and each preset sends only itself', () => {
  assert.deepEqual(filterParams({ ...EMPTY_FILTERS, preset: 'last7', from: '2026-10-01', to: '2026-10-02' }), { preset: 'last7' })
  assert.deepEqual(filterParams({ ...EMPTY_FILTERS, preset: 'all' }), { preset: 'all' })
  assert.equal(filterSearch({ ...EMPTY_FILTERS, preset: 'all', salesman: '2' }), '?preset=all&salesman=2')
})

test('filters: custom range validation', () => {
  const c = { ...EMPTY_FILTERS, preset: 'custom' as const }
  assert.match(customRangeError(c), /start/)
  assert.match(customRangeError({ ...c, from: '2026-10-09', to: '2026-10-01' }), /before/)
  assert.equal(customRangeError({ ...c, from: '2026-10-01' }), '')
  assert.equal(customRangeError({ ...c, from: '2026-10-01', to: '2026-10-09' }), '')
  assert.equal(customRangeError(EMPTY_FILTERS), '')
})

test('report routes map to API paths', () => {
  assert.equal(REPORT_NAV.length, 12)
  assert.equal(new Set(REPORT_NAV.map((r) => r.slug)).size, 12)
  assert.equal(apiPathFor('/reports/overview'), '/api/reports/overview/')
  assert.equal(apiPathFor('/reports/salesman-wise/5'), '/api/reports/salesman-wise/5/')
  assert.equal(apiPathFor('/reports/order-wise/'), '/api/reports/order-wise/')
  assert.equal(apiPathFor('/reports/nope'), null)
  assert.equal(apiPathFor('/dealers'), null)
  assert.equal(reportSlug('/reports/dealer-wise/9'), 'dealer-wise')
  assert.equal(reportSlug('/reports/zzz'), null)
})

test('only the Overview Dashboard is offered, and every enabled slug is a real report', () => {
  assert.deepEqual(ENABLED_REPORTS.map((r) => r.slug), ['overview'])
  assert.equal(isEnabledReport('overview'), true)
  for (const r of REPORT_NAV.filter((r) => r.slug !== 'overview')) assert.equal(isEnabledReport(r.slug), false, r.slug)
  assert.equal(isEnabledReport('nope'), false)
  for (const s of ENABLED_SLUGS) assert.ok(REPORT_NAV.some((r) => r.slug === s), `${s} is not in the catalogue`)
})

test('dates are formatted without a timezone shift', () => {
  assert.equal(fmtDay('2026-10-14'), '14 Oct 2026')
  assert.equal(fmtDay('2026-01-01', true), '1 Jan')
  assert.equal(fmtMonth('2026-10'), 'Oct 2026')
  assert.equal(fmtMonth('2026-10', true), "Oct '26")
  assert.equal(fmtStamp('2026-10-14 12:05'), '14 Oct 2026, 12:05 pm')
  assert.equal(fmtStamp('2026-10-14 00:30'), '14 Oct 2026, 12:30 am')
  assert.equal(fmtStamp('2026-10-14 15:00'), '14 Oct 2026, 3:00 pm')
  assert.equal(fmtX('2026-10-14', 'day'), '14 Oct')
  assert.equal(fmtX('2026', 'year'), '2026')
  assert.equal(fmtDay('not a date'), 'not a date')
})

test('cells: every kind, and honest blanks', () => {
  assert.equal(fmtCell('int', 1234567), '12,34,567')
  assert.equal(fmtCell('pct', 66.7), '66.7%')
  assert.equal(fmtCell('pct', 100), '100%')
  assert.equal(fmtCell('pct_opt', null), '—')
  assert.equal(fmtCell('change', 12.5), '+12.5%')
  assert.equal(fmtCell('change', -21.4), '-21.4%')
  assert.equal(fmtCell('change', null), '—')
  assert.equal(fmtCell('target', 0), 'No target')
  assert.equal(fmtCell('target', 40), '40')
  assert.equal(fmtCell('order', 12), '#12')
  assert.equal(fmtCell('dec', 10), '10.0')
  assert.equal(fmtCell('text', null), '')
  assert.equal(fmtCell('date', '2026-10-14'), '14 Oct 2026')
  assert.equal(fmtCell('month', '2026-10'), 'Oct 2026')
  assert.equal(fmtCell('mixed', 66.7, { kind: 'pct' }), '66.7%')
  assert.equal(fmtCell('mixed', 4, { kind: 'int' }), '4')
  assert.equal(fmtCell('int', 0), '0')  // zero is a real value, not a blank
})

test('cards', () => {
  const c = (value: Card['value'], format: Card['format']): Card => ({ key: 'k', label: 'L', value, format, hint: '' })
  assert.equal(fmtCard(c(27, 'int')), '27')
  assert.equal(fmtCard(c(75, 'pct')), '75%')
  assert.equal(fmtCard(c('Film A', 'text')), 'Film A')
  assert.equal(fmtCard(c(null, 'change')), '—')
  assert.equal(fmtCard(c(-65, 'change')), '-65%')
  assert.equal(fmtChange(0), '0%')
})

test('sorting puts numbers in numeric order and blanks last', () => {
  const sorted = [10, 9, null, 100, ''].sort(compareCells)
  assert.deepEqual(sorted, [9, 10, 100, null, ''])
  assert.deepEqual(['b', 'A', 'c'].sort(compareCells), ['A', 'b', 'c'])
  assert.ok(compareCells('2026-10-02', '2026-10-10') < 0)
})

test('link templates fill from the row and escape', () => {
  assert.equal(fillPath('/reports/salesman-wise/{id}', { id: 7 }), '/reports/salesman-wise/7')
  assert.equal(fillPath('/x/{name}', { name: 'a/b c' }), '/x/a%2Fb%20c')
})

test('axis: whole-number steps from zero, top covers the data', () => {
  assert.deepEqual(niceAxis(0), { top: 1, step: 1, ticks: [0, 1] })
  assert.deepEqual(niceAxis(3).ticks, [0, 1, 2, 3])
  assert.deepEqual(niceAxis(27).ticks, [0, 10, 20, 30])
  assert.deepEqual(niceAxis(100).ticks, [0, 50, 100])
  for (const max of [1, 2, 7, 13, 99, 250, 4999, 123456]) {
    const a = niceAxis(max)
    assert.ok(a.top >= max, `top ${a.top} covers ${max}`)
    assert.ok(Number.isInteger(a.step) && a.step >= 1)
    assert.equal(a.ticks[0], 0)
    assert.equal(a.ticks.at(-1), a.top)
  }
})

test('compact numbers', () => {
  assert.equal(compact(950), '950')
  assert.equal(compact(12400), '12.4K')
  assert.equal(compact(120000), '120K')
  assert.equal(compact(3200000), '3.2M')
})

test('x labels never collide and always include the newest point', () => {
  assert.deepEqual(labelIndices(5, 500, 60), [0, 1, 2, 3, 4])
  const idx = labelIndices(90, 600, 60)
  assert.equal(idx.at(-1), 89)
  assert.ok(idx.length <= 10)
  for (let i = 1; i < idx.length; i++) assert.ok((idx[i] - idx[i - 1]) * (600 / 89) >= 60 - 1)
  assert.deepEqual(labelIndices(0, 500, 60), [])
})

test('pointer maps to the nearest point, clamped', () => {
  assert.equal(nearestIndex(0, 40, 400, 11), 0)
  assert.equal(nearestIndex(240, 40, 400, 11), 5)
  assert.equal(nearestIndex(9999, 40, 400, 11), 10)
  assert.equal(nearestIndex(100, 40, 400, 1), 0)
})

test('column path rounds only the data end', () => {
  assert.equal(columnPath(0, 0, 10, 0), '')
  const d = columnPath(10, 20, 16, 50, 4)
  assert.ok(d.startsWith('M10,70 V24'))  // starts square at the baseline (y = 70) and rises
  assert.ok(d.includes('Q10,20 14,20'))  // top-left corner rounded
  assert.match(columnPath(0, 0, 4, 1, 4), /^M0,1 V/)  // a very short bar stays valid
})

test('comparison choices are only valid when complete', () => {
  assert.equal(COMPARE_KINDS.length, 5)
  assert.ok(validCompareValue('salesman', '3'))
  assert.ok(!validCompareValue('salesman', ''))
  assert.ok(!validCompareValue('salesman', 'abc'))
  assert.ok(validCompareValue('dealer', '12'))
  assert.ok(validCompareValue('product', 'p4'))
  assert.ok(validCompareValue('product', 'n:custom tint'))
  assert.ok(!validCompareValue('product', 'x4'))
  assert.ok(validCompareValue('month', '2026-10'))
  assert.ok(!validCompareValue('month', '2026-13'))
  assert.ok(validCompareValue('range', '2026-10-01..2026-10-31'))
  assert.ok(validCompareValue('range', '2026-10-05..2026-10-05'))
  assert.ok(!validCompareValue('range', '2026-10-31..2026-10-01'))
  assert.ok(!validCompareValue('range', '2026-10-01..'))
  assert.ok(!validCompareValue('nonsense', '1'))
})
