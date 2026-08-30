import { describe, it, expect } from 'vitest'
import { createLabelLayoutBuffers } from '../labels'

// Packing now lives in `packLabels` and is tested directly; what remains here
// is the buffer shape the atlas draws from.

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
