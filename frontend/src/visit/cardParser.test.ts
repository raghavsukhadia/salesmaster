/// <reference types="node" />
// Run with: npm test   (node --test, native TypeScript type stripping)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_CARD, GSTIN_RE, gstinCheckChar, gstinChecksumOk, mergeCardReads, parseCard, parseCardReads, repairGstin } from './cardParser.ts'

const card = (lines: string[]) => parseCard(lines.join('\n'))

test('a clean card is read field by field', () => {
  assert.deepEqual(
    card([
      'SHARMA AUTO ACCESSORIES',
      'Rajesh Sharma',
      'Proprietor',
      'Shop No. 12, Ganesh Complex, MG Road,',
      'Pune - 411001, Maharashtra',
      'Mob: +91 98765 43210',
      'Email: sharma.auto@gmail.com',
      'GSTIN: 27ABCDE1234F1Z5',
    ]),
    {
      name: 'SHARMA AUTO ACCESSORIES', contact_name: 'Rajesh Sharma', phone: '9876543210', whatsapp: '',
      address: 'Shop No. 12, Ganesh Complex, MG Road, Pune - 411001, Maharashtra',
      city: 'Pune', state: 'Maharashtra', pincode: '411001', gst_number: '27ABCDE1234F1Z5',
    },
  )
})

test('person first with a title, tagline, landline and two mobiles', () => {
  const r = card([
    'Mr. Anil Kumar Gupta', 'Director', 'GUPTA MOTORS & TYRES PVT. LTD.', 'Dealers in: Car Accessories, Tyres',
    'Plot 5, Sector 18, Noida', 'Uttar Pradesh 201301', 'Tel: 0120-4567890', 'Mobile: 98100 12345 / 98110 54321', 'www.guptamotors.in',
  ])
  assert.equal(r.name, 'GUPTA MOTORS & TYRES PVT. LTD.')
  assert.equal(r.contact_name, 'Anil Kumar Gupta')
  assert.equal(r.phone, '9810012345') // first mobile; the landline is ignored
  assert.equal(r.whatsapp, '')
  assert.equal(r.pincode, '201301')
  assert.equal(r.state, 'Uttar Pradesh')
  assert.equal(r.city, 'Noida')
})

test('a WhatsApp-labelled number goes to WhatsApp, the other to phone', () => {
  const r = card(['Sunshine Films', 'Contact: Priya Nair', 'Ph: 99001 23456', 'WhatsApp: 99887 76655', '12, Brigade Road, Bengaluru - 560001', 'Karnataka'])
  assert.equal(r.name, 'Sunshine Films')
  assert.equal(r.contact_name, 'Priya Nair')
  assert.equal(r.phone, '9900123456')
  assert.equal(r.whatsapp, '9988776655')
  assert.equal(r.city, 'Bengaluru')
  assert.equal(r.pincode, '560001')
  assert.equal(r.state, 'Karnataka')
})

test('mobile number formats', () => {
  for (const s of ['+91 98765 43210', '+91-98765-43210', '+919876543210', '09876543210', '98765-43210', '9876543210', '91 98765 43210', '(+91) 98765 43210', 'Mob.: 98765.43210']) {
    assert.equal(parseCard(`Shop\n${s}`).phone, '9876543210', s)
  }
})

test('landline numbers are never read as a mobile', () => {
  for (const s of ['Tel: 020-24567890', '0712-6781234', 'Ph: 0120 4567890', 'Phone 022 2345 6789', 'Fax: 98765 43210']) {
    assert.equal(parseCard(`Shop Name\n${s}`).phone, '', s)
  }
})

test('a phone number is not mistaken for a pincode', () => {
  const r = card(['Raj Traders', 'Mob: 9876543210', 'Station Road, Satara - 415001'])
  assert.equal(r.pincode, '415001')
  assert.equal(r.phone, '9876543210')
})

