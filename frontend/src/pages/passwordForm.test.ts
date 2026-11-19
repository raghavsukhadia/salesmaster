/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activeLabel, managementNav, salesmanNav } from '../components/nav.ts'
import { crumbsFor } from '../components/crumbs.ts'
import { MIN_PASSWORD, validatePasswordChange } from './passwordForm.ts'

const good = { current: 'old-password-1', next: 'brand-new-pass-9', confirm: 'brand-new-pass-9' }

test('a filled-in, matching form passes', () => {
  assert.deepEqual(validatePasswordChange(good), {})
})

test('every box is required', () => {
  assert.deepEqual(Object.keys(validatePasswordChange({ current: '', next: '', confirm: '' })).sort(), ['confirm', 'current', 'next'])
})

test('the new password has a minimum length that matches the server', () => {
  assert.equal(MIN_PASSWORD, 8)
  const short = 'a'.repeat(MIN_PASSWORD - 1)
  assert.match(validatePasswordChange({ ...good, next: short, confirm: short }).next ?? '', /at least 8/)
  const exact = 'a'.repeat(MIN_PASSWORD)
  assert.equal(validatePasswordChange({ ...good, next: exact, confirm: exact }).next, undefined)
})

test('the new password must differ from the current one', () => {
  assert.match(validatePasswordChange({ ...good, next: good.current, confirm: good.current }).next ?? '', /different/)
})

test('the confirmation must match, and only the confirmation is blamed', () => {
  const e = validatePasswordChange({ ...good, confirm: 'something-else-1' })
  assert.deepEqual(Object.keys(e), ['confirm'])
  assert.match(e.confirm ?? '', /do not match/)
})

test('spaces are part of a password, not trimmed away', () => {
  const spaced = '  spaced pass  '
  assert.deepEqual(validatePasswordChange({ current: 'old-password-1', next: spaced, confirm: spaced }), {})
  assert.ok(validatePasswordChange({ current: 'old-password-1', next: spaced, confirm: spaced.trim() }).confirm)
})

test('Settings is a real page in the management menu, not a "soon" placeholder, and it is not offered to salesmen', () => {
  const item = managementNav.find((i) => i.label === 'Settings')
  assert.ok(item, 'the management menu has a Settings entry')
  assert.equal(item.to, '/settings')
  assert.equal(item.soon, undefined)
  assert.equal(activeLabel(managementNav, '/settings'), 'Settings')
  assert.ok(!salesmanNav.some((i) => i.label === 'Settings'))
})

test('the Settings page has a breadcrumb', () => {
  assert.deepEqual(crumbsFor('/settings'), [{ label: 'Settings' }])
})
