import { describe, it, expect } from 'vitest'
import { probeDevice, formatDeviceReport } from '../gl/probe'
import { createMockGL } from './mock-gl'

describe('probeDevice', () => {
  it('reports a fully capable device as supported', () => {
    const { gl } = createMockGL()
    const report = probeDevice(gl)
    expect(report.supported).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.isWebGL2).toBe(true)
    expect(report.renderToFloat32).toBe(true)
  })

  it('names the ES 2.0 fallback rather than its symptoms', () => {
    const { gl } = createMockGL()
    delete (gl as unknown as Record<string, unknown>).createVertexArray
    const report = probeDevice(gl)
    expect(report.supported).toBe(false)
    expect(report.blockers.join(' ')).toMatch(/WebGL2/i)
  })

  it('blocks a device with no float render targets', () => {
    const { gl } = createMockGL({ extensions: [] })
    const report = probeDevice(gl)
    expect(report.supported).toBe(false)
    expect(report.blockers.join(' ')).toMatch(/float render targets/i)
  })

  it('warns rather than blocks when only float blending is missing', () => {
    // The engine still runs — repulsion just falls back to the exact path.
    const { gl } = createMockGL({ extensions: ['EXT_color_buffer_float'] })
    const report = probeDevice(gl)
    expect(report.supported).toBe(true)
    expect(report.warnings.join(' ')).toMatch(/EXT_float_blend/)
  })

  it('never throws on a context that refuses every query', () => {
    // A half-dead context after a GL error should still produce a report — the
    // probe exists precisely for devices that are misbehaving.
    const hostile = new Proxy({}, {
      get: () => () => { throw new Error('context lost') },
    }) as unknown as WebGL2RenderingContext
    expect(() => probeDevice(hostile)).not.toThrow()
    expect(probeDevice(hostile).supported).toBe(false)
  })

  it('formats a report that can be pasted into an issue', () => {
    const { gl } = createMockGL()
    const text = formatDeviceReport(probeDevice(gl))
    expect(text).toMatch(/supported:\s+YES/)
    expect(text).toMatch(/max texture size:\s+\d+/)
  })
})