test('GSTIN: found as printed, and repaired only when the repair passes the check character', () => {
  const REAL = '27AAPFU0939F1ZV' // a published sample GSTIN: its check character is valid
  assert.equal(card(['Raj Traders', 'GSTIN: ' + REAL]).gst_number, REAL)
  assert.equal(card(['Raj Traders', 'GST No. 27 AAPFU 0939 F 1 Z V']).gst_number, REAL) // spaced out
  assert.equal(card(['Raj Traders', 'GSTIN: 27ABCDE1234F1Z5']).gst_number, '27ABCDE1234F1Z5') // well-formed is taken as printed
  assert.equal(card(['Raj Traders', 'GSTIN : 27AAPFUO939F1ZV']).gst_number, REAL) // O -> 0, check character agrees
  assert.equal(card(['Raj Traders', 'GSTIN : 27AAPFU0939F12V']).gst_number, REAL) // Z read as 2
  assert.equal(card(['Raj Traders', 'GSTIN: 27TAAPFU0939F17V']).gst_number, REAL) // a stray letter AND Z read as 7 (what Tesseract really produced)
})

test('GSTIN: a guess that fails the check character is NOT filled in', () => {
  assert.equal(card(['Raj Traders', 'GSTIN : 27ABCDEl234F1Z5']).gst_number, '') // l -> 1 would give a well-formed value, but its check character is wrong
  assert.equal(card(['Raj Traders', 'GSTIN : 2TAAPFU0939F1ZV']).gst_number, '') // T is not a recognisable digit
  assert.equal(card(['Raj Traders', 'GSTIN: 27AAPFU0939F1XV']).gst_number, '') // 14th character must be Z
  assert.equal(card(['Raj Traders', 'GSTIN: 27AAPFU0939F1Z']).gst_number, '') // truncated
})

test('GSTIN check character matches real published numbers', () => {
  assert.equal(gstinCheckChar('27AAPFU0939F1Z'), 'V')
  assert.equal(gstinCheckChar('29AAGCB7383J1Z'), '4')
  assert.ok(gstinChecksumOk('27AAPFU0939F1ZV') && gstinChecksumOk('29AAGCB7383J1Z4'))
  assert.ok(!gstinChecksumOk('27AAPFU0939F1ZW') && !gstinChecksumOk('short'))
  assert.equal(repairGstin('short'), '')
  assert.ok(GSTIN_RE.test('27ABCDE1234F1Z5'))
})

test('the GSTIN state code fills the state only when the card does not name one', () => {
  assert.equal(card(['Raj Traders', 'Pune - 411001', 'GSTIN: 27ABCDE1234F1Z5']).state, 'Maharashtra')
  assert.equal(card(['Raj Traders', 'Hosur Road, Bengaluru, Karnataka 560068', 'GSTIN: 27ABCDE1234F1Z5']).state, 'Karnataka')
})

test('noise lines from a logo are ignored, "Prop." prefix and district lines handled', () => {
  const r = card(['= ae', 'SHREE GANESH TRADERS', 'Prop. Ramesh Patil', 'Near Bus Stand, Karad', 'Dist. Satara - 415110', 'Mob. 9423456789'])
  assert.equal(r.name, 'SHREE GANESH TRADERS')
  assert.equal(r.contact_name, 'Ramesh Patil')
  assert.equal(r.city, 'Karad') // the town, not the district
  assert.equal(r.pincode, '415110')
  assert.equal(r.phone, '9423456789')
})

test('Delhi: city and state are the same word', () => {
  assert.equal(card(['Raj Traders', 'A-12, Karol Bagh, New Delhi - 110005']).city, 'New Delhi')
  assert.equal(card(['Raj Traders', 'A-12, Karol Bagh, New Delhi - 110005']).state, 'Delhi')
  const r = card(['Raj Traders', 'Delhi - 110001'])
  assert.equal(r.state, 'Delhi')
  assert.equal(r.city, 'Delhi')
})

test('a state word in the shop name is not taken as the state', () => {
  const r = card(['KERALA TYRES', 'Shop 3, FC Road, Pune - 411004, Maharashtra'])
  assert.equal(r.name, 'KERALA TYRES')
  assert.equal(r.state, 'Maharashtra')
})

test('state aliases and city from the state line when there is no pincode', () => {
  const r = card(['Raj Traders', 'Shop 4, Main Road, Cuttack, Orissa'])
  assert.equal(r.state, 'Odisha')
  assert.equal(r.city, 'Cuttack')
})

test('business names that start with a label word are still names', () => {
  assert.equal(card(['Mobile World Accessories', 'Anita Rao', 'Owner', 'Mob: 9876543210']).name, 'Mobile World Accessories')
})

