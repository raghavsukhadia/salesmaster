/// <reference types="node" />
// Run with: npm test   (node --test, native TypeScript type stripping)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localDate } from './format.ts'
import { dueDateFor, EMPTY_NEXT_STEP, NEXT_ACTIONS, nextStepFollowup, nextStepProblems, WHEN_OPTIONS, type NextStep } from './nextStep.ts'

const step = (over: Partial<NextStep> = {}): NextStep => ({ ...EMPTY_NEXT_STEP, ...over })

test('the options are the ones on the screen, in order, and "Next Week" is the default time', () => {
  assert.deepEqual(NEXT_ACTIONS.map((a) => a.label), ['Nothing', 'Call dealer', 'Send quotation', 'Send sample', 'Revisit dealer', 'Collect payment', 'Other'])
  assert.deepEqual(WHEN_OPTIONS.map((w) => w.label), ['Tomorrow', 'In 2 Days', 'Next Week', 'Custom'])
  assert.equal(EMPTY_NEXT_STEP.when, 'next_week')
})

test('the choice is required: nothing picked is a problem, and so is it alone', () => {
  assert.equal(EMPTY_NEXT_STEP.action, null)
  assert.equal(nextStepProblems(EMPTY_NEXT_STEP).length, 1)
  assert.match(nextStepProblems(EMPTY_NEXT_STEP)[0], /Choose what you will do next/)
  assert.equal(nextStepFollowup(EMPTY_NEXT_STEP), null)
})

test('"Nothing" is a valid answer and records no follow-up, whatever else was typed before', () => {
  const s = step({ action: 'nothing', when: 'custom', customDate: '', text: 'stale', note: 'stale' })
  assert.deepEqual(nextStepProblems(s), [])
  assert.equal(nextStepFollowup(s), null)
})

test('a plain action is complete as soon as it is picked, and is due on the chosen day', () => {
  for (const a of ['call_dealer', 'send_quotation', 'send_sample', 'revisit_dealer', 'collect_payment'] as const) {
    assert.deepEqual(nextStepProblems(step({ action: a })), [], a)
  }
  assert.deepEqual(nextStepFollowup(step({ action: 'call_dealer', when: 'tomorrow' })), { due_date: localDate(1), action: 'call_dealer' })
  assert.equal(dueDateFor(step({ when: 'in_2_days' })), localDate(2))
  assert.equal(dueDateFor(step({ when: 'next_week' })), localDate(7))
})

test('"Other" needs words for what to do; blanks do not count', () => {
  assert.deepEqual(nextStepProblems(step({ action: 'other' })), ['Say what you will do.'])
  assert.deepEqual(nextStepProblems(step({ action: 'other', text: '   ' })), ['Say what you will do.'])
  const s = step({ action: 'other', text: '  Confirm installation date ', note: ' Dealer asked for revised PPF pricing. ' })
  assert.deepEqual(nextStepProblems(s), [])
  assert.deepEqual(nextStepFollowup(s), { due_date: localDate(7), action: 'other', action_text: 'Confirm installation date', notes: 'Dealer asked for revised PPF pricing.' })
})

test('the typed text is only sent for "Other"; a blank note is not sent', () => {
  const f = nextStepFollowup(step({ action: 'send_sample', text: 'left over from Other', note: '   ' }))
  assert.deepEqual(f, { due_date: localDate(7), action: 'send_sample' })
})

test('a custom date must be chosen, not in the past, and within a year', () => {
  const custom = (customDate: string) => step({ action: 'call_dealer', when: 'custom', customDate })
  assert.deepEqual(nextStepProblems(custom('')), ['Choose a date for the follow-up.'])
  assert.deepEqual(nextStepProblems(custom(localDate(-1))), ['The follow-up date cannot be in the past.'])
  assert.deepEqual(nextStepProblems(custom(localDate(366))), ['Choose a date within the next year.'])
  assert.deepEqual(nextStepProblems(custom(localDate())), [])
  assert.deepEqual(nextStepProblems(custom(localDate(365))), [])
  assert.equal(nextStepFollowup(custom(localDate(10)))?.due_date, localDate(10))
})

test('every problem is reported at once', () => {
  assert.equal(nextStepProblems(step({ action: 'other', when: 'custom' })).length, 2)
})
