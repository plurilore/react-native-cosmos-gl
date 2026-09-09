import React, { StrictMode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CosmosGraph } from '../react/CosmosGraph'
import { CosmosInlineSkiaLabels } from '../skia/CosmosInlineSkiaLabels'
import { LabelRefreshScheduler } from '../labels/scheduler'

type TestContext = {
  alive: boolean
  drawingBufferWidth: number
  drawingBufferHeight: number
  endFrameEXP: ReturnType<typeof vi.fn>
}
type TestGraph = {
  context: TestContext
  destroyed: boolean
  needsFrame: boolean
  render: ReturnType<typeof vi.fn>
  destroy: () => void
  getPointPositionsByIndices: ReturnType<typeof vi.fn>
}
type SurfaceProps = { onContextCreate: (context: TestContext) => void }
const runtime = vi.hoisted(() => ({
  graphs: [] as TestGraph[],
  surfaces: [] as SurfaceProps[],
  order: [] as string[],
  frameCallbacks: new Map<number, FrameRequestCallback>(),
  nextFrame: 0,
  drainAtNativeUnmount: false,
}))

vi.mock('react-native', () => ({
  View: 'View',
  PixelRatio: { get: () => 1 },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
}))
// Keep the real gesture hook/coordinator mounted; only the native builder
// boundary is replaced. Gesture behavior has its own focused regression suite.
vi.mock('react-native-gesture-handler', () => {
  const createGesture = () => {
    const gesture: Record<string, unknown> = {}
    for (const name of [
      'minDistance',
      'averageTouches',
      'maxDistance',
      'maxDuration',
      'minDuration',
      'numberOfPointers',
      'runOnJS',
      'onTouchesDown',
      'onTouchesUp',
      'onTouchesCancelled',
      'onStart',
      'onUpdate',
      'onFinalize',
      'onEnd',
    ])
      gesture[name] = () => gesture
    return gesture
  }
  return {
    GestureDetector: 'GestureDetector',
    Gesture: {
      Pan: createGesture,
      Pinch: createGesture,
      LongPress: createGesture,
      Tap: createGesture,
      Simultaneous: (...gestures: unknown[]) => gestures,
      Exclusive: (...gestures: unknown[]) => gestures,
    },
  }
})
vi.mock('../react/gl-view', async () => {
  const ReactModule = await import('react')
  class TestGLView extends ReactModule.Component<SurfaceProps> {
    override componentDidMount() {
      runtime.surfaces.push(this.props)
    }
    override componentWillUnmount() {
      runtime.order.push('native-surface-delete')
      for (const graph of runtime.graphs) graph.context.alive = false
      // Model native disposal before React gets to passive effect cleanup.
      // Queued work must already be cancelled or unable to reach this context.
      if (runtime.drainAtNativeUnmount) vi.runOnlyPendingTimers()
    }
    override render() {
      return ReactModule.createElement('TestGLView', this.props)
    }
  }
  return { getGLView: () => TestGLView }
})
vi.mock('../react/gestures', () => ({
  GestureController: class {},
}))
vi.mock('@shopify/react-native-skia', () => ({
  useFont: () => ({ measureText: () => ({ width: 1 }) }),
}))
vi.mock('../skia/rasterize', () => ({
  configureFont: vi.fn(),
  mergeAdjacentLabelPatches: (patches: unknown) => patches,
  rasterizeLabelPatches: () => [],
}))
vi.mock('../core/graph', () => ({
  Graph: class {
    destroyed = false
    needsFrame = true
    isSimulationRunning = false
    config = {}
    device = {
      features: { maxTextureSize: 64 },
      enablePerformanceCounters: () => () => {},
    }
    constructor(public context: TestContext) {
      this.assertLive()
      runtime.graphs.push(this)
    }
    assertLive() {
      if (!this.context.alive || this.destroyed) {
        throw new Error('GL work reached a disposed native surface')
      }
    }
    render = vi.fn(() => this.assertLive())
    destroy() {
      this.assertLive()
      runtime.order.push('graph-destroy')
      this.destroyed = true
    }
    setConfigPartial(config: object) {
      Object.assign(this.config, config)
    }
    setSize() {}
    onInvalidate() {
      return () => {}
    }
    onFrame() {
      return () => {}
    }
    onViewTransform() {
      return () => {}
    }
    setLabelAtlas() {
      this.assertLive()
    }
    clearLabels() {
      this.assertLive()
    }
    trackPointsByIndices() {
      this.assertLive()
    }
    getPointPositionsByIndices = vi.fn(() => {
      this.assertLive()
      return new Map()
    })
  },
}))

let renderer: ReactTestRenderer | undefined
function context(): TestContext {
  return {
    alive: true,
    drawingBufferWidth: 100,
    drawingBufferHeight: 100,
    endFrameEXP: vi.fn(),
  }
}
function latestSurface(): SurfaceProps {
  return renderer!.root.find((node) => (node.type as unknown) === 'TestGLView')
    .props as SurfaceProps
}
async function mount(element: React.ReactElement) {
  await act(() => {
    renderer = create(element)
  })
}
async function unmount() {
  const previous = renderer
  renderer = undefined
  await act(() => previous?.unmount())
}

