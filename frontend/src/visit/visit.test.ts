/// <reference types="node" />
// Run with: npm test   (node --test, native TypeScript type stripping)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CARD_DRAFT_KEYS, draftPayload, EMPTY_DRAFT, hasLocation, isTenDigitNumber, normalizePhone, validateDraft, type DealerDraft } from './dealerDraft.ts'
import { fmtInr, fmtPaise, lineTotalPaise, orderTotalPaise, parsePaise, parsePrice, priceError, toOrderItems, type OrderLine } from './orderMath.ts'

const draft = (over: Partial<DealerDraft> = {}): DealerDraft => ({ ...EMPTY_DRAFT, name: 'Sharma Auto', phone: '98765 43210', ...over })
const line = (over: Partial<OrderLine> = {}): OrderLine => ({ key: 'k', product_name: 'Film', quantity: 1, unit: 'pcs', unit_price: '', ...over })

// ───────────── order math ─────────────

test('prices parse to exact paise, tolerating commas, spaces and a rupee sign', () => {
  assert.equal(parsePaise('1250.50'), 125050)
  assert.equal(parsePaise('1,25,000'), 12500000)
  assert.equal(parsePaise(' ₹ 99 '), 9900)
  assert.equal(parsePaise('0.5'), 50)
  assert.equal(parsePaise('.5'), null) // must start with a digit
  assert.equal(parsePrice('10.05'), 10.05)
})

test('an empty price is allowed (an unpriced line), nonsense is not', () => {
  assert.equal(parsePaise(''), 0)
  for (const bad of ['abc', '-5', '1.234', '1..2', '12-3', '1e5', '10000000000', '99999999999999']) assert.equal(parsePaise(bad), null, bad)
  assert.equal(parsePaise('9999999999.99'), 999_999_999_999) // the server maximum, exactly
  assert.equal(priceError('12.5'), '')
  assert.notEqual(priceError('x'), '')
})

test('line and order totals have no floating point drift', () => {
  assert.equal(lineTotalPaise({ quantity: 3, unit_price: '1250.50' }), 375150)
  assert.equal(lineTotalPaise({ quantity: 3, unit_price: '0.1' }), 30) // 3 x 0.1 is 0.30000000000000004 in floats
  assert.equal(orderTotalPaise([line({ quantity: 3, unit_price: '1250.50' }), line({ quantity: 10, unit_price: '99' }), line({ quantity: 1 })]), 375150 + 99000 + 0)
  assert.equal(orderTotalPaise([]), 0)
})

test('an invalid price counts as zero instead of breaking the total', () => {
  assert.equal(lineTotalPaise({ quantity: 5, unit_price: 'oops' }), 0)
  assert.equal(orderTotalPaise([line({ quantity: 2, unit_price: '100' }), line({ quantity: 5, unit_price: 'oops' })]), 20000)
})

test('rupees use Indian grouping and drop pointless decimals', () => {
  assert.equal(fmtInr(125000.5), '₹1,25,000.50')
  assert.equal(fmtInr(1250), '₹1,250')
  assert.equal(fmtInr(0), '₹0')
  assert.equal(fmtPaise(375150), '₹3,751.50')
})

test('the request body carries product id or custom name, a unit, and a two-decimal price string', () => {
  const body = toOrderItems([
    line({ product_id: 7, product_name: 'Film A', quantity: 2, unit: 'roll', unit_price: '1,250.5' }),
    line({ product_name: 'Custom tint', quantity: 1, unit: 'sq ft', unit_price: '' }),
  ])
  assert.deepEqual(body, [
    { product_id: 7, quantity: 2, unit: 'roll', unit_price: '1250.50' },
    { product_name: 'Custom tint', quantity: 1, unit: 'sq ft', unit_price: '0.00' },
  ])
})

// ───────────── dealer draft ─────────────

test('phone numbers normalise the way the server does', () => {
  for (const s of ['+91 98765 43210', '09876543210', '98765-43210', '(+91) 98765 43210']) assert.equal(normalizePhone(s), '9876543210', s)
  assert.ok(isTenDigitNumber('+91 98765 43210') && isTenDigitNumber('09876543210') && isTenDigitNumber('9876543210'))
  for (const s of ['98765', '98765 4321', '98765 432101', '+91 98765 4321', 'abcdefghij']) assert.ok(!isTenDigitNumber(s), s)
})

/** A draft with every required (starred) field filled: business name, phone, address, city, state, pincode. */
const complete = (over: Partial<DealerDraft> = {}): DealerDraft =>
  draft({ city: 'Pune', address: 'Shop 4, MG Road', state: 'Maharashtra', pincode: '411001', latitude: '18.520400', longitude: '73.856700', location_accuracy_m: '15', ...over })

test('a good draft passes', () => {
  assert.deepEqual(validateDraft(complete()), {})
  assert.deepEqual(validateDraft(complete({ phone: '+91 98765-43210' })), {}) // any common way of writing the number
})

test('every field on the form is required: business name, phone, address, city, state, pincode and the shop location', () => {
  assert.deepEqual(Object.keys(validateDraft(EMPTY_DRAFT)).sort(), ['address', 'city', 'location', 'name', 'phone', 'pincode', 'state'])
  assert.deepEqual(Object.keys(validateDraft(complete({ latitude: '', longitude: '', location_accuracy_m: '' }))), ['location'], 'no Continue without the shop location')
  assert.equal(validateDraft(complete({ name: '  ' })).name, 'Enter the business name')
  for (const k of ['name', 'phone', 'address', 'city', 'state', 'pincode'] as const) {
    assert.deepEqual(Object.keys(validateDraft(complete({ [k]: '   ' }))), [k], `${k} is required, and only ${k} is reported`)
  }
})