test('a business with no recognisable keyword takes the first line; the person is next to the job title', () => {
  const r = card(['Zenith', 'Ravi Kumar', 'Owner', 'Mob: 9876543210'])
  assert.equal(r.name, 'Zenith')
  assert.equal(r.contact_name, 'Ravi Kumar')
})

test('a person-only card leaves the dealer name blank instead of guessing', () => {
  const r = card(['Rajesh Sharma', 'Proprietor', 'Mob: 98765 43210'])
  assert.equal(r.name, '')
  assert.equal(r.contact_name, 'Rajesh Sharma')
  assert.equal(r.phone, '9876543210')
})

test('designation in brackets or after a comma is stripped from the contact', () => {
  assert.equal(card(['Raj Traders', 'Rajesh Sharma (Proprietor)']).contact_name, 'Rajesh Sharma')
  assert.equal(card(['Raj Traders', 'RAJESH SHARMA, Owner']).contact_name, 'Rajesh Sharma')
})

test('"Add:" label is dropped from the address', () => {
  assert.equal(card(['Raj Traders', 'Add: Shop 3, FC Road, Pune - 411004']).address, 'Shop 3, FC Road, Pune - 411004')
})

test('"24 Hours Service" is not an address, and a pincode with a Pin label is read', () => {
  const r = card(['Raj Traders', '24 Hours Service', 'Camp, Pune. Pin: 411 001'])
  assert.equal(r.address, 'Camp, Pune. Pin: 411 001')
  assert.equal(r.pincode, '411001')
})

test('empty, whitespace and garbage input give an empty result, never throw', () => {
  assert.deepEqual(parseCard(''), EMPTY_CARD)
  assert.deepEqual(parseCard('  \n \n'), EMPTY_CARD)
  assert.deepEqual(parseCard('|| __ ~~ ..\n= - =\n,,'), EMPTY_CARD)
})

test('the result is deterministic and never mutates the shared empty value', () => {
  const a = card(['Raj Traders', 'Mob: 9876543210'])
  const b = card(['Raj Traders', 'Mob: 9876543210'])
  assert.deepEqual(a, b)
  assert.equal(EMPTY_CARD.phone, '')
})

test('a business name wrapped over two lines is joined, and a logo glyph misread as a letter is dropped', () => {
  const r = card(['SHARMA AUTO O', 'ACCESSORIES', 'Car Accessories Window Films Tyres', 'Rajesh Sharma', 'Proprietor', 'Pune - 411001, Maharashtra', 'Mob: +91 98765 43210'])
  assert.equal(r.name, 'SHARMA AUTO ACCESSORIES')
  assert.equal(r.contact_name, 'Rajesh Sharma')
})

test('a second line is NOT joined when it is a person, a tagline in another case, or too long', () => {
  assert.equal(card(['SHARMA AUTO', 'RAJESH SHARMA', 'Proprietor', 'Mob: 9876543210']).name, 'SHARMA AUTO') // person
  assert.equal(card(['SHARMA AUTO', 'Car Accessories Window Films', 'Mob: 9876543210']).name, 'SHARMA AUTO') // different case style
  assert.equal(card(['GUPTA MOTORS', 'AND SONS PRIVATE LIMITED COMPANY', 'Mob: 9876543210']).name, 'GUPTA MOTORS') // would exceed six words
})

test('mobile numbers in other groupings, and OCR letter/digit mix-ups inside them', () => {
  for (const s of ['987 654 3210', '98 7654 3210', 'Mob: 9876 543 210', '+91 98765-432l0', 'Ph: 98765 4321O', 'Cell 98765 43 210']) {
    assert.equal(parseCard(`Raj Traders\n${s}`).phone, '9876543210', s)
  }
  // landlines still never count, and a short run of digits is not stretched into a mobile
  assert.equal(parseCard('Raj Traders\nTel: 0712 274 5678').phone, '')
  assert.equal(parseCard('Raj Traders\nShop 9, 12 Lane').phone, '')
})

test('an "Add:" address with no road words is still read, including the line it wraps onto', () => {
  const r = card(['PATIL CAR CARE', 'Add: 14, Gandhi Bhavan,', 'Sitabuldi, Nagpur - 440012', 'Mob: 98220 12345'])
  assert.equal(r.address, '14, Gandhi Bhavan, Sitabuldi, Nagpur - 440012')
  assert.equal(r.city, 'Nagpur')
  assert.equal(r.pincode, '440012')
  assert.equal(r.phone, '9822012345')
  assert.equal(r.name, 'PATIL CAR CARE')
})

