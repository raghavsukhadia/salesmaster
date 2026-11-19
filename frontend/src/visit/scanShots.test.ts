/// <reference types="node" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addShot, CARD_PHOTOS, nextPhotoPrompt, removeShot } from './scanShots.ts'

const photo = (name: string) => new Blob([name], { type: 'image/jpeg' })

test('a card needs two photos', () => {
  assert.equal(CARD_PHOTOS, 2)
})

test('the card is not ready after one photo, and is ready after the second', () => {
  const first = addShot(undefined, photo('front'))
  assert.equal(first.ready, false)
  assert.equal(first.shots.length, 1)
  const second = addShot(first.shots, photo('back'))
  assert.equal(second.ready, true)
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
  const { shots, ready } = addShot([a, b], c)
  assert.deepEqual(shots, [b, c])
  assert.equal(ready, true)
})

test('removing a photo takes the card back to "not ready" so it can be retaken', () => {
  const [a, b] = [photo('a'), photo('b')]
  assert.deepEqual(removeShot([a, b], 0), [b])
  assert.deepEqual(removeShot([a, b], 1), [a])
  assert.deepEqual(removeShot(undefined, 0), [])
  assert.equal(addShot(removeShot([a, b], 0), photo('again')).ready, true)
})

test('the prompt says which photo is next', () => {
  assert.equal(nextPhotoPrompt(0), 'Photo 1 of 2: front of the card')
  assert.equal(nextPhotoPrompt(1), 'Photo 2 of 2: back of the card')
  assert.equal(nextPhotoPrompt(2), 'Photo 2 of 2: back of the card') // never runs past the last photo
})