beforeEach(() => {
  vi.useFakeTimers()
  runtime.graphs.length = 0
  runtime.surfaces.length = 0
  runtime.order.length = 0
  runtime.frameCallbacks.clear()
  runtime.nextFrame = 0
  runtime.drainAtNativeUnmount = false
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++runtime.nextFrame
    runtime.frameCallbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    runtime.frameCallbacks.delete(id)
  })
})
afterEach(async () => {
  await unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Cosmos native surface ownership', () => {
  it('ignores a native context callback delivered after tab unmount', async () => {
    const onReady = vi.fn()
    const onError = vi.fn()
    await mount(React.createElement(CosmosGraph, { onReady, onError }))
    const staleSurface = latestSurface()
    await unmount()
    staleSurface.onContextCreate({ ...context(), alive: false })
    expect(runtime.graphs).toHaveLength(0)
    expect(onReady).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(runtime.frameCallbacks.size).toBe(0)
  })

  it('releases GL before native removal and prevents queued labels and frames from using it', async () => {
    await mount(
      React.createElement(
        CosmosGraph,
        {},
        React.createElement(CosmosInlineSkiaLabels, {
          font: 1,
          showDynamicLabels: false,
        }),
      ),
    )
    const gl = context()
    await act(() => latestSurface().onContextCreate(gl))
    const graph = runtime.graphs[0]!
    const staleFrame = [...runtime.frameCallbacks.values()][0]!
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    runtime.drainAtNativeUnmount = true
    await unmount()
    expect(runtime.order).toEqual(['graph-destroy', 'native-surface-delete'])
    expect(graph.destroyed).toBe(true)
    expect(graph.getPointPositionsByIndices).not.toHaveBeenCalled()
    // Cancelling a native callback is best effort; its captured generation
    // must remain invalid even if the platform delivers it anyway.
    staleFrame(0)
    expect(graph.render).not.toHaveBeenCalled()
    expect(gl.endFrameEXP).not.toHaveBeenCalled()
    expect(runtime.frameCallbacks.size).toBe(0)
  })

  it('recreates a fresh surface after StrictMode effect replay and rejects its predecessor', async () => {
    const onReady = vi.fn()
    await mount(
      React.createElement(
        StrictMode,
        {},
        React.createElement(CosmosGraph, { onReady }),
      ),
    )
    const current = latestSurface()
    const stale = runtime.surfaces.find(
      (surface) => surface.onContextCreate !== current.onContextCreate,
    )
    expect(stale).toBeDefined()
    stale!.onContextCreate({ ...context(), alive: false })
    expect(runtime.graphs).toHaveLength(0)
    const gl = context()
    await act(() => current.onContextCreate(gl))
    expect(runtime.graphs).toHaveLength(1)
    expect(onReady).toHaveBeenCalledTimes(1)
    const frame = [...runtime.frameCallbacks.values()][0]!
    frame(0)
    expect(gl.endFrameEXP).toHaveBeenCalledTimes(1)
  })

  it('does not present or schedule again when a frame callback destroys its graph', async () => {
    await mount(React.createElement(CosmosGraph))
    const gl = context()
    await act(() => latestSurface().onContextCreate(gl))
    const graph = runtime.graphs[0]!
    graph.render.mockImplementationOnce(() => {
      graph.destroy()
      gl.alive = false
    })
    const [id, frame] = [...runtime.frameCallbacks.entries()][0]!
    runtime.frameCallbacks.delete(id)
    frame(0)
    expect(gl.endFrameEXP).not.toHaveBeenCalled()
    expect(runtime.frameCallbacks.size).toBe(0)
    // Match the real core's idempotent destroy during subsequent host cleanup.
    graph.destroy = () => {}
  })

  it('uses current error callbacks for asynchronous native initialization', async () => {
    const initialError = vi.fn()
    const currentError = vi.fn()
    await mount(React.createElement(CosmosGraph, { onError: initialError }))
    const initialSurface = latestSurface()
    await act(() =>
      renderer!.update(
        React.createElement(CosmosGraph, { onError: currentError }),
      ),
    )
    initialSurface.onContextCreate({ ...context(), alive: false })
    expect(initialError).not.toHaveBeenCalled()
    expect(currentError).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
  })
})

describe('label refresh subscription disposal', () => {
  it('permanently rejects pending and stale listener work after disposal', () => {
    const refresh = vi.fn()
    const scheduler = new LabelRefreshScheduler(refresh)
    scheduler.request('initial', true)
    scheduler.dispose()
    scheduler.request('frame')
    scheduler.request('view', true)
    vi.runAllTimers()
    expect(refresh).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps cancellation reusable for callers that only clear the current refresh', () => {
    const refresh = vi.fn()
    const scheduler = new LabelRefreshScheduler(refresh)
    scheduler.request('initial', true)
    scheduler.cancel()
    scheduler.request('data', true)
    vi.runAllTimers()
    expect(refresh).toHaveBeenCalledExactlyOnceWith('data')
  })
})
