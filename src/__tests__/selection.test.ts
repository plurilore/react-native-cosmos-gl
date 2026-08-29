import { describe, it, expect } from 'vitest'
import { Selection } from '../data/selection'
import { createMockGL } from './mock-gl'
import { Graph } from '../core/graph'

/**
 * A path graph 0—1—2—3, so neighbour expansion has an unambiguous answer at
 * every point and link containment can be checked exactly.
 */
function makePathGraph (): Graph {
  const { gl } = createMockGL()
  const graph = new Graph(gl, { enableSimulation: false })
  graph.setSize(400, 400)
  graph.setPointPositions(new Float32Array([0, 0, 10, 0, 20, 0, 30, 0]))
  graph.setLinks(new Float32Array([0, 1, 1, 2, 2, 3]))
  graph.render([0, 0, 400, 400])
  return graph
}

describe('Selection', () => {
  it('distinguishes no selection from an empty one', () => {
    // Nothing selected shows everything at full strength; an empty selection
    // greys the whole graph out. Collapsing the two would make a filter that
    // matches nothing look like no filter at all.
    const selection = new Selection()
    expect(selection.hasSelection).toBe(false)
    expect(selection.toConfig()).toEqual({})

    const graph = makePathGraph()
    selection.selectPoints(graph, [])
    expect(selection.hasSelection).toBe(true)
    expect(selection.toConfig().highlightedPointIndices).toEqual([])
    graph.destroy()
  })

  it('expands a selection to neighbours when asked', () => {
    const graph = makePathGraph()
    const selection = new Selection()
    selection.selectPoints(graph, [1], { includeNeighbors: true })
    expect(selection.pointIndices?.sort()).toEqual([0, 1, 2])
    graph.destroy()
  })

  it('highlights only links with both ends selected', () => {
    // A link with one end outside the selection is not part of what was
    // selected, and highlighting it would draw attention out of the subgraph.
    const graph = makePathGraph()
    const selection = new Selection()
    selection.selectPoints(graph, [0, 1])
    expect(selection.linkIndices).toEqual([0])
    graph.destroy()
  })

  it('adds to an existing selection when additive', () => {
    const graph = makePathGraph()
    const selection = new Selection()
    selection.selectPoints(graph, [0])
    selection.selectPoints(graph, [3], { additive: true })
    expect(selection.pointIndices?.sort()).toEqual([0, 3])
    // 0 and 3 are not adjacent, so no link is fully contained.
    expect(selection.linkIndices).toEqual([])
    graph.destroy()
  })

  it('replaces rather than accumulates by default', () => {
    const graph = makePathGraph()
    const selection = new Selection()
    selection.selectPoints(graph, [0])
    selection.selectPoints(graph, [3])
    expect(selection.pointIndices).toEqual([3])
    graph.destroy()
  })

  it('selects a link and pulls in its endpoints', () => {
    const graph = makePathGraph()
    const selection = new Selection()
    selection.selectLinks(graph, [1])
    expect(selection.linkIndices).toEqual([1])
    expect(selection.pointIndices?.sort()).toEqual([1, 2])
    graph.destroy()
  })

  it('returns to no selection when cleared', () => {
    const graph = makePathGraph()
    const selection = new Selection()
    selection.selectPoints(graph, [0, 1])
    selection.clear()
    expect(selection.hasSelection).toBe(false)
    expect(selection.toConfig()).toEqual({})
    graph.destroy()
  })

  it('can skip link highlighting', () => {
    const graph = makePathGraph()
    const selection = new Selection()
    selection.selectPoints(graph, [0, 1], { includeLinks: false })
    expect(selection.linkIndices).toBeUndefined()
    graph.destroy()
  })
})
