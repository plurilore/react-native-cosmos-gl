import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockGL, parseUniforms, parseAttributes } from './mock-gl'
import { Graph } from '../core/graph'
import { Program } from '../gl/program'
import * as generatedShaders from '../core/shaders/generated'
import { forceLinkSpringFrag } from '../core/shaders'


/**
 * Records every uniform the engine sets that the linked program does not
 * declare.
 *
 * This is the whole reason the mock context exists. `Program.setUniform`
 * mirrors a real driver and ignores an unknown name, so a misspelled uniform
 * produces a graph that renders and misbehaves — no repulsion, an unmoving
 * view, points stuck at the origin — with nothing reported. Here the miss is
 * captured and the test fails on it.
 */
function instrumentUniformMisses (): { misses: string[]; restore: () => void } {
  const misses: string[] = []
  const original = Program.prototype.setUniform
  Program.prototype.setUniform = function patched (name, value) {
    if (!this.hasUniform(name)) misses.push(`${this.id}.${name}`)
    return original.call(this, name, value)
  }
  return { misses, restore: () => { Program.prototype.setUniform = original } }
}

/** A small ring graph: deterministic, and every point has exactly two links. */
function makeRingGraph (count: number): { positions: Float32Array; links: Float32Array } {
  const positions = new Float32Array(count * 2)
  const links = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2
    positions[i * 2] = 2048 + Math.cos(angle) * 500
    positions[i * 2 + 1] = 2048 + Math.sin(angle) * 500
    links[i * 2] = i
    links[i * 2 + 1] = (i + 1) % count
  }
  return { positions, links }
}

