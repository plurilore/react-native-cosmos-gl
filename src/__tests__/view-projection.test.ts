import { describe, it, expect } from 'vitest'
import { createMockGL } from './mock-gl'
import { Graph } from '../core/graph'
import { projectViewPoint } from '../core/view-projection'

function makeGraph (width = 800, height = 600): Graph {
  const { gl } = createMockGL()
  const graph = new Graph(gl, {
    fitViewOnInit: false, enableSimulation: false, transitionDuration: 0,
  })
  graph.setSize(width, height)
  graph.setPointPositions(new Float32Array([100, 100, 3000, 2500]))
  graph.render([0, 0, width, height])
  return graph
}

const POINTS: [number, number][] = [
  [0, 0], [2048, 2048], [100, 3900], [3900, 100], [-500, 4500],
]

describe('projectViewPoint', () => {
  it('agrees with the engine at rest', () => {
    // The whole point of duplicating the formula is that a worklet cannot call
    // the engine. This is what stops the copy drifting from the original.
    const graph = makeGraph()
    const view = graph.getViewProjection()
    for (const [x, y] of POINTS) {
      const [engineX, engineY] = graph.spaceToScreenPosition([x, y])
      const [ownX, ownY] = projectViewPoint(view, x, y)
      expect(ownX).toBeCloseTo(engineX, 6)
      expect(ownY).toBeCloseTo(engineY, 6)
    }
    graph.destroy()
  })

  it('agrees after a zoom', () => {
    const graph = makeGraph()
    graph.setZoomLevel(3.7, 0)
    const view = graph.getViewProjection()
    for (const [x, y] of POINTS) {
      const [engineX, engineY] = graph.spaceToScreenPosition([x, y])
      const [ownX, ownY] = projectViewPoint(view, x, y)
      expect(ownX).toBeCloseTo(engineX, 6)
      expect(ownY).toBeCloseTo(engineY, 6)
    }
    graph.destroy()
  })

  it('agrees after a pan', () => {
    const graph = makeGraph()
    graph.centerOnSpacePosition([3000, 2500], 0)
    const view = graph.getViewProjection()
    for (const [x, y] of POINTS) {
      const [engineX, engineY] = graph.spaceToScreenPosition([x, y])
      const [ownX, ownY] = projectViewPoint(view, x, y)
      expect(ownX).toBeCloseTo(engineX, 6)
      expect(ownY).toBeCloseTo(engineY, 6)
    }
    graph.destroy()
  })

  it('agrees on a non-square viewport, where the two offsets differ', () => {
    const graph = makeGraph(1180, 320)
    const view = graph.getViewProjection()
    expect(view.offsetX).not.toBe(view.offsetY)
    for (const [x, y] of POINTS) {
      const [engineX, engineY] = graph.spaceToScreenPosition([x, y])
      const [ownX, ownY] = projectViewPoint(view, x, y)
      expect(ownX).toBeCloseTo(engineX, 6)
      expect(ownY).toBeCloseTo(engineY, 6)
    }
    graph.destroy()
  })

  it('inverts Y, so a point higher in the space is higher on the screen', () => {
    const graph = makeGraph()
    const view = graph.getViewProjection()
    const [, low] = projectViewPoint(view, 0, 100)
    const [, high] = projectViewPoint(view, 0, 3000)
    expect(high).toBeLessThan(low)
    graph.destroy()
  })

  it('reports the viewport, so a caller can cull without asking again', () => {
    const graph = makeGraph(1180, 320)
    const view = graph.getViewProjection()
    expect(view.screenWidth).toBe(1180)
    expect(view.screenHeight).toBe(320)
    graph.destroy()
  })
})
