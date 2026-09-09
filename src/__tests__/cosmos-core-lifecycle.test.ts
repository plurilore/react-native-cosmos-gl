import { describe, expect, it, vi } from 'vitest'
import { Graph } from '../core/graph'
import { Store } from '../core/store'
import { Transition, TransitionProperty } from '../core/transition'
import { Zoom } from '../core/zoom'
import { ZoomTransform } from '../core/zoom-transform'
import { createDefaultConfig } from '../core/variables'
import { createMockGL } from './mock-gl'

/** Real scheduling, transition and simulation code with only GPU resources replaced. */
function frameHarness() {
  const graph = Object.create(Graph.prototype) as Graph
  const config = createDefaultConfig()
  const store = new Store()
  store.screenSize = [100, 100]
  const transition = new Transition(config)
  const zoomInstance = new Zoom(store, config)
  zoomInstance.onTransform = () => graph.emitViewTransform()
  const gpuWork = vi.fn(() => {
    if (graph.destroyed) throw new Error('GPU use after graph destruction')
  })
  const points = {
    draw: vi.fn(() => gpuWork()),
    swapFbo: gpuWork,
    updatePosition: gpuWork,
    setTransitionProgress: gpuWork,
    interpolatePosition: gpuWork,
    destroyTransitionResources: gpuWork,
    trackPointsByIndices: gpuWork,
    getTrackedPositionsMap: gpuWork,
    sampleVisiblePoints: gpuWork,
    destroy: vi.fn(),
  }
  const lines = {
    draw: vi.fn(() => gpuWork()),
    setTransitionProgress: gpuWork,
    markLinkPickingStale: vi.fn(),
    destroy: vi.fn(),
  }
  const labels = {
    draw: vi.fn(() => gpuWork()),
    setAtlas: gpuWork,
    updateAtlas: gpuWork,
    setLabels: gpuWork,
    clear: gpuWork,
    destroy: vi.fn(),
  }
  Object.assign(graph, {
    config,
    store,
    transition,
    zoomInstance,
    points,
    lines,
    labels,
    data: {},
    device: {
      setViewport: gpuWork,
      bindFramebuffer: gpuWork,
      setParameters: gpuWork,
      destroyPerformanceResources: vi.fn(),
      gl: { clearColor: gpuWork, clearDepth: gpuWork, clear: gpuWork },
    },
    isDestroyed: false,
    hasInitialized: true,
    viewTransformListeners: new Set(),
    invalidateListeners: new Set(),
    frameListeners: new Set(),
    performanceListeners: new Set(),
  })
  return { graph, gpuWork, points, lines, labels }
}

describe('Cosmos core callback teardown', () => {
  it('releases actual engine resources before rejecting retained label access', () => {
    const { gl, record } = createMockGL()
    let disposed = false
    const guardedGL = new Proxy(gl, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          if (disposed)
            throw new Error(`GL call after native disposal: ${String(key)}`)
          return Reflect.apply(value, target, args)
        }
      },
    })
    const graph = new Graph(guardedGL, {
      enableSimulation: false,
      fitViewOnInit: false,
      transitionDuration: 0,
    })
    graph.setSize(100, 100)
    graph.setPointPositions(new Float32Array([100, 100]))
    graph.render([0, 0, 100, 100])
    graph.trackPointsByIndices([0])
    graph.setLabelAtlas({ width: 8, height: 8, format: 'r8unorm' })
    expect(record.textureBytes).toBeGreaterThan(0)

    graph.destroy()
    expect(record.textureBytes).toBe(0)
    disposed = true

    // Child effects and retained refs can outlive the native surface. Their
    // public entry points must not allocate a framebuffer or upload an atlas.
    graph.trackPointsByIndices([0])
    expect(graph.getPointPositionsByIndices([0]).size).toBe(0)
    expect(graph.getTrackedPointPositionsMap().size).toBe(0)
    expect(graph.sampleVisiblePointIndices().size).toBe(0)
    graph.setLabelAtlas({ width: 8, height: 8, format: 'r8unorm' })
    graph.updateLabelAtlas([])
    graph.clearLabels()
    graph.render([0, 0, 100, 100])
    graph.destroy()
  })

  it.each([
    'transition-start',
    'transition-frame',
    'zoom',
    'view',
    'simulation',
  ] as const)(
    'stops the active frame when a %s callback destroys the graph',
    (trigger) => {
      const { graph, points, lines, labels } = frameHarness()
      const destroy = vi.fn(() => graph.destroy())
      if (trigger === 'transition-start' || trigger === 'transition-frame') {
        graph.config.transitionDuration = 100
        graph.transition.queue(TransitionProperty.Positions)
        if (trigger === 'transition-start')
          graph.config.onTransitionStart = destroy
        else {
          graph.transition.start()
          graph.config.onTransition = destroy
        }
      } else if (trigger === 'zoom' || trigger === 'view') {
        graph.zoomInstance.animateTo(new ZoomTransform(2, 1, 1), 100)
        if (trigger === 'zoom') graph.config.onZoom = destroy
        else graph.onViewTransform(destroy)
      } else {
        graph.config.onSimulationTick = destroy
        graph.start()
      }
      const drawPoints = vi.spyOn(points, 'draw')
      const drawLines = vi.spyOn(lines, 'draw')
      const drawLabels = vi.spyOn(labels, 'draw')
      expect(() => graph.render([0, 0, 100, 100])).not.toThrow()
      expect(destroy).toHaveBeenCalledTimes(1)
      expect(graph.destroyed).toBe(true)
      expect(graph.needsFrame).toBe(false)
      expect(drawPoints).not.toHaveBeenCalled()
      expect(drawLines).not.toHaveBeenCalled()
      expect(drawLabels).not.toHaveBeenCalled()
    },
  )

  it('revokes retained label/readback access even when a GL deletion fails', () => {
    const { graph, gpuWork, points } = frameHarness()
    points.destroy.mockImplementationOnce(() => {
      throw new Error('driver rejected deletion')
    })
    expect(() => graph.destroy()).toThrow('driver rejected deletion')
    // The failed release leaves the old Points reference present. Liveness,
    // rather than optional chaining alone, must prevent framebuffer allocation.
    expect(graph.points).toBe(points)
    graph.trackPointsByIndices([0])
    expect(graph.getPointPositionsByIndices([0]).size).toBe(0)
    expect(graph.getTrackedPointPositionsMap().size).toBe(0)
    expect(graph.sampleVisiblePointIndices().size).toBe(0)
    graph.setLabelAtlas({ width: 1, height: 1, format: 'r8unorm' })
    graph.updateLabelAtlas([])
    graph.clearLabels()
    graph.render([0, 0, 100, 100])
    expect(gpuWork).not.toHaveBeenCalled()
  })

  it('removes existing subscribers and rejects new work after teardown', () => {
    const { graph } = frameHarness()
    const listener = vi.fn()
    graph.onInvalidate(listener)
    graph.onViewTransform(listener)
    graph.destroy()
    graph.onInvalidate(listener)
    graph.onViewTransform(listener)
    graph.onFrame(listener)
    graph.invalidate()
    graph.emitViewTransform()
    graph.render([0, 0, 100, 100])
    expect(listener).not.toHaveBeenCalled()
    expect(graph.needsFrame).toBe(false)
  })
})
