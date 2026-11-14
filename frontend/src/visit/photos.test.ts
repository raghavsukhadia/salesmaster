/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fitWithin, photoCounter, photoIds, photoProblem, photoSummary, type PhotoItem } from './photoMath.ts'

const item = (status: PhotoItem['status'], id?: number): PhotoItem => ({ key: `k${Math.random()}`, previewUrl: 'blob:x', name: 'a.jpg', status, id })

test('fitWithin shrinks the longest side, keeps the ratio and never enlarges', () => {
  assert.deepEqual(fitWithin(4000, 3000, 1600), { width: 1600, height: 1200 })
  assert.deepEqual(fitWithin(3000, 4000, 1600), { width: 1200, height: 1600 }) // portrait
  assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600 }) // already small: untouched
  assert.deepEqual(fitWithin(1600, 1600, 1600), { width: 1600, height: 1600 })
  assert.deepEqual(fitWithin(10000, 1, 1600), { width: 1600, height: 1 }) // never collapses to zero
})

test('the summary counts finished photos only, and is ready only when enough are done and none are in flight or broken', () => {
  assert.deepEqual(photoSummary([], 2), { done: 0, uploading: 0, failed: 0, missing: 2, ready: false })
  assert.equal(photoSummary([item('done', 1)], 2).missing, 1)
  assert.equal(photoSummary([item('done', 1), item('done', 2)], 2).ready, true)
  assert.equal(photoSummary([item('done', 1), item('uploading')], 2).ready, false) // the second is not on the server yet
  assert.equal(photoSummary([item('done', 1), item('done', 2), item('error')], 2).ready, false) // a broken extra blocks too
  assert.equal(photoSummary([item('done', 1), item('done', 2), item('done', 3)], 2).ready, true) // extras are fine
  assert.equal(photoSummary([], 0).ready, true) // rule switched off
})

test('only photos the server has confirmed are sent', () => {
  assert.deepEqual(photoIds([item('done', 7), item('uploading'), item('error'), item('done', 9)]), [7, 9])
  assert.deepEqual(photoIds([]), [])
})

test('the message explains exactly what is missing', () => {
  assert.equal(photoProblem([], 2), 'Add at least 2 car photos (you have 0).')
  assert.equal(photoProblem([item('done', 1)], 2), 'Add at least 2 car photos (you have 1).')
  assert.equal(photoProblem([item('done', 1), item('uploading')], 2), 'Wait for the photos to finish uploading.')
  assert.equal(photoProblem([item('done', 1), item('done', 2), item('error')], 2), 'Retry or remove the photo that failed to upload.')
  assert.equal(photoProblem([item('done', 1), item('done', 2)], 2), null)
  assert.equal(photoProblem([], 0), null)
  assert.equal(photoProblem([], null), null) // rules not loaded yet: the server decides
})

test('the counter reads naturally for required and optional photos', () => {
  assert.equal(photoCounter([], 2), '0 of 2 required')
  assert.equal(photoCounter([item('done', 1)], 2), '1 of 2 required')
  assert.equal(photoCounter([item('done', 1), item('done', 2)], 2), '2 added')
  assert.equal(photoCounter([], 0), 'Optional')
  assert.equal(photoCounter([item('done', 1)], 0), '1 added')
})
