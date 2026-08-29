import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockGL } from './mock-gl'
import { Graph } from '../core/graph'
import { Program } from '../gl/program'
import { PICKING_WINDOW_SIZE } from '../core/modules/picking-utils'

function instrumentUniformMisses (): { misses: string[]; restore: () => void } {
  const misses: string[] = []
  const original = Program.prototype.setUniform
  Program.prototype.setUniform = function patched (name, value) {
    if (!this.hasUniform(name)) misses.push(`${this.id}.${name}`)
    return original.call(this, name, value)
  }
  return { misses, restore: () => { Program.prototype.setUniform = original } }
}

function makeGraph (
  gl: WebGL2RenderingContext,
  config: Record<string, unknown> = {}
): Graph {
  const graph = new Graph(gl, { enableSimulation: false, ...config })
  graph.setSize(400, 400)
  graph.setPointPositions(new Float32Array([100, 100, 300, 100, 300, 300]))
  graph.setLinks(new Float32Array([0, 1, 1, 2, 2, 0]))
  graph.render([0, 0, 400, 400])
  return graph
}

/**
 * Stops the point picker finding anything.
 *
 * Both pickers read through the same mock `readPixels`, and they disagree about
 * what "empty" looks like — points use index `-1`, links use alpha `0` — so one
 * buffer of bytes cannot say "no point here, but link 2 is". Dispatch tests
 * therefore silence the point picker directly, which also keeps each test on
 * one behaviour: the routing, not the picking.
 */
function withoutPoints (graph: Graph): Graph {
  graph.findPointOnScreen = () => undefined
  return graph
}

/** Writes one link index across the whole readback window. */
function fillWith (linkIndex: number, hit = 1): (out: ArrayBufferView) => void {
  return (out) => {
    const pixels = out as Float32Array
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = linkIndex
      pixels[i + 3] = hit
    }
  }
}

