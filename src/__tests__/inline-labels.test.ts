import { describe, expect, it } from 'vitest'
import { Graph } from '../core/graph'
import type { LabelDrawData } from '../core/labels'
import { createMockGL } from './mock-gl'

function labelData (): LabelDrawData {
  return {
    count: 1,
    pointIndices: new Float32Array([0]),
    anchors: new Float32Array([0, 0]),
    sizes: new Float32Array([80, 20]),
    uvRects: new Float32Array([0, 0, 0.5, 0.25]),
    visible: new Float32Array([1]),
    textColors: new Float32Array([1, 1, 1, 1]),
    chipColors: new Float32Array([0, 0, 0, 0.7]),
    pointRadii: new Float32Array([5]),
    margins: new Float32Array([7]),
    cornerRadii: new Float32Array([4]),
  }
}

function graphWithPoint () {
  const mock = createMockGL()
  const graph = new Graph(mock.gl, { enableSimulation: false, transitionDuration: 0 })
  graph.setSize(360, 720)
  graph.setPointPositions(new Float32Array([2048, 2048]))
  graph.setLabelAtlas({ width: 2048, height: 2048, format: 'r8unorm' })
  return { ...mock, graph }
}

describe('inline GL labels', () => {
  it('adds exactly one draw and no readback to an ordinary frame', () => {
    const { graph, record } = graphWithPoint()
    graph.render([0, 0, 720, 1440])
    const baselineFrameDraws = record.drawCalls
    const readbacks = record.readPixelCalls.length

    graph.setLabels(labelData())
    graph.render([0, 0, 720, 1440])

    expect(record.drawCalls - baselineFrameDraws).toBe(baselineFrameDraws + 1)
    expect(record.readPixelCalls).toHaveLength(readbacks)
    expect(graph.getLabelRendererStats().drawCalls).toBe(1)
  })

  it('uploads only atlas patches after allocation', () => {
    const { graph, record } = graphWithPoint()
    expect(record.pixelStoreCalls).toContainEqual({ parameter: 0x0cf5, value: 1 })
    expect(graph.getLabelRendererStats().atlasBytes).toBe(2048 * 2048)
    const before = graph.getLabelRendererStats()
    graph.updateLabelAtlas({ x: 3, y: 4, width: 5, height: 6, pixels: new Uint8Array(30) })
    const after = graph.getLabelRendererStats()
    expect(after.atlasUploads - before.atlasUploads).toBe(1)
    expect(after.atlasUploadBytes - before.atlasUploadBytes).toBe(30)
  })

  it('does not re-upload unchanged draw data', () => {
    const { graph } = graphWithPoint()
    const data = labelData()
    graph.setLabels(data)
    graph.setLabels(data)
    graph.setLabels(labelData())
    expect(graph.getLabelRendererStats().instanceUploads).toBe(1)
  })

  it('releases the persistent label atlas with the graph', () => {
    const { graph, record, gl } = graphWithPoint()
    graph.render([0, 0, 720, 1440])
    graph.setLabels(labelData())
    graph.render([0, 0, 720, 1440])
    expect(record.textureBytes).toBeGreaterThanOrEqual(2048 * 2048)

    graph.destroy()
    expect(record.textureBytes).toBe(0)

    // Expo recreates the Graph around a replacement GL context after loss;
    // verify the label allocation is not retained in process-global state.
    const replacement = new Graph(gl, { enableSimulation: false })
    replacement.setLabelAtlas({ width: 2048, height: 2048, format: 'r8unorm' })
    expect(record.textureBytes).toBe(2048 * 2048)
    replacement.destroy()
    expect(record.textureBytes).toBe(0)
  })

  it('gathers tracked positions only when they are read', () => {
    const { graph, record } = graphWithPoint()
    graph.trackPointsByIndices([0])
    graph.render([0, 0, 720, 1440])
    expect(record.readPixelCalls).toHaveLength(0)

    expect(graph.getTrackedPointPositionsMap().has(0)).toBe(true)
    expect(record.readPixelCalls).toHaveLength(1)
  })

  it('validates patch bounds before crossing into GL', () => {
    const { graph } = graphWithPoint()
    expect(() => graph.updateLabelAtlas({
      x: 2040,
      y: 0,
      width: 16,
      height: 1,
      pixels: new Uint8Array(16),
    })).toThrow(/bounds/)
  })

  it('reports asynchronous GPU timing only when the extension is available', () => {
    const { gl, record } = createMockGL({
      extensions: [
        'EXT_color_buffer_float',
        'EXT_float_blend',
        'OES_texture_float_linear',
        'EXT_disjoint_timer_query_webgl2',
      ],
    })
    const graph = new Graph(gl, { enableSimulation: false, transitionDuration: 0 })
    graph.setSize(360, 720)
    graph.setPointPositions(new Float32Array([2048, 2048]))
    const samples: number[] = []
    graph.render([0, 0, 720, 1440])
    expect(record.timerQueries).toBe(0)
    graph.onPerformanceSample((sample) => {
      if (sample.gpuMs !== undefined) samples.push(sample.gpuMs)
    })

    graph.render([0, 0, 720, 1440])
    graph.render([0, 0, 720, 1440])
    expect(record.timerQueries).toBe(2)
    expect(samples).toEqual([4])
    graph.destroy()
  })
})
