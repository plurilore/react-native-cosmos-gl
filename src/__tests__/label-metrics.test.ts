import { describe, it, expect } from 'vitest'
import { labelAtlasMetrics, labelSpriteTransform, snapToPixel } from '../labels'

/**
 * The crispness contract.
 *
 * Labels are baked into an offscreen texture, and an offscreen Skia surface
 * draws under an identity transform while a `<Canvas>` scales playback by the
 * device pixel ratio first. So a font baked at a logical size is rasterized at
 * a fraction of the resolution it is shown at, and the atlas can only upscale
 * it — the blur that these numbers exist to prevent.
 *
 * The identity being asserted is: bake at `ratio`, draw at `1 / ratio`, net
 * scale one, texel on device pixel.
 */

const LOGICAL = { fontSize: 12, padding: [5, 3, 5, 3] as const, margin: 7 }

describe('labelAtlasMetrics', () => {
  it('leaves the typography alone at a ratio of one', () => {
    const metrics = labelAtlasMetrics({ ...LOGICAL, pixelRatio: 1 })
    expect(metrics.fontSize).toBe(12)
    expect(metrics.padding).toEqual([5, 3, 5, 3])
    expect(metrics.margin).toBe(7)
  })

  it('scales every dimension by the device ratio', () => {
    const one = labelAtlasMetrics({ ...LOGICAL, pixelRatio: 1 })
    const three = labelAtlasMetrics({ ...LOGICAL, pixelRatio: 3 })
    expect(three.fontSize).toBe(one.fontSize * 3)
    expect(three.padding).toEqual(one.padding.map((value) => value * 3))
    expect(three.margin).toBe(one.margin * 3)
    // The baseline is a rounded fraction of the em box, so it tracks the font
    // rather than landing exactly on 3× a rounded value.
    expect(three.baseline).toBeCloseTo(one.baseline * 3, 0)
  })

  it('reports integers for everything that becomes a coordinate', () => {
    // A padding or baseline left on a fraction puts a glyph origin between
    // device pixels, which resamples it — the same blur by another route.
    for (const pixelRatio of [1, 1.5, 2, 2.75, 3]) {
      const metrics = labelAtlasMetrics({ ...LOGICAL, pixelRatio })
      for (const value of [...metrics.padding, metrics.baseline, metrics.lineHeight, metrics.margin, metrics.radius]) {
        expect(Number.isInteger(value)).toBe(true)
      }
    }
  })

  it('keeps the baseline inside the chip it is drawn in', () => {
    for (const pixelRatio of [1, 2, 3]) {
      const metrics = labelAtlasMetrics({ ...LOGICAL, pixelRatio })
      expect(metrics.baseline).toBeGreaterThan(metrics.padding[1])
      expect(metrics.baseline).toBeLessThanOrEqual(metrics.lineHeight)
    }
  })

  it('records the ratio it was derived with', () => {
    expect(labelAtlasMetrics({ ...LOGICAL, pixelRatio: 2.625 }).pixelRatio).toBe(2.625)
  })

  it('falls back to one rather than dividing by zero', () => {
    const metrics = labelAtlasMetrics({ ...LOGICAL, pixelRatio: 0 })
    expect(metrics.pixelRatio).toBe(1)
    expect(metrics.fontSize).toBe(12)
  })
})

describe('snapToPixel', () => {
  it('lands on a whole physical pixel', () => {
    for (const pixelRatio of [1, 2, 3]) {
      for (const logical of [0, 10.4, -3.27, 118.9]) {
        const snapped = snapToPixel(logical, pixelRatio)
        expect(Number.isInteger(snapped * pixelRatio)).toBe(true)
      }
    }
  })

  it('moves by less than one physical pixel', () => {
    const snapped = snapToPixel(10.4, 3)
    expect(Math.abs(snapped - 10.4)).toBeLessThan(1 / 3)
  })
})

describe('labelSpriteTransform', () => {
  it('draws the sprite back down by exactly the ratio it was baked at', () => {
    // The identity that makes the text sharp: net scale of one.
    for (const pixelRatio of [1, 2, 3]) {
      const { scale } = labelSpriteTransform(100, 100, 60, 25, pixelRatio)
      expect(scale).toBe(1 / pixelRatio)
      expect(scale * pixelRatio).toBe(1)
    }
  })

  it('covers the logical size the layout collided against', () => {
    // A sprite of `w` physical pixels drawn at `1 / ratio` covers `w / ratio`
    // logical points — which is what the collision boxes were measured in.
    const pixelRatio = 3
    const physicalWidth = 180
    const logicalWidth = physicalWidth / pixelRatio
    const { scale, tx } = labelSpriteTransform(200, 300, logicalWidth, 25, pixelRatio)
    expect(physicalWidth * scale).toBe(logicalWidth)
    // Centred on the anchor, to within the snap.
    expect(tx + logicalWidth / 2).toBeCloseTo(200, 1)
  })

  it('snaps the destination to the physical grid', () => {
    // `tx`/`ty` are destination units and are not multiplied by the scale, so
    // they must be snapped rather than divided a second time.
    const pixelRatio = 3
    const { tx, ty } = labelSpriteTransform(120.37, 88.91, 61, 25.5, pixelRatio)
    expect(Number.isInteger(tx * pixelRatio)).toBe(true)
    expect(Number.isInteger(ty * pixelRatio)).toBe(true)
  })

  it('sits the label above the point it names, clear by the margin', () => {
    // `height` carries the margin, so the sprite's own bottom lands short of
    // the anchor rather than on it.
    const { ty } = labelSpriteTransform(50, 200, 60, 25, 1)
    expect(ty).toBe(175)
  })

  it('does not divide by a ratio of zero', () => {
    const { scale, tx } = labelSpriteTransform(10, 10, 4, 4, 0)
    expect(scale).toBe(1)
    expect(Number.isFinite(tx)).toBe(true)
  })
})
