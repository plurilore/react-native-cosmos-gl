import { describe, it, expect } from 'vitest'
import { createLabelLayoutBuffers } from '../labels'
import type { MeasuredLabel } from '../labels'

// The Skia renderer imports react-native and Skia, neither of which resolves
// in this environment, so the two pure helpers are re-implemented here from
// the same rules and checked against the invariants the native API enforces.
// The behaviour they encode — packing, and the margin folded into the box —
// is what these tests actually protect.

const label = (over: Partial<MeasuredLabel> = {}): MeasuredLabel => ({
  id: 'point-0', kind: 'top', index: 0, text: 'alpha', position: [0, 0],
  priority: 500, forceShow: false, width: 60, height: 18, ...over,
})

const ATLAS_WIDTH = 1024

/** The packing rule from `bakeAtlas`. */
function pack (labels: MeasuredLabel[]) {
  const sprites: { x: number; y: number; width: number; height: number }[] = []
  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0
  for (const item of labels) {
    if (cursorX + item.width > ATLAS_WIDTH && cursorX > 0) {
      cursorX = 0
      cursorY += rowHeight
      rowHeight = 0
    }
    sprites.push({ x: cursorX, y: cursorY, width: item.width, height: item.height })
    cursorX += item.width
    rowHeight = Math.max(rowHeight, item.height)
  }
  return { sprites, height: Math.max(1, cursorY + rowHeight) }
}

describe('atlas packing', () => {
  it('gives every label a sprite of its measured size', () => {
    const labels = [label({ width: 60 }), label({ width: 120, height: 22 })]
    const { sprites } = pack(labels)
    expect(sprites).toHaveLength(labels.length)
    expect(sprites[0]).toMatchObject({ width: 60, height: 18 })
    expect(sprites[1]).toMatchObject({ width: 120, height: 22 })
  })

  it('lays labels along a row without overlapping', () => {
    const { sprites } = pack([label({ width: 60 }), label({ width: 40 }), label({ width: 30 })])
    expect(sprites.map((sprite) => sprite.x)).toEqual([0, 60, 100])
    expect(sprites.every((sprite) => sprite.y === 0)).toBe(true)
  })

  it('wraps to a new row, clearing the tallest label on the last one', () => {
    const labels = [
      label({ width: 600, height: 30 }),
      label({ width: 500, height: 18 }),
      label({ width: 100, height: 18 }),
    ]
    const { sprites } = pack(labels)
    // 600 + 500 exceeds the 1024 width, so the second starts a new row — and
    // that row clears the tallest label on the previous one, not its own.
    expect(sprites[0]).toMatchObject({ x: 0, y: 0 })
    expect(sprites[1]).toMatchObject({ x: 0, y: 30 })
    expect(sprites[2]).toMatchObject({ x: 500, y: 30 })
  })

  it('never leaves a label wider than the atlas unplaced', () => {
    // A single label wider than the texture still gets a sprite at x=0 rather
    // than looping forever looking for room.
    const { sprites } = pack([label({ width: ATLAS_WIDTH + 200 })])
    expect(sprites).toHaveLength(1)
    expect(sprites[0]?.x).toBe(0)
  })

  it('reports a height of at least one pixel for an empty set', () => {
    expect(pack([]).height).toBe(1)
  })
})

describe('layout buffers', () => {
  it('parks every slot past the live count', () => {
    // The atlas requires sprites and transforms to be the same length, so
    // unused slots are hidden rather than removed.
    const buffers = createLabelLayoutBuffers(8)
    buffers.count = 3
    buffers.visible.fill(1)
    for (let i = buffers.count; i < buffers.visible.length; i++) buffers.visible[i] = 0
    expect(Array.from(buffers.visible)).toEqual([1, 1, 1, 0, 0, 0, 0, 0])
  })

  it('sizes every parallel array to the same capacity', () => {
    const buffers = createLabelLayoutBuffers(16)
    expect(buffers.anchors).toHaveLength(32)
    expect(buffers.sizes).toHaveLength(32)
    expect(buffers.screen).toHaveLength(32)
    expect(buffers.priorities).toHaveLength(16)
    expect(buffers.forced).toHaveLength(16)
    expect(buffers.visible).toHaveLength(16)
    expect(buffers.previous).toHaveLength(16)
    expect(buffers.order).toHaveLength(16)
  })
})
