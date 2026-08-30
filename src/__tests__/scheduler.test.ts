import { describe, it, expect, vi } from 'vitest'
import { createMockGL } from './mock-gl'
import { Graph } from '../core/graph'

/**
 * A settled graph: data applied, transition finished, nothing animating.
 *
 * `transitionDuration: 0` matters — a queued position transition is a real
 * reason to keep drawing, so a graph mid-transition is *supposed* to want
 * frames, and a fixture that left one running would be testing nothing.
 */
function makeGraph (config: ConstructorParameters<typeof Graph>[1] = {}): Graph {
  const { gl } = createMockGL()
  const graph = new Graph(gl, {
    fitViewOnInit: false, enableSimulation: false, transitionDuration: 0, ...config,
  })
  graph.setSize(800, 600)
  graph.setPointPositions(new Float32Array([100, 100, 200, 200]))
  return graph
}

/** Draws until the graph stops asking, or gives up. Returns whether it settled. */
function settle (graph: Graph, maxFrames = 8): boolean {
  for (let i = 0; i < maxFrames; i++) {
    graph.render([0, 0, 800, 600])
    if (!graph.needsFrame) return true
  }
  return false
}

describe('frame scheduling', () => {
  it('needs a frame while data is pending, and not once it is drawn', () => {
    const graph = makeGraph()
    expect(graph.needsFrame).toBe(true)
    expect(settle(graph)).toBe(true)
    graph.destroy()
  })

  it('keeps asking while the simulation runs', () => {
    // The one case where an identical-looking frame is still a new frame.
    const graph = makeGraph({ enableSimulation: true })
    settle(graph)
    graph.start(1)
    expect(graph.needsFrame).toBe(true)
    graph.stop()
    expect(settle(graph)).toBe(true)
    graph.destroy()
  })

  it('wakes on a view change', () => {
    const graph = makeGraph()
    expect(settle(graph)).toBe(true)
    graph.setZoomLevel(2, 0)
    expect(graph.needsFrame).toBe(true)
    graph.destroy()
  })

  it('wakes on new data', () => {
    const graph = makeGraph()
    settle(graph)
    graph.setPointColors(new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]))
    expect(graph.needsFrame).toBe(true)
    graph.destroy()
  })

  it('wakes on an explicit invalidate, for anything the engine cannot see', () => {
    const graph = makeGraph()
    expect(settle(graph)).toBe(true)
    graph.invalidate()
    expect(graph.needsFrame).toBe(true)
    graph.destroy()
  })

  it('tells a stopped host when it has gone dirty', () => {
    // Without this the host would have to poll for the change — which is the
    // loop it just stopped.
    const graph = makeGraph()
    const listener = vi.fn()
    const unsubscribe = graph.onInvalidate(listener)
    settle(graph)

    graph.invalidate()
    expect(listener).toHaveBeenCalled()

    unsubscribe()
    listener.mockClear()
    graph.invalidate()
    expect(listener).not.toHaveBeenCalled()
    graph.destroy()
  })
})

describe('view transform', () => {
  it('reports the current scale and translation', () => {
    const graph = makeGraph()
    graph.setZoomLevel(3, 0)
    expect(graph.getViewProjection().k).toBeCloseTo(3, 6)
    graph.destroy()
  })

  it('notifies listeners on every change, and stops on unsubscribe', () => {
    // The label layer's route to display-rate anchor updates without a
    // readback and without a React render.
    const graph = makeGraph()
    const listener = vi.fn()
    const unsubscribe = graph.onViewTransform(listener)

    graph.setZoomLevel(2, 0)
    expect(listener).toHaveBeenCalled()
    expect(listener.mock.calls[listener.mock.calls.length - 1]?.[0]).toMatchObject({ k: expect.any(Number) })

    unsubscribe()
    listener.mockClear()
    graph.setZoomLevel(4, 0)
    expect(listener).not.toHaveBeenCalled()
    graph.destroy()
  })
})

describe('viewport sampling', () => {
  it('returns nothing when there are no points', () => {
    const { gl } = createMockGL()
    const graph = new Graph(gl, { fitViewOnInit: false, enableSimulation: false })
    graph.setSize(800, 600)
    expect(graph.sampleVisiblePointIndices(125).size).toBe(0)
    graph.destroy()
  })

  it('reads the grid back without throwing', () => {
    // The mock context returns an empty buffer, so this asserts the pass runs
    // and decodes rather than what it finds; the grid rule itself is covered
    // by the label tests, which take candidates as input.
    const graph = makeGraph()
    settle(graph)
    expect(() => graph.sampleVisiblePointIndices(125)).not.toThrow()
    graph.destroy()
  })
})
