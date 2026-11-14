import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crumbsFor } from './crumbs.ts'
import { dealerSeverity, fieldErrors, flatten, fmtRelative, pct, qs } from './logic.ts'
import { activeLabel, managementNav, salesmanNav } from './nav.ts'

// All times are built in local time so the expectations hold in any timezone.
const NOW = new Date(2026, 10, 14, 15, 0, 0)
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MIN = 60_000, HOUR = 60 * MIN
const rel = (iso: string | null | undefined) => fmtRelative(iso, NOW.getTime())

test('fmtRelative: never invents a time, and steps from minutes to hours to a calendar day', () => {
  assert.equal(rel(null), '—')
  assert.equal(rel(undefined), '—')
  assert.equal(rel(ago(20_000)), 'just now')
  assert.equal(rel(ago(12 * MIN)), '12 min ago')
  assert.equal(rel(ago(59 * MIN)), '59 min ago')
  assert.equal(rel(ago(3 * HOUR)), '3 h ago')
  assert.equal(rel(ago(7 * HOUR)), 'Today, 8:00 am')
  assert.equal(rel(new Date(2026, 10, 13, 16, 10).toISOString()), 'Yesterday, 4:10 pm')
  assert.equal(rel(new Date(2026, 10, 9, 15, 0).toISOString()), '9 Nov 2026, 3:00 pm')
})

test('fmtRelative: a timestamp slightly in the future (clock skew) reads "just now", not a negative age', () => {
  assert.equal(rel(new Date(NOW.getTime() + 30_000).toISOString()), 'just now')
})

test('qs: drops empty values and encodes the rest', () => {
  assert.equal(qs({ q: 'a b&c', page: 2, range: '', sort: undefined }), 'q=a%20b%26c&page=2')
})

test('flatten and fieldErrors understand Django REST error bodies', () => {
  const body = { username: ['This username is taken'], phone_number: ['Too short', 'Digits only'], non_field_errors: ['Try again'] }
  assert.deepEqual(flatten(body), ['username: This username is taken', 'phone number: Too short', 'phone number: Digits only', 'Try again'])
  // Field errors go next to their field; form-level errors are not attributed to any field.
  assert.deepEqual(fieldErrors(body), { username: 'This username is taken', phone_number: 'Too short Digits only' })
  assert.deepEqual(fieldErrors({ detail: 'Not found' }), {})
  assert.deepEqual(fieldErrors(null), {})
  assert.deepEqual(fieldErrors(['x']), {})
})

test('dealerSeverity: Clear at zero, then Low / Medium / High at the 20% and 50% share boundaries', () => {
  assert.equal(dealerSeverity(0, 100), 'Clear')
  assert.equal(dealerSeverity(1, 100), 'Low')
  assert.equal(dealerSeverity(19, 100), 'Low')
  assert.equal(dealerSeverity(20, 100), 'Medium')
  assert.equal(dealerSeverity(49, 100), 'Medium')
  assert.equal(dealerSeverity(50, 100), 'High')
  assert.equal(dealerSeverity(100, 100), 'High')
  // No dealers at all must not divide by zero.
  assert.equal(dealerSeverity(0, 0), 'Clear')
})

test('pct rounds and is safe with no dealers', () => {
  assert.equal(pct(1, 3), 33)
  assert.equal(pct(2, 3), 67)
  assert.equal(pct(5, 0), 0)
})

test('activeLabel: management sub-pages light up Management, not Dealers; detail pages light up their list', () => {
  const at = (p: string) => activeLabel(managementNav, p)
  assert.equal(at('/dashboard'), 'Dashboard')
  assert.equal(at('/dealers'), 'Dealers')
  assert.equal(at('/dealers/12'), 'Dealers')
  assert.equal(at('/dealers/ownership-cleanup'), 'Management')
  assert.equal(at('/dealers/access-grants'), 'Management')
  assert.equal(at('/dealers/transfer'), 'Management')
  assert.equal(at('/products'), 'Management')
  assert.equal(at('/followups-management/3'), 'Follow-ups')
  assert.equal(at('/salesmen/4'), 'Salesman')
  assert.equal(at('/somewhere-else'), null)
  assert.equal(activeLabel(salesmanNav, '/visit-history/9'), 'Visit History')
})

test('every nav item is either a real route, a group of routes, or an explained "not available" entry', () => {
  for (const it of [...managementNav, ...salesmanNav]) {
    const kinds = [!!it.to, !!it.children?.length, !!it.soon].filter(Boolean).length
    assert.equal(kinds, 1, `${it.label} must be exactly one of: route, group, not-available`)
    if (it.soon) assert.ok(it.soon.length > 20, `${it.label} must say why it is unavailable`)
  }
})

test('crumbsFor: static pages, grouped Management pages, and detail pages with an optional real name', () => {
  assert.deepEqual(crumbsFor('/dealers'), [{ label: 'Dealers' }])
  assert.deepEqual(crumbsFor('/dealers/'), [{ label: 'Dealers' }])
  assert.deepEqual(crumbsFor('/dealers/ownership-cleanup'), [{ label: 'Management' }, { label: 'Ownership Cleanup' }])
  assert.deepEqual(crumbsFor('/dealers/7'), [{ label: 'Dealers', to: '/dealers' }, { label: 'Dealer' }])
  assert.deepEqual(crumbsFor('/dealers/7', 'Sharma Motors'), [{ label: 'Dealers', to: '/dealers' }, { label: 'Sharma Motors' }])
  assert.deepEqual(crumbsFor('/visits/9'), [{ label: 'Visits', to: '/visits' }, { label: 'Visit #9' }])
  assert.deepEqual(crumbsFor('/not/a/page'), [])
})
