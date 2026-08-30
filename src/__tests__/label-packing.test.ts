import { describe, it, expect } from 'vitest'
import { packLabels, DEFAULT_MAX_HEIGHT } from '../labels'

const size = (width: number, height = 18) => ({ width, height })
const CAPACITY = 160
const WIDTH = 1024

describe('packLabels', () => {
  it('always returns exactly the pool size, whatever the label count', () => {
    // The invariant the native atlas enforces: it throws when the sprite and
    // transform arrays differ in length, on every commit, and React commits
    // again — so getting this wrong is an infinite crash loop rather than a
    // wrong picture. The transform buffer is a fixed pool, so this must be too.
    for (const count of [0, 1, 7, 47, CAPACITY - 1, CAPACITY]) {
      const labels = Array.from({ length: count }, () => size(60))
      expect(packLabels(labels, CAPACITY, WIDTH).sprites).toHaveLength(CAPACITY)
    }
  })

  it('never returns more than the pool, even given more labels', () => {
    const labels = Array.from({ length: CAPACITY + 40 }, () => size(60))
    expect(packLabels(labels, CAPACITY, WIDTH).sprites).toHaveLength(CAPACITY)
  })

  it('pads the tail with rects that draw nothing', () => {
    const { sprites } = packLabels([size(60), size(40)], 5, WIDTH)
    expect(sprites.slice(2)).toEqual([
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: 0, height: 0 },
    ])
  })

  it('gives each label a slot of its measured size', () => {
    const { sprites } = packLabels([size(60, 18), size(120, 22)], 4, WIDTH)
    expect(sprites[0]).toMatchObject({ width: 60, height: 18 })
    expect(sprites[1]).toMatchObject({ width: 120, height: 22 })
  })

  it('lays a row out left to right without overlapping', () => {
    const { sprites } = packLabels([size(60), size(40), size(30)], 8, WIDTH)
    expect(sprites.slice(0, 3).map((sprite) => sprite.x)).toEqual([0, 60, 100])
    expect(sprites.slice(0, 3).every((sprite) => sprite.y === 0)).toBe(true)
  })

  it('wraps to a new row that clears the tallest label on the previous one', () => {
    const { sprites, height } = packLabels(
      [size(600, 30), size(500, 18), size(100, 18)],
      8,
      WIDTH
    )
    expect(sprites[0]).toMatchObject({ x: 0, y: 0 })
    expect(sprites[1]).toMatchObject({ x: 0, y: 30 })
    expect(sprites[2]).toMatchObject({ x: 500, y: 30 })
    expect(height).toBe(48)
  })

  it('places a label wider than the atlas rather than looping', () => {
    const { sprites } = packLabels([size(WIDTH + 200)], 4, WIDTH)
    expect(sprites[0]).toMatchObject({ x: 0, y: 0 })
  })

  it('reports at least one pixel of height when there is nothing to draw', () => {
    expect(packLabels([], CAPACITY, WIDTH).height).toBe(1)
  })

  it('rounds a fractional measurement up to whole pixels', () => {
    // A sprite whose origin or size lands on a half pixel is resampled even
    // when the atlas is drawn at exactly 1:1 — the blur the physical-pixel
    // layout exists to remove.
    const { sprites } = packLabels([size(60.4, 18.2), size(40.9, 18.2)], 4, WIDTH)
    expect(sprites[0]).toMatchObject({ x: 0, y: 0, width: 61, height: 19 })
    expect(sprites[1]).toMatchObject({ x: 61, y: 0, width: 41, height: 19 })
  })

  it('keeps every slot inside the atlas width', () => {
    const labels = Array.from({ length: 60 }, (_, i) => size(40 + (i % 7) * 30))
    const { sprites } = packLabels(labels, CAPACITY, WIDTH)
    for (const sprite of sprites.slice(0, labels.length)) {
      expect(sprite.x).toBeGreaterThanOrEqual(0)
      expect(sprite.x + sprite.width).toBeLessThanOrEqual(WIDTH)
    }
  })
})

describe('packLabels — the height budget', () => {
  // The texture is a real GPU allocation and the library asserts it is
  // non-null, so an atlas that outgrows the device's limit is a null
  // dereference rather than a missing label. On a 3× screen every sprite is
  // three times the size it used to be, which is what made this reachable.

  it('stops before the budget rather than growing without bound', () => {
    const labels = Array.from({ length: 100 }, () => size(WIDTH, 40))
    const { height, placed } = packLabels(labels, 160, WIDTH, 200)
    expect(height).toBeLessThanOrEqual(200)
    expect(placed).toBe(5)
  })

  it('reports how many labels actually got a slot', () => {
    const labels = Array.from({ length: 8 }, () => size(WIDTH, 30))
    expect(packLabels(labels, 160, WIDTH, 90).placed).toBe(3)
  })

  it('still pads to the pool when it drops the overflow', () => {
    // Dropping a label must not shorten the sprite array: the native atlas
    // throws when it and the transform pool differ in length.
    const labels = Array.from({ length: 100 }, () => size(WIDTH, 40))
    const { sprites } = packLabels(labels, CAPACITY, WIDTH, 200)
    expect(sprites).toHaveLength(CAPACITY)
  })

  it('draws nothing for the labels it dropped', () => {
    const labels = Array.from({ length: 10 }, () => size(WIDTH, 40))
    const { sprites, placed } = packLabels(labels, CAPACITY, WIDTH, 120)
    for (const sprite of sprites.slice(placed)) {
      expect(sprite).toMatchObject({ width: 0, height: 0 })
    }
  })

  it('fits a realistic 3x drilldown well inside the budget', () => {
    // 160 labels of about ten characters at a 12dp font on a 3x screen — the
    // densest thing the renderer can be asked for. If this needed the budget,
    // the budget would be the wrong shape.
    const labels = Array.from({ length: 160 }, () => size(210, 57))
    const { placed, height } = packLabels(labels, 160, 2048)
    expect(placed).toBe(160)
    expect(height).toBeLessThan(DEFAULT_MAX_HEIGHT)
  })

  it('leaves room on the tallest atlas any device asks for', () => {
    // 2048 square is half the 4096 texture limit of the oldest GPU likely to
    // run this, so a full atlas is always allocatable.
    expect(DEFAULT_MAX_HEIGHT).toBeLessThanOrEqual(2048)
  })
})
