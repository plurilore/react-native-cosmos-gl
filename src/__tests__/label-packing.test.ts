import { describe, it, expect } from 'vitest'
import { packLabels } from '../labels'

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

  it('keeps every slot inside the atlas width', () => {
    const labels = Array.from({ length: 60 }, (_, i) => size(40 + (i % 7) * 30))
    const { sprites } = packLabels(labels, CAPACITY, WIDTH)
    for (const sprite of sprites.slice(0, labels.length)) {
      expect(sprite.x).toBeGreaterThanOrEqual(0)
      expect(sprite.x + sprite.width).toBeLessThanOrEqual(WIDTH)
    }
  })
})