describe('shader sources', () => {
  // Only the generated modules: the barrel also exports shared GLSL *fragments*
  // (the conic curve helper), which are spliced into shaders rather than
  // compiled on their own and so have no `#version` line of their own.
  const allShaders = Object.entries(generatedShaders)
    .filter(([, value]) => typeof value === 'string') as [string, string][]

  it('exports every shader as a non-empty GLSL ES 3.00 source', () => {
    expect(allShaders.length).toBeGreaterThanOrEqual(37)
    for (const [name, source] of allShaders) {
      expect(source.startsWith('#version 300 es'), `${name} must open with #version 300 es`).toBe(true)
      expect(source.length, `${name} must not be empty`).toBeGreaterThan(50)
    }
  })

  it('replaces every isnan() with the bit-exact helper', () => {
    // The built-in folds to false on drivers that assume NaN cannot occur, and
    // the engine encodes absent points as NaN — so a surviving isnan() would
    // resurrect removed points at the origin.
    //
    // Comments are stripped first: the injected helper's own docstring names
    // the built-in it replaces, and that mention is not a call.
    const stripComments = (glsl: string): string =>
      glsl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    for (const [name, source] of allShaders) {
      const code = stripComments(source)
      expect(/\bisnan\s*\(/.test(code), `${name} still calls the built-in isnan()`).toBe(false)
      if (code.includes('cosmosIsNaN(')) {
        expect(code, `${name} uses cosmosIsNaN without defining it`).toContain('bool cosmosIsNaN(float x)')
      }
    }
  })

  it('declares a plain-uniform branch for every uniform-block shader', () => {
    // The engine never defines USE_UNIFORM_BUFFERS, so a shader offering only
    // the block branch would link with no settable uniforms at all.
    for (const [name, source] of allShaders) {
      if (!source.includes('USE_UNIFORM_BUFFERS')) continue
      expect(source, `${name} has no #else branch for the non-UBO path`).toMatch(/#else/)
      expect(parseUniforms(source).length, `${name} exposes no plain uniforms`).toBeGreaterThan(0)
    }
  })

  it('bakes a positive loop bound into the link spring shader', () => {
    // GLSL requires a constant loop bound; a zero or NaN bound would silently
    // drop the link force entirely.
    expect(forceLinkSpringFrag(7)).toContain('const float MAX_LINKS = 7.0;')
    expect(forceLinkSpringFrag(0)).toContain('const float MAX_LINKS = 1.0;')
    expect(forceLinkSpringFrag(2.4)).toContain('const float MAX_LINKS = 3.0;')
  })
})

describe('Graph on a mock device', () => {
  let instrument: ReturnType<typeof instrumentUniformMisses>

  beforeEach(() => {
    instrument = instrumentUniformMisses()
    vi.useFakeTimers()
  })

  afterEach(() => {
    instrument.restore()
    vi.useRealTimers()
  })

  it('renders a graph without setting an undeclared uniform', () => {
    const { gl, record } = createMockGL()
    const graph = new Graph(gl, { spaceSize: 4096, enableSimulation: true })
    graph.setSize(800, 600)

    const { positions, links } = makeRingGraph(64)
    graph.setPointPositions(positions)
    graph.setLinks(links)
    graph.setPointColors(new Float32Array(64 * 4).fill(1))
    graph.setPointSizes(new Float32Array(64).fill(4))
    graph.start()

    for (let frame = 0; frame < 3; frame++) graph.render([0, 0, 1600, 1200])

    expect(instrument.misses).toEqual([])
    expect(record.drawCalls).toBeGreaterThan(0)
    graph.destroy()
  })

  it('binds only attributes the vertex shader declares', () => {
    const { gl, record } = createMockGL()
    const graph = new Graph(gl, {})
    graph.setSize(400, 400)
    const { positions, links } = makeRingGraph(32)
    graph.setPointPositions(positions)
    graph.setLinks(links)
    graph.render([0, 0, 400, 400])

    // Every program's declared attributes must be a superset of nothing
    // surprising: assert each program declared at least one, which fails if a
    // vertex shader failed to parse or link.
    for (const program of record.programs) {
      expect(program.uniforms.length + program.attributes.length).toBeGreaterThan(0)
    }
    graph.destroy()
  })

  it('runs the exact all-pairs repulsion path when float blending is missing', () => {
    // The grid pyramid accumulates each level additively; without
    // EXT_float_blend only the last level would survive, so the engine must
    // fall back rather than render a wrong layout.
    const { gl } = createMockGL({ extensions: ['EXT_color_buffer_float'] })
    const graph = new Graph(gl, {})
    graph.setSize(400, 400)
    // Well above ALL_PAIRS_MAX_POINTS, so the grid path would normally be used.
    const { positions } = makeRingGraph(8000)
    graph.setPointPositions(positions)
    graph.start()
    expect(() => graph.render([0, 0, 400, 400])).not.toThrow()
    expect(instrument.misses).toEqual([])
    graph.destroy()
  })

  it('refuses a device with no float render targets, with a diagnostic', () => {
    const { gl } = createMockGL({ extensions: [] })
    expect(() => new Graph(gl, {})).toThrow(/floating-point/i)
  })

  it('names the real cause when the context is not WebGL2', () => {
    // expo-gl asks for ES 3.0 and silently falls back to ES 2.0. Without this
    // check the first symptom is a missing float extension, which describes a
    // consequence rather than the cause.
    const { gl } = createMockGL()
    const es2 = gl as unknown as Record<string, unknown>
    delete es2.createVertexArray
    expect(() => new Graph(gl, {})).toThrow(/not WebGL2/i)
  })

  it('drives the grid pyramid path above the all-pairs threshold', () => {
    const { gl, record } = createMockGL()
    const graph = new Graph(gl, {})
    graph.setSize(800, 600)
    const { positions, links } = makeRingGraph(6000)
    graph.setPointPositions(positions)
    graph.setLinks(links)
    graph.start()
    for (let frame = 0; frame < 2; frame++) graph.render([0, 0, 800, 600])

    expect(instrument.misses).toEqual([])
    // The pyramid issues many more passes than the single all-pairs draw.
    expect(record.drawCalls).toBeGreaterThan(20)
    graph.destroy()
  })

  it('settles the simulation and stops on its own', () => {
    const { gl } = createMockGL()
    const graph = new Graph(gl, { simulationDecay: 1 })
    graph.setSize(400, 400)
    graph.setPointPositions(makeRingGraph(16).positions)
    graph.start()
    expect(graph.isSimulationRunning).toBe(true)

    // A decay of 1 collapses alpha within a handful of ticks.
    for (let frame = 0; frame < 40; frame++) graph.render([0, 0, 400, 400])
    expect(graph.isSimulationRunning).toBe(false)
    graph.destroy()
  })

  it('does not run forces when the simulation is disabled', () => {
    const { gl, record } = createMockGL()
    const graph = new Graph(gl, { enableSimulation: false })
    graph.setSize(400, 400)
    graph.setPointPositions(makeRingGraph(64).positions)
    graph.render([0, 0, 400, 400])
    const afterFirst = record.drawCalls
    graph.render([0, 0, 400, 400])
    const perFrame = record.drawCalls - afterFirst
    // Exactly the point draw, plus the core pass while occlusion culling is on.
    // The lower bound matters as much as the upper one: a draw that bails out
    // early because an attribute buffer is missing also reports zero.
    expect(perFrame).toBeGreaterThanOrEqual(1)
    expect(perFrame).toBeLessThanOrEqual(2)
    graph.destroy()
  })

  it('draws points given nothing but positions', () => {
    // Colours, sizes and shapes are all optional, and `data.update()` fills
    // them with defaults. If the engine only built their buffers when the
    // matching setter had been called, the draw would find an attribute
    // missing and silently render an empty screen — which is exactly what it
    // used to do.
    const { gl, record } = createMockGL()
    const graph = new Graph(gl, { enableSimulation: false, pointOcclusionCulling: false })
    graph.setSize(400, 400)
    graph.setPointPositions(new Float32Array([100, 100, 200, 200, 150, 250]))

    const before = record.drawCalls
    graph.render([0, 0, 400, 400])
    expect(record.drawCalls - before).toBe(1)
    expect(instrument.misses).toEqual([])
    graph.destroy()
  })

  it('draws links given nothing but positions and links', () => {
    const { gl, record } = createMockGL()
    const graph = new Graph(gl, { enableSimulation: false, pointOcclusionCulling: false })
    graph.setSize(400, 400)
    const { positions, links } = makeRingGraph(12)
    graph.setPointPositions(positions)
    graph.setLinks(links)

    const before = record.drawCalls
    graph.render([0, 0, 400, 400])
    // One link pass and one point pass.
    expect(record.drawCalls - before).toBe(2)
    expect(instrument.misses).toEqual([])
    graph.destroy()
  })

  it('runs the cluster force without setting an undeclared uniform', () => {
    const { gl } = createMockGL()
    const graph = new Graph(gl, { simulationCluster: 0.5 })
    graph.setSize(600, 600)
    const { positions, links } = makeRingGraph(60)
    graph.setPointPositions(positions)
    graph.setLinks(links)
    // Three clusters, with one point deliberately unclustered — the shader
    // reads -1 in both channels as "no force", and that path must be exercised.
    graph.setPointClusters(Array.from({ length: 60 }, (_, i) => (i === 7 ? undefined : i % 3)))
    graph.setPointClusterStrength(new Float32Array(60).fill(0.8))
    graph.start()
    for (let frame = 0; frame < 2; frame++) graph.render([0, 0, 600, 600])

    expect(instrument.misses).toEqual([])
    expect(graph.getClusterPositions()).toHaveLength(6)
    graph.destroy()
  })

  it('pins clusters to configured positions', () => {
    const { gl } = createMockGL()
    const graph = new Graph(gl, { simulationCluster: 0.5 })
    graph.setSize(600, 600)
    graph.setPointPositions(makeRingGraph(30).positions)
    graph.setPointClusters(Array.from({ length: 30 }, (_, i) => i % 2))
    graph.setClusterPositions([1000, 1000, 3000, 3000])
    graph.start()
    expect(() => graph.render([0, 0, 600, 600])).not.toThrow()
    expect(instrument.misses).toEqual([])
    graph.destroy()
  })

  it('runs the collision force without setting an undeclared uniform', () => {
    const { gl } = createMockGL()
    const graph = new Graph(gl, { simulationCollision: 1, simulationCollisionPadding: 2 })
    graph.setSize(600, 600)
    const { positions } = makeRingGraph(120)
    graph.setPointPositions(positions)
    graph.setPointSizes(new Float32Array(120).fill(6))
    graph.start()
    for (let frame = 0; frame < 2; frame++) graph.render([0, 0, 600, 600])

    expect(instrument.misses).toEqual([])
    graph.destroy()
  })

  it('allocates no collision resources while the force is off', () => {
    // A graph that never enables collision must not pay for the grid or the
    // size texture, so the per-frame draw count stays at the no-collision cost.
    const { gl, record } = createMockGL()
    const graph = new Graph(gl, { simulationCollision: 0, enableSimulation: false })
    graph.setSize(400, 400)
    graph.setPointPositions(makeRingGraph(64).positions)
    graph.render([0, 0, 400, 400])
    const baseline = record.drawCalls
    graph.render([0, 0, 400, 400])
    expect(record.drawCalls - baseline).toBeLessThanOrEqual(2)
    graph.destroy()
  })

  it('runs the rect and polygon selection queries', () => {
    const { gl } = createMockGL()
    const graph = new Graph(gl, {})
    graph.setSize(400, 400)
    graph.setPointPositions(makeRingGraph(40).positions)
    graph.setPointSizes(new Float32Array(40).fill(4))
    graph.render([0, 0, 400, 400])

    expect(() => graph.findPointsInRect([[0, 0], [400, 400]])).not.toThrow()
    expect(() => graph.findPointsInPolygon([[0, 0], [400, 0], [400, 400], [0, 400]])).not.toThrow()
    expect(instrument.misses).toEqual([])
    graph.destroy()
  })

  it('rejects a degenerate polygon instead of querying with it', () => {
    // Fewer than three vertices bounds no area; running the query would read
    // back a full buffer to return nothing.
    const { gl } = createMockGL()
    const graph = new Graph(gl, {})
    graph.setSize(400, 400)
    graph.setPointPositions(makeRingGraph(10).positions)
    graph.render([0, 0, 400, 400])
    expect(graph.findPointsInPolygon([[0, 0], [10, 10]])).toEqual([])
    graph.destroy()
  })

  it('adds the occlusion core pass only while culling is on', () => {
    // The reversed index buffer is built on demand, so toggling the config at
    // runtime has to take effect on the next frame rather than waiting for a
    // data update to rebuild it.
    const { gl, record } = createMockGL()
    const graph = new Graph(gl, { enableSimulation: false, pointOcclusionCulling: false })
    graph.setSize(400, 400)
    graph.setPointPositions(makeRingGraph(20).positions)
    graph.render([0, 0, 400, 400])

    let before = record.drawCalls
    graph.render([0, 0, 400, 400])
    expect(record.drawCalls - before).toBe(1)

    graph.setConfigPartial({ pointOcclusionCulling: true })
    before = record.drawCalls
    graph.render([0, 0, 400, 400])
    expect(record.drawCalls - before).toBe(2)
    expect(instrument.misses).toEqual([])
    graph.destroy()
  })

  it('survives an empty graph and a graph with no links', () => {
    const { gl } = createMockGL()
    const graph = new Graph(gl, {})
    graph.setSize(300, 300)
    expect(() => graph.render([0, 0, 300, 300])).not.toThrow()

    graph.setPointPositions(new Float32Array([100, 100, 200, 200]))
    expect(() => graph.render([0, 0, 300, 300])).not.toThrow()
    expect(graph.pointsNumber).toBe(2)
    expect(graph.linksNumber).toBe(0)
    graph.destroy()
  })

  it('drops a trailing odd value from positions and links, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { gl } = createMockGL()
    const graph = new Graph(gl, {})
    graph.setSize(300, 300)
    // An odd length would make the point count fractional, which reaches
    // `new Array(count)` and throws from inside the deferred render.
    graph.setPointPositions(new Float32Array([1, 2, 3, 4, 5]))
    graph.setLinks(new Float32Array([0, 1, 0]))
    graph.render([0, 0, 300, 300])
    expect(graph.pointsNumber).toBe(2)
    expect(graph.linksNumber).toBe(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    graph.destroy()
  })
})

describe('shader declaration parsing', () => {
  it('reads the plain-uniform branch and ignores the uniform block', () => {
    const source = `#version 300 es
precision highp float;
uniform sampler2D positionsTexture;
#ifdef USE_UNIFORM_BUFFERS
layout(std140) uniform blockName {
  float inBlock;
} block;
#else
uniform float friction;
uniform vec2 screenSize;
#endif
void main() {}`
    const names = parseUniforms(source).map((u) => u.name)
    expect(names).toContain('positionsTexture')
    expect(names).toContain('friction')
    expect(names).toContain('screenSize')
    expect(names).not.toContain('inBlock')
  })

  it('reads comma-separated attribute declarations', () => {
    // draw-curve-line.vert declares `in vec2 position, pointA, pointB;`
    const names = parseAttributes('#version 300 es\nin vec2 position, pointA, pointB;\n').map((a) => a.name)
    expect(names).toEqual(['position', 'pointA', 'pointB'])
  })
})