test('a filled field is still checked on its own', () => {
  assert.ok(validateDraft(complete({ phone: '98765' })).phone)
  assert.ok(validateDraft(complete({ pincode: '4110' })).pincode)
})

test('contact person, WhatsApp and GST are not part of the Record Visit form: not in a draft, not validated, not sent', () => {
  for (const k of ['contact_name', 'whatsapp', 'gst_number']) assert.ok(!(k in EMPTY_DRAFT), `${k} must not be a draft field`)
  // Even if one sneaks in (an old saved draft, a scan), it can neither block Continue nor reach the server.
  const sneaky = { ...complete(), whatsapp: '12', gst_number: 'not-a-gstin', contact_name: 'Raj' } as DealerDraft
  assert.deepEqual(validateDraft(sneaky), {})
  const sent = draftPayload(sneaky)
  for (const k of ['contact_name', 'whatsapp', 'gst_number']) assert.ok(!(k in sent), `${k} must not be sent`)
})

test('a scanned card fills only the fields that are on the form', () => {
  assert.deepEqual([...CARD_DRAFT_KEYS].sort(), ['address', 'city', 'name', 'phone', 'pincode', 'state'])
  for (const k of CARD_DRAFT_KEYS) assert.ok(k in EMPTY_DRAFT, `${k} must be a draft field`)
})

test('the payload is trimmed, normalised and leaves out empty fields', () => {
  assert.deepEqual(
    draftPayload(draft({ name: '  Sharma Auto ', phone: '+91 98765 43210', city: 'Pune', address: '' })),
    { name: 'Sharma Auto', phone: '9876543210', city: 'Pune' },
  )
})

test('a detected shop location travels with the dealer as a pair, and is absent until detected', () => {
  const fix = { latitude: '18.520400', longitude: '73.856700', location_accuracy_m: '12.5' }
  assert.deepEqual(draftPayload(draft({ city: 'Pune', ...fix })), { name: 'Sharma Auto', phone: '9876543210', city: 'Pune', ...fix })
  const none = draftPayload(draft({ city: 'Pune' }))
  assert.ok(!('latitude' in none) && !('longitude' in none) && !('location_accuracy_m' in none))
  // Half a coordinate would be a 400 from the server, so it is never sent.
  const half = draftPayload(draft({ city: 'Pune', latitude: '18.520400', location_accuracy_m: '12.5' }))
  assert.ok(!('latitude' in half) && !('longitude' in half) && !('location_accuracy_m' in half))
  assert.equal(hasLocation(draft(fix)), true)
  assert.equal(hasLocation(draft()), false)
})

// ───────────── display helpers ─────────────

import { fmtClock, fmtDue, visitStatus } from './format.ts'

test('times of day read the way people say them', () => {
  assert.equal(fmtClock('14:05'), '2:05 pm')
  assert.equal(fmtClock('00:30'), '12:30 am')
  assert.equal(fmtClock('12:00'), '12:00 pm')
  assert.equal(fmtClock('09:15:00'), '9:15 am') // the server may send seconds
  for (const bad of [null, undefined, '', 'noon', '25:00', '10:75']) assert.equal(fmtClock(bad), '', String(bad))
})

test('a due date shows its time only when there is one', () => {
  assert.equal(fmtDue('2026-12-05', '14:05'), '5 Dec 2026, 2:05 pm')
  assert.equal(fmtDue('2026-12-05'), '5 Dec 2026')
  assert.equal(fmtDue('2026-12-05', null), '5 Dec 2026')
})

test('every server status has a label, and an unknown one degrades to "Visited"', () => {
  assert.equal(visitStatus('order').label, 'Order placed')
  assert.equal(visitStatus('followup').tone, 'amber')
  assert.equal(visitStatus('something-new').label, 'Visited')
})

// ───────────── generated passwords ─────────────

import { generatePassword, PASSWORD_ALPHABET } from '../credentials.ts'

test('a generated password is 12 look-alike-free characters in three groups', () => {
  for (let i = 0; i < 200; i++) {
    const p = generatePassword()
    assert.match(p, /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/)
    assert.ok(!/[0O1lI]/.test(p), p)
    assert.ok(p.replace(/-/g, '').length >= 8 && !/^\d+$/.test(p), 'meets the server minimum length and is not all digits')
  }
})

test('generated passwords differ and use the whole alphabet', () => {
  const seen = new Set<string>()
  const chars = new Set<string>()
  for (let i = 0; i < 300; i++) { const p = generatePassword(); seen.add(p); for (const c of p.replace(/-/g, '')) chars.add(c) }
  assert.equal(seen.size, 300)
  assert.ok(chars.size > PASSWORD_ALPHABET.length * 0.9, `only ${chars.size} distinct characters seen`)
})

test('biased random values are rejected, not folded in (every character stays equally likely)', () => {
  // 0xFFFFFFFF is in the uneven tail of the 32-bit range for a 58-character alphabet: it must be skipped, not mapped.
  let call = 0
  const stub = (n: number) => { call++; return call === 1 ? new Uint32Array(n).fill(0xffffffff) : new Uint32Array(n).fill(5) }
  const p = generatePassword(stub)
  assert.equal(p, `${PASSWORD_ALPHABET[5].repeat(4)}-${PASSWORD_ALPHABET[5].repeat(4)}-${PASSWORD_ALPHABET[5].repeat(4)}`)
  assert.equal(call, 2)
})
