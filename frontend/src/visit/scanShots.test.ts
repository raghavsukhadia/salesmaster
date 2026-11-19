/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addShot, canRead, CARD_PHOTOS, MIN_CARD_PHOTOS, nextPhotoPrompt, removeShot } from './scanShots.ts'

const photo = (name: string) => new Blob([name], { type: 'image/jpeg' })

test('one photo is enough to read the card; two is the most', () => {
  assert.equal(MIN_CARD_PHOTOS, 1)
  assert.equal(CARD_PHOTOS, 2)
  assert.equal(canRead(0), false)
  assert.equal(canRead(1), true)
  assert.equal(canRead(2), true)
})

test('the card is full (read without asking) only after the second photo', () => {
  const first = addShot(undefined, photo('front'))
  assert.equal(first.full, false)
  assert.equal(first.shots.length, 1)
  const second = addShot(first.shots, photo('back'))
  assert.equal(second.full, true)
  assert.equal(second.shots.length, 2)
})

test('photos keep the order they were taken in, and adding does not change the list it was given', () => {
  const front = photo('front'), back = photo('back')
  const one = [front]
  const { shots } = addShot(one, back)
  assert.deepEqual(shots, [front, back])
  assert.equal(one.length, 1)
})

test('a third photo can never make the list longer than two: the newest two are kept', () => {
  const [a, b, c] = [photo('a'), photo('b'), photo('c')]
  const { shots, full } = addShot([a, b], c)
  assert.deepEqual(shots, [b, c])
  assert.equal(full, true)
})

test('removing a photo lets it be retaken', () => {
  const [a, b] = [photo('a'), photo('b')]
  assert.deepEqual(removeShot([a, b], 0), [b])
  assert.deepEqual(removeShot([a, b], 1), [a])
  assert.deepEqual(removeShot(undefined, 0), [])
  assert.equal(addShot(removeShot([a, b], 0), photo('again')).full, true)
})

test('the prompt says which photo is next, and that the back is optional', () => {
  assert.equal(nextPhotoPrompt(0), 'Photo 1: front of the card')
  assert.equal(nextPhotoPrompt(1), 'Photo 2 (optional): back of the card')
  assert.equal(nextPhotoPrompt(2), 'Photo 2 (optional): back of the card')
})
