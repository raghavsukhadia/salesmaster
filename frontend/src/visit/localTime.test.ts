/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localTime } from './format.ts'

test('the current time is "HH:MM" in 24-hour form, zero padded, the way a time input wants it', () => {
  assert.equal(localTime(new Date(2026, 10, 16, 9, 5)), '09:05')
  assert.equal(localTime(new Date(2026, 10, 16, 15, 42)), '15:42')
  assert.equal(localTime(new Date(2026, 10, 16, 0, 0)), '00:00')
  assert.equal(localTime(new Date(2026, 10, 16, 23, 59, 59)), '23:59')
})

test('with no argument it reads the clock now', () => {
  assert.match(localTime(), /^([01]\d|2[0-3]):[0-5]\d$/)
})
