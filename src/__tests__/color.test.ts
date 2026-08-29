import { describe, it, expect } from 'vitest'
import { getRgbaColor, rgbToBrightness } from '../core/color'

/** Compares channels with a tolerance, since parsing divides by 255. */
const closeTo = (actual: number[], expected: number[]): void => {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i] as number, 5))
}

describe('getRgbaColor', () => {
  it('parses six-digit hex', () => {
    closeTo(getRgbaColor('#222222'), [0x22 / 255, 0x22 / 255, 0x22 / 255, 1])
  })

  it('parses shorthand hex by repeating digits, not padding', () => {
    // #abc is #aabbcc, not #0a0b0c — a padding bug renders everything near-black.
    closeTo(getRgbaColor('#abc'), [0xaa / 255, 0xbb / 255, 0xcc / 255, 1])
  })

  it('parses eight-digit hex alpha', () => {
    closeTo(getRgbaColor('#ff000080'), [1, 0, 0, 0x80 / 255])
  })

  it('parses named colors', () => {
    closeTo(getRgbaColor('white'), [1, 1, 1, 1])
    closeTo(getRgbaColor('rebeccapurple'), [0x66 / 255, 0x33 / 255, 0x99 / 255, 1])
  })

  it('parses rgb() and rgba() in both comma and space syntax', () => {
    closeTo(getRgbaColor('rgb(255, 0, 0)'), [1, 0, 0, 1])
    closeTo(getRgbaColor('rgba(0, 0, 255, 0.5)'), [0, 0, 1, 0.5])
    closeTo(getRgbaColor('rgb(255 0 0 / 0.25)'), [1, 0, 0, 0.25])
  })

  it('parses hsl()', () => {
    closeTo(getRgbaColor('hsl(0, 100%, 50%)'), [1, 0, 0, 1])
    closeTo(getRgbaColor('hsl(120, 100%, 50%)'), [0, 1, 0, 1])
  })

  it('passes RGBA tuples through unchanged', () => {
    closeTo(getRgbaColor([0.1, 0.2, 0.3, 0.4]), [0.1, 0.2, 0.3, 0.4])
  })

  it('treats transparent as fully clear', () => {
    closeTo(getRgbaColor('transparent'), [0, 0, 0, 0])
  })

  it('falls back to opaque black rather than throwing on nonsense', () => {
    closeTo(getRgbaColor('not-a-color'), [0, 0, 0, 1])
    closeTo(getRgbaColor('#12345'), [0, 0, 0, 1])
  })
})

describe('rgbToBrightness', () => {
  it('weights green most heavily, matching relative luminance', () => {
    expect(rgbToBrightness(0, 1, 0)).toBeGreaterThan(rgbToBrightness(1, 0, 0))
    expect(rgbToBrightness(1, 0, 0)).toBeGreaterThan(rgbToBrightness(0, 0, 1))
    expect(rgbToBrightness(1, 1, 1)).toBeCloseTo(1, 5)
  })
})
