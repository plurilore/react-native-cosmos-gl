import { describe, it, expect } from 'vitest'
import { isSamePlacement, type PlacedLabel } from '../react/label-placement'

const label = (index: number, x: number, y: number, text = `n${index}`): PlacedLabel =>
  ({ index, text, x, y })

describe('isSamePlacement', () => {
  it('treats sub-pixel movement as unchanged', () => {
    // A settled graph still jitters by fractions of a pixel. Reporting that as a
    // change re-renders every label ~11 times a second for nothing visible.
    expect(isSamePlacement(
      [label(0, 100, 200), label(1, 50.2, 10)],
      [label(0, 100.3, 199.8), label(1, 50, 10.4)]
    )).toBe(true)
  })

  it('reports a move of more than half a pixel', () => {
    expect(isSamePlacement([label(0, 100, 200)], [label(0, 101, 200)])).toBe(false)
    expect(isSamePlacement([label(0, 100, 200)], [label(0, 100, 198)])).toBe(false)
  })

  it('reports a changed label set', () => {
    expect(isSamePlacement([label(0, 10, 10)], [])).toBe(false)
    expect(isSamePlacement([label(0, 10, 10)], [label(0, 10, 10), label(1, 20, 20)])).toBe(false)
    // Same position, different point: a label that scrolled off and another that
    // took its slot must not be mistaken for no change.
    expect(isSamePlacement([label(0, 10, 10)], [label(1, 10, 10)])).toBe(false)
  })

  it('reports renamed text at an unchanged position', () => {
    expect(isSamePlacement(
      [label(0, 10, 10, 'alpha')],
      [label(0, 10, 10, 'beta')]
    )).toBe(false)
  })

  it('calls two empty placements the same', () => {
    expect(isSamePlacement([], [])).toBe(true)
  })
})
