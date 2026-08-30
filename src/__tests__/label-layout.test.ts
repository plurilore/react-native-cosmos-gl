import { describe, it, expect } from 'vitest'
import { createLabelLayoutBuffers, layoutLabels } from '../labels/layout'
import { resolveCollisions } from '../labels'
import type { LabelBox } from '../labels'
import type { ViewProjection } from '../core/view-projection'

/** A view with no pan or zoom, so screen coordinates equal anchors. */
const identityView = (width = 800, height = 600): ViewProjection => ({
  k: 1, x: 0, y: 0, offsetX: 0, offsetY: 0, spaceSize: 0,
  screenWidth: width, screenHeight: height,
})

type Label = {
  x: number; y: number; width: number; height: number
  priority: number; forced?: boolean; previous?: boolean
}

function fill (labels: Label[]) {
  const buffers = createLabelLayoutBuffers(Math.max(1, labels.length))
  buffers.count = labels.length
  labels.forEach((label, i) => {
    // The view flips Y (`spaceSize - y`), so with spaceSize 0 an anchor of
    // `-y` projects to `+y`. That keeps the fixtures readable.
    buffers.anchors[i * 2] = label.x
    buffers.anchors[i * 2 + 1] = -label.y
    buffers.sizes[i * 2] = label.width
    buffers.sizes[i * 2 + 1] = label.height
    buffers.priorities[i] = label.priority
    buffers.forced[i] = label.forced ? 1 : 0
    buffers.previous[i] = label.previous ? 1 : 0
  })
  return buffers
}

const toBoxes = (labels: Label[]): LabelBox[] =>
  labels.map((label, i) => ({
    id: String(i), x: label.x, y: label.y, width: label.width, height: label.height,
    priority: label.priority, forceShow: Boolean(label.forced),
    previouslyVisible: Boolean(label.previous),
  }))

/** Both implementations, as a sorted list of surviving indices. */
function bothWays (labels: Label[], width = 800, height = 600) {
  const buffers = fill(labels)
  layoutLabels(buffers, identityView(width, height))
  const flat: number[] = []
  for (let i = 0; i < labels.length; i++) if (buffers.visible[i] === 1) flat.push(i)

  const objects = [...resolveCollisions(toBoxes(labels), { width, height })]
    .map(Number)
    .sort((a, b) => a - b)

  return { flat, objects }
}

const expectAgreement = (labels: Label[], width?: number, height?: number) => {
  const { flat, objects } = bothWays(labels, width, height)
  expect(flat).toEqual(objects)
  return flat
}

describe('layoutLabels agrees with resolveCollisions', () => {
  it('on labels that do not touch', () => {
    expectAgreement([
      { x: 100, y: 100, width: 60, height: 16, priority: 1 },
      { x: 400, y: 100, width: 60, height: 16, priority: 2 },
      { x: 700, y: 400, width: 60, height: 16, priority: 3 },
    ])
  })

  it('on an overlapping pair', () => {
    const survivors = expectAgreement([
      { x: 100, y: 100, width: 80, height: 16, priority: 1 },
      { x: 110, y: 100, width: 80, height: 16, priority: 9 },
    ])
    expect(survivors).toEqual([1])
  })

  it('on the last-frame tie-break', () => {
    const survivors = expectAgreement([
      { x: 100, y: 100, width: 80, height: 16, priority: 5 },
      { x: 110, y: 100, width: 80, height: 16, priority: 5, previous: true },
    ])
    expect(survivors).toEqual([1])
  })

  it('when a forced label loses to an ordinary one', () => {
    expectAgreement([
      { x: 100, y: 100, width: 80, height: 16, priority: 0, forced: true },
      { x: 110, y: 100, width: 80, height: 16, priority: 900 },
    ])
  })

  it('when two forced labels collide', () => {
    expectAgreement([
      { x: 100, y: 100, width: 80, height: 16, priority: 0, forced: true },
      { x: 110, y: 100, width: 80, height: 16, priority: 1e5, forced: true },
    ])
  })

  it('on labels outside the viewport', () => {
    expectAgreement([
      { x: -50, y: 100, width: 60, height: 16, priority: 1 },
      { x: 100, y: 900, width: 60, height: 16, priority: 1 },
      { x: 400, y: 300, width: 60, height: 16, priority: 1 },
    ])
  })

  it('on a crowded pile, where the sweep does the most work', () => {
    const crowded: Label[] = Array.from({ length: 30 }, (_, i) => ({
      x: 300 + (i % 5) * 12,
      y: 300 + Math.floor(i / 5) * 4,
      width: 90, height: 18, priority: i % 7,
      previous: i % 3 === 0,
    }));
    expectAgreement(crowded)
  })

  it('on vertically separated labels that share a column', () => {
    expectAgreement([
      { x: 200, y: 100, width: 80, height: 16, priority: 1 },
      { x: 200, y: 400, width: 80, height: 16, priority: 2 },
    ])
  })
})

describe('layoutLabels', () => {
  it('projects through the camera', () => {
    const buffers = fill([{ x: 0, y: 0, width: 10, height: 10, priority: 1 }])
    layoutLabels(buffers, { ...identityView(), k: 2, x: 30, y: 40 })
    expect(buffers.screen[0]).toBeCloseTo(30, 6)
    expect(buffers.screen[1]).toBeCloseTo(40, 6)
  })

  it('carries visibility into the next pass, so a tie stays resolved', () => {
    // The anti-flicker rule, but now the state lives in the buffer rather than
    // in the manager — the fast path has no object to hold it.
    const labels: Label[] = [
      { x: 100, y: 100, width: 80, height: 16, priority: 5 },
      { x: 110, y: 100, width: 80, height: 16, priority: 5 },
    ]
    const buffers = fill(labels)
    layoutLabels(buffers, identityView())
    const first = Array.from(buffers.visible)
    layoutLabels(buffers, identityView())
    expect(Array.from(buffers.visible)).toEqual(first)
  })

  it('allocates nothing per call', () => {
    // The reason this exists at all: it runs on the render thread every frame.
    const buffers = createLabelLayoutBuffers(64)
    buffers.count = 64
    for (let i = 0; i < 64; i++) {
      buffers.anchors[i * 2] = i * 9
      buffers.anchors[i * 2 + 1] = -(i * 3)
      buffers.sizes[i * 2] = 70
      buffers.sizes[i * 2 + 1] = 16
      buffers.priorities[i] = i
    }
    const before = { ...buffers }
    layoutLabels(buffers, identityView())
    // Same backing stores, written in place.
    expect(buffers.screen).toBe(before.screen)
    expect(buffers.visible).toBe(before.visible)
    expect(buffers.order).toBe(before.order)
  })

  it('ignores slots past the live count', () => {
    const buffers = createLabelLayoutBuffers(8)
    buffers.count = 2
    buffers.sizes.fill(20)
    layoutLabels(buffers, identityView())
    for (let i = 2; i < 8; i++) expect(buffers.visible[i]).toBe(0)
  })
})
