import { describe, it, expect } from 'vitest'
import {
  createLabelLayoutBuffers,
  fillBuffers,
  labelAtlasMetrics,
  layoutLabels,
  type MeasuredLabel,
} from '../labels'
import type { ViewProjection } from '../core/view-projection'

/**
 * Where the two coordinate systems meet.
 *
 * The atlas is baked in physical pixels; projection and collision work in the
 * logical points `ViewProjection` reports. Carrying a physical size into a
 * collision box inflates it by the device ratio — on a 3x screen every label
 * claims nine times its area and almost all of them disappear, silently and
 * only on a dense device.
 */

const metricsAt = (pixelRatio: number) =>
  labelAtlasMetrics({ fontSize: 12, padding: [5, 3, 5, 3], margin: 7, pixelRatio })

const label = (
  index: number,
  position: [number, number],
  width: number,
  height: number
): MeasuredLabel => ({
  id: `p${index}`, index, kind: 'top', text: `p${index}`,
  position, priority: 1, forceShow: false, width, height,
})

const noAnchors = new Map<number, [number, number]>()

describe('fillBuffers', () => {
  it('converts a physical measurement to the logical box the layout collides', () => {
    const metrics = metricsAt(3)
    const buffers = createLabelLayoutBuffers(4)
    // A label measured at 3x: 180 physical px is 60 logical points.
    fillBuffers(buffers, [label(0, [10, 20], 180, 54)], noAnchors, noAnchors, undefined, metrics)
    expect(buffers.sizes[0]).toBeCloseTo(60, 5)
    // Height carries the margin, also converted.
    expect(buffers.sizes[1]).toBeCloseTo(54 / 3 + metrics.margin / 3, 5)
  })

  it('gives the same logical box whatever the device ratio', () => {
    // The identity that makes this correct: a 12dp label is a 12dp label, and
    // the collision result must not depend on the screen it is measured on.
    const boxes = [1, 2, 3].map((pixelRatio) => {
      const metrics = metricsAt(pixelRatio)
      const buffers = createLabelLayoutBuffers(4)
      fillBuffers(
        buffers,
        [label(0, [0, 0], 60 * pixelRatio, metrics.lineHeight)],
        noAnchors, noAnchors, undefined, metrics
      )
      return [buffers.sizes[0], buffers.sizes[1]]
    })
    expect(boxes[1]?.[0]).toBeCloseTo(boxes[0]?.[0] as number, 4)
    expect(boxes[2]?.[0]).toBeCloseTo(boxes[0]?.[0] as number, 4)
    expect(boxes[1]?.[1]).toBeCloseTo(boxes[0]?.[1] as number, 0)
    expect(boxes[2]?.[1]).toBeCloseTo(boxes[0]?.[1] as number, 0)
  })

  it('hides the same labels on a 3x screen as on a 1x one', () => {
    // The symptom the conversion prevents, stated as behaviour: a dense screen
    // must not lose labels a coarse one keeps.
    const view: ViewProjection = {
      k: 1, x: 0, y: 0, offsetX: 0, offsetY: 0,
      spaceSize: 1000, screenWidth: 400, screenHeight: 800,
    }
    const visibleAt = (pixelRatio: number) => {
      const metrics = metricsAt(pixelRatio)
      const buffers = createLabelLayoutBuffers(8)
      const labels = [0, 1, 2, 3].map((i) =>
        label(i, [40 + i * 70, 500], 60 * pixelRatio, metrics.lineHeight)
      )
      fillBuffers(buffers, labels, noAnchors, noAnchors, undefined, metrics)
      layoutLabels(buffers, view)
      return Array.from(buffers.visible.slice(0, labels.length))
    }
    expect(visibleAt(3)).toEqual(visibleAt(1))
  })

  it('prefers a live anchor over the position the label was selected at', () => {
    const buffers = createLabelLayoutBuffers(4)
    const anchors = new Map<number, [number, number]>([[7, [99, 88]]])
    fillBuffers(
      buffers, [label(7, [1, 2], 60, 20)], anchors, noAnchors, undefined, metricsAt(1)
    )
    expect([buffers.anchors[0], buffers.anchors[1]]).toEqual([99, 88])
  })

  it('falls back to a sampled position, then to the label’s own', () => {
    const buffers = createLabelLayoutBuffers(4)
    const sampled = new Map<number, [number, number]>([[7, [5, 6]]])
    fillBuffers(
      buffers, [label(7, [1, 2], 60, 20)], noAnchors, sampled, undefined, metricsAt(1)
    )
    expect([buffers.anchors[0], buffers.anchors[1]]).toEqual([5, 6])

    const alone = createLabelLayoutBuffers(4)
    fillBuffers(alone, [label(7, [1, 2], 60, 20)], noAnchors, noAnchors, undefined, metricsAt(1))
    expect([alone.anchors[0], alone.anchors[1]]).toEqual([1, 2])
  })

  it('reads a cluster centroid from the cluster list', () => {
    const buffers = createLabelLayoutBuffers(4)
    const cluster: MeasuredLabel = { ...label(2, [0, 0], 60, 20), kind: 'cluster' }
    fillBuffers(
      buffers, [cluster], noAnchors, noAnchors, [{ index: 2, position: [77, 66] }], metricsAt(1)
    )
    expect([buffers.anchors[0], buffers.anchors[1]]).toEqual([77, 66])
  })

  it('parks every slot past the live count', () => {
    const buffers = createLabelLayoutBuffers(6)
    buffers.visible.fill(1)
    fillBuffers(buffers, [label(0, [0, 0], 60, 20)], noAnchors, noAnchors, undefined, metricsAt(1))
    expect(buffers.count).toBe(1)
    expect(Array.from(buffers.visible.slice(1))).toEqual([0, 0, 0, 0, 0])
  })
})