test('an address line ending in a comma carries on to the next line', () => {
  const r = card(['Raj Traders', 'Gala No. 4, Sai Krupa,', 'Kalyan West', 'Thane 421301, Maharashtra', 'Mob: 9876543210'])
  assert.equal(r.address, 'Gala No. 4, Sai Krupa, Kalyan West, Thane 421301, Maharashtra')
  assert.equal(r.city, 'Thane')
})

test('a pincode printed in two groups is read on an address line', () => {
  const r = card(['Raj Traders', 'Near Bus Stand, Wardha - 442 001', 'Mob: 9876543210'])
  assert.equal(r.pincode, '442001')
  assert.equal(r.city, 'Wardha')
})

test('a one-word brand and initials-style names are kept whole', () => {
  assert.equal(card(['Zenith', 'Mob: 9876543210']).name, 'Zenith')
  assert.equal(card(['R K Traders', 'Mob: 9876543210']).name, 'R K Traders')
})

// ───────────── several reads of one card ─────────────

const read = (confidence: number, fields: Partial<typeof EMPTY_CARD>) => ({ confidence, fields: { ...EMPTY_CARD, ...fields } })

test('reads that agree beat a single more confident read', () => {
  const r = mergeCardReads([
    read(70, { phone: '9876543210' }),
    read(65, { phone: '9876543210' }),
    read(90, { phone: '9876543218' }),
  ])
  assert.equal(r.phone, '9876543210')
})

test('agreement ignores case and punctuation, and keeps the most confident spelling', () => {
  const r = mergeCardReads([read(60, { name: 'SHARMA AUTO.' }), read(80, { name: 'Sharma Auto' }), read(95, { name: 'SHARMA AUT0 ACC' })])
  assert.equal(r.name, 'Sharma Auto')
})

test('each field is taken from whichever read found it', () => {
  const r = mergeCardReads([
    read(80, { name: 'Sharma Auto', phone: '9876543210' }),
    read(70, { address: 'MG Road, Pune - 411001', city: 'Pune', pincode: '411001' }),
    read(40, {}),
  ])
  assert.deepEqual(r, { ...EMPTY_CARD, name: 'Sharma Auto', phone: '9876543210', address: 'MG Road, Pune - 411001', city: 'Pune', pincode: '411001' })
})

test('a GSTIN that passes its check character wins over one that does not', () => {
  const good = '27ABCDE1234F1Z' + gstinCheckChar('27ABCDE1234F1Z')
  const bad = '27ABCDE1234F1Z' + (good.endsWith('A') ? 'B' : 'A')
  assert.equal(mergeCardReads([read(95, { gst_number: bad }), read(90, { gst_number: bad }), read(50, { gst_number: good })]).gst_number, good)
})

test('a WhatsApp number equal to the merged phone is dropped', () => {
  const r = mergeCardReads([read(90, { phone: '9876543210' }), read(50, { phone: '9123456780', whatsapp: '9876543210' })])
  assert.equal(r.phone, '9876543210')
  assert.equal(r.whatsapp, '')
})

test('front and back reads are paired by treatment and merged', () => {
  const front = [
    { text: 'SHARMA AUTO ACCESSORIES\nMob: 98765 43210', confidence: 85 },
    { text: '=- ,|\nMob: 98765 43210', confidence: 60 },
  ]
  const back = [{ text: 'Shop 12, MG Road,\nPune - 411001, Maharashtra', confidence: 80 }]
  const r = parseCardReads([front, back])
  assert.equal(r.fields.name, 'SHARMA AUTO ACCESSORIES')
  assert.equal(r.fields.phone, '9876543210')
  assert.equal(r.fields.city, 'Pune')
  assert.equal(r.fields.state, 'Maharashtra')
  assert.equal(r.text, `${front[0].text}\n${back[0].text}`)
})

test('no reads at all give empty fields', () => {
  assert.deepEqual(parseCardReads([]), { fields: EMPTY_CARD, text: '' })
  assert.deepEqual(parseCardReads([[]]), { fields: EMPTY_CARD, text: '' })
})
