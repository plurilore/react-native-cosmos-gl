import { describe, it, expect } from 'vitest'
import { createMockGL } from './mock-gl'
import { Graph } from '../core/graph'

/**
 * A graph whose GPU position readback returns exactly `positions`.
 *
 * The camera reads point positions back from the position texture, so without
 * feeding the mock's `readPixels` every fit would see the origin and the tests
 * would pass on a graph that is not there.
 */
function makeGraph (
  positions: Float32Array,
  config: ConstructorParameters<typeof Graph>[1] = {}
): Graph {
  const { gl } = createMockGL({
    readPixels: (out) => {
      if (!(out instanceof Float32Array)) return
      out.fill(0)
      // The texture is RGBA and square; `getPointPositions` reads x and y from
      // the first two channels of texel i.
      for (let i = 0; i < positions.length / 2; i++) {
        if (i * 4 + 1 >= out.length) break
        out[i * 4] = positions[i * 2] as number
        out[i * 4 + 1] = positions[i * 2 + 1] as number
      }
    },
  })
  const graph = new Graph(gl, { enableSimulation: false, fitViewOnInit: false, ...config })
  graph.setSize(800, 600)
  graph.setPointPositions(positions)
  // One frame applies the pending data update, which is what sizes the position
  // texture — a fit issued before it has nothing to read.
  graph.render([0, 0, 800, 600])
  return graph
}

describe('camera', () => {
  it('caps how far a fit may zoom in', () => {
    // Fitting a *single* point is the case that motivated bounds: its extent is
    // zero on both axes, is widened to one space unit, and the fitted scale
    // lands in the hundreds — legal, unreadable, and hard to undo by hand.
    const graph = makeGraph(new Float32Array([2048, 2048, 2100, 2100]))

    graph.fitViewByPointIndices([0], 0, 0.34)
    const unbounded = graph.getZoomLevel()
    expect(unbounded).toBeGreaterThan(50)

    graph.fitViewByPointIndices([0], 0, 0.34, { maxScale: 4 })
    expect(graph.getZoomLevel()).toBe(4)
    graph.destroy()
  })

  it('raises a fit that would land below the floor', () => {
    const graph = makeGraph(new Float32Array([0, 0, 4000, 4000]))
    graph.fitViewByPointIndices([0, 1], 0, 0.1, { minScale: 2 })
    expect(graph.getZoomLevel()).toBe(2)
    graph.destroy()
  })

  it('keeps the fitted points centred when a bound changes the scale', () => {
    const graph = makeGraph(new Float32Array([1000, 1000, 3000, 3000]))
    graph.fitViewByPointIndices([0, 1], 0, 0.1, { maxScale: 0.05 })
    const [x, y] = graph.spaceToScreenPosition([2000, 2000])
    expect(x).toBeCloseTo(400, 3)
    expect(y).toBeCloseTo(300, 3)
    graph.destroy()
  })

  it('reports that it did not move when no index exists yet', () => {
    // The normal case immediately after adding points: the position texture is
    // resized on the next data update, so a fit issued in the same tick as the
    // data has nothing to read. Silently doing nothing looked like a camera bug
    // for as long as the caller could not tell the two apart.
    const graph = makeGraph(new Float32Array([2048, 2048]))
    const before = graph.getZoomLevel()

    expect(graph.fitViewByPointIndices([7], 0)).toBe(false)
    expect(graph.getZoomLevel()).toBe(before)
    expect(graph.fitViewByPointIndices([0], 0)).toBe(true)
    graph.destroy()
  })

  it('centres a point without changing the zoom level', () => {
    const graph = makeGraph(new Float32Array([1000, 1000, 3000, 3000]))
    graph.setZoomLevel(2.5, 0)

    expect(graph.centerOnPointIndex(1, 0)).toBe(true)
    expect(graph.getZoomLevel()).toBe(2.5)
    const [x, y] = graph.spaceToScreenPosition([3000, 3000])
    expect(x).toBeCloseTo(400, 3)
    expect(y).toBeCloseTo(300, 3)
    graph.destroy()
  })

  it('refuses to centre on a point that does not exist', () => {
    const graph = makeGraph(new Float32Array([2048, 2048]))
    expect(graph.centerOnPointIndex(4, 0)).toBe(false)
    expect(graph.centerOnPointIndex(-1, 0)).toBe(false)
    graph.destroy()
  })

  it('honours a configured scale extent on every path into the view', () => {
    const graph = makeGraph(new Float32Array([2048, 2048, 2100, 2100]), {
      scaleExtent: [0.05, 3],
    })

    graph.fitViewByPointIndices([0], 0, 0.34)
    expect(graph.getZoomLevel()).toBeLessThanOrEqual(3)

    graph.setZoomLevel(50, 0)
    expect(graph.getZoomLevel()).toBe(3)

    graph.setZoomLevel(0.0001, 0)
    expect(graph.getZoomLevel()).toBe(0.05)
    graph.destroy()
  })

  it('restarts the simulation at the alpha it is given', () => {
    // What lets a host add a node's neighbours without re-annealing the layout
    // every other node is already settled into.
    const graph = makeGraph(new Float32Array([2048, 2048]), { enableSimulation: true })
    graph.start(0.25)
    expect(graph.store.alpha).toBeCloseTo(0.25, 6)
    graph.start()
    expect(graph.store.alpha).toBe(1)
    graph.destroy()
  })
})