describe('link picking', () => {
  let instrument: ReturnType<typeof instrumentUniformMisses>

  beforeEach(() => {
    instrument = instrumentUniformMisses()
    vi.useFakeTimers()
  })
  afterEach(() => {
    instrument.restore()
    vi.useRealTimers()
  })

  it('builds no index buffer when nothing listens for links', () => {
    // The pass costs a draw over every link; a graph nobody picks links on
    // must not pay for it.
    const { gl, record } = createMockGL()
    const graph = makeGraph(gl)
    expect(graph.findLinkOnScreen(200, 200)).toBeUndefined()
    expect(record.readPixelCalls).toHaveLength(0)
    graph.destroy()
  })

  it('picks a link once a callback is configured', () => {
    const { gl, record } = createMockGL({ readPixels: fillWith(2) })
    const graph = makeGraph(gl, { onLinkClick: () => undefined })
    expect(graph.findLinkOnScreen(200, 200)).toBe(2)
    expect(instrument.misses).toEqual([])
    // A fixed-size window regardless of graph size — that is what keeps the
    // readback affordable.
    expect(record.readPixelCalls[0]).toMatchObject({
      width: PICKING_WINDOW_SIZE,
      height: PICKING_WINDOW_SIZE,
    })
    graph.destroy()
  })

  it('treats alpha, not the index, as occupancy', () => {
    // Link 0 must stay pickable. If occupancy were inferred from the index
    // being non-zero, the first link in the data would be unselectable and
    // every empty pixel would report it.
    const { gl } = createMockGL({ readPixels: fillWith(0, 1) })
    const graph = makeGraph(gl, { onLinkClick: () => undefined })
    expect(graph.findLinkOnScreen(200, 200)).toBe(0)
    graph.destroy()
  })

  it('reports nothing where no link was drawn', () => {
    const { gl } = createMockGL({ readPixels: fillWith(0, 0) })
    const graph = makeGraph(gl, { onLinkClick: () => undefined })
    expect(graph.findLinkOnScreen(200, 200)).toBeUndefined()
    graph.destroy()
  })

  it('flips Y, because framebuffers read bottom-up and touches arrive top-down', () => {
    const { gl, record } = createMockGL({ readPixels: fillWith(1) })
    const graph = makeGraph(gl, { onLinkClick: () => undefined })
    graph.findLinkOnScreen(200, 0) // top of the screen
    const top = record.readPixelCalls[0]
    record.readPixelCalls.length = 0
    graph.setZoomTransform(graph.zoomTransform) // invalidate, force a refill
    graph.findLinkOnScreen(200, 400) // bottom of the screen
    const bottom = record.readPixelCalls[0]

    // A touch at the top of the screen must read the *high* rows of the buffer.
    expect(top?.y).toBeGreaterThan(bottom?.y as number)
    graph.destroy()
  })

  it('dispatches a tap to onLinkClick when no point is under it', () => {
    const onLinkClick = vi.fn()
    const onPointClick = vi.fn()
    const onBackgroundClick = vi.fn()
    const { gl } = createMockGL({ readPixels: fillWith(1) })
    const graph = withoutPoints(makeGraph(gl, { onLinkClick, onPointClick, onBackgroundClick }))

    graph.handleTap({
      x: 200, y: 200, timestamp: 0, pointerType: 'touch', pointerCount: 1, isSecondary: false,
    })

    expect(onLinkClick).toHaveBeenCalledWith(1, expect.anything())
    expect(onPointClick).not.toHaveBeenCalled()
    // A link was hit, so this is not background.
    expect(onBackgroundClick).not.toHaveBeenCalled()
    graph.destroy()
  })

  it('reports background when neither a point nor a link is hit', () => {
    const onLinkClick = vi.fn()
    const onBackgroundClick = vi.fn()
    const { gl } = createMockGL({ readPixels: fillWith(0, 0) })
    const graph = withoutPoints(makeGraph(gl, { onLinkClick, onBackgroundClick }))

    graph.handleTap({
      x: 10, y: 10, timestamp: 0, pointerType: 'touch', pointerCount: 1, isSecondary: false,
    })

    expect(onLinkClick).not.toHaveBeenCalled()
    expect(onBackgroundClick).toHaveBeenCalled()
    graph.destroy()
  })

  it('fires link hover on enter and exit, once per change', () => {
    const onLinkMouseOver = vi.fn()
    const onLinkMouseOut = vi.fn()
    let index = 1
    const { gl } = createMockGL({
      readPixels: (out) => fillWith(index)(out),
    })
    const graph = withoutPoints(makeGraph(gl, { onLinkMouseOver, onLinkMouseOut }))
    const move = (x: number): void => graph.handlePointerMove({
      x, y: 200, timestamp: 0, pointerType: 'touch', pointerCount: 1, isSecondary: false,
    })

    move(200)
    expect(onLinkMouseOver).toHaveBeenCalledTimes(1)
    // Still the same link — hovering must not re-fire every frame.
    move(201)
    expect(onLinkMouseOver).toHaveBeenCalledTimes(1)

    index = 2
    graph.setZoomTransform(graph.zoomTransform)
    move(202)
    expect(onLinkMouseOver).toHaveBeenCalledTimes(2)
    expect(onLinkMouseOut).not.toHaveBeenCalled()
    graph.destroy()
  })

  it('routes a long press to onLinkContextMenu', () => {
    const onLinkContextMenu = vi.fn()
    const { gl } = createMockGL({ readPixels: fillWith(2) })
    const graph = withoutPoints(makeGraph(gl, { onLinkContextMenu }))

    graph.handleTap({
      x: 200, y: 200, timestamp: 0, pointerType: 'touch', pointerCount: 1, isSecondary: true,
    })

    expect(onLinkContextMenu).toHaveBeenCalledWith(2, expect.anything())
    graph.destroy()
  })
})

describe('point and link precedence', () => {
  it('lets a point occlude the link beneath it', () => {
    // Points are drawn on top of their own edges, so a touch that lands on
    // both was aiming at the point.
    const onLinkClick = vi.fn()
    const onPointClick = vi.fn()
    const { gl } = createMockGL({ readPixels: fillWith(1) })
    const graph = makeGraph(gl, { onLinkClick, onPointClick })

    graph.handleTap({
      x: 200, y: 200, timestamp: 0, pointerType: 'touch', pointerCount: 1, isSecondary: false,
    })

    expect(onPointClick).toHaveBeenCalled()
    expect(onLinkClick).not.toHaveBeenCalled()
    graph.destroy()
  })
})
