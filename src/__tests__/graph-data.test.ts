import { describe, it, expect, vi } from 'vitest'
import { GraphData, PointShape, LinkStyle } from '../core/graph-data'
import { createDefaultConfig } from '../core/variables'
import type { GraphConfigInterface } from '../core/config'

function makeData (overrides: Partial<GraphConfigInterface> = {}): GraphData {
  const config = createDefaultConfig()
  Object.assign(config, overrides)
  return new GraphData(config)
}

describe('GraphData', () => {
  it('derives the point count from the positions array', () => {
    const data = makeData()
    data.inputPointPositions = new Float32Array([0, 0, 1, 1, 2, 2])
    data.update()
    expect(data.pointsNumber).toBe(3)
  })

  it('drops a trailing odd value rather than producing a fractional count', () => {
    // A fractional count reaches `new Array(count)` and throws from inside the
    // deferred render, leaving a blank graph and no surfaced error.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const data = makeData()
    data.inputPointPositions = new Float32Array([0, 0, 1, 1, 9])
    data.update()
    expect(data.pointsNumber).toBe(2)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('never mutates the caller\'s arrays', () => {
    const data = makeData()
    const colors = new Float32Array([NaN, NaN, NaN, NaN])
    const positions = new Float32Array([1, 2])
    data.inputPointPositions = positions
    data.inputPointColors = colors
    data.update()
    expect(Array.from(colors).every(Number.isNaN)).toBe(true)
    expect(Array.from(positions)).toEqual([1, 2])
  })

  it('resolves a NaN color channel to the config default for a present point', () => {
    const data = makeData({ pointDefaultColor: [0.25, 0.5, 0.75, 1] })
    data.inputPointPositions = new Float32Array([10, 10])
    data.inputPointColors = new Float32Array([NaN, NaN, NaN, NaN])
    data.update()
    expect(data.getResolvedPointColorChannel(0, 0)).toBeCloseTo(0.25, 5)
    expect(data.getResolvedPointColorChannel(0, 2)).toBeCloseTo(0.75, 5)
  })

  it('resolves a NaN channel of an absent point to the exit default', () => {
    // An absent point must fade to nothing, not to the configured colour —
    // otherwise removing a point makes it flash its default first.
    const data = makeData({ pointDefaultColor: [1, 1, 1, 1], pointDefaultSize: 8 })
    data.inputPointPositions = new Float32Array([NaN, NaN])
    data.inputPointColors = new Float32Array([NaN, NaN, NaN, NaN])
    data.inputPointSizes = new Float32Array([NaN])
    data.update()
    expect(data.getResolvedPointColorChannel(0, 0)).toBe(0)
    expect(data.getResolvedPointSize(0)).toBe(0)
  })

  it('replaces an out-of-range or fractional shape with the default', () => {
    // The draw shader matches shapes by exact equality, so a fractional value
    // would silently render as its fallback rather than the configured default.
    const data = makeData({ pointDefaultShape: PointShape.Square })
    data.inputPointPositions = new Float32Array([0, 0, 1, 1, 2, 2, 3, 3])
    data.inputPointShapes = new Float32Array([PointShape.Star, 2.5, -1, 99])
    data.update()
    expect(Array.from(data.pointShapes as Float32Array)).toEqual([
      PointShape.Star, PointShape.Square, PointShape.Square, PointShape.Square,
    ])
  })

  it('replaces an invalid link style with the default', () => {
    const data = makeData({ linkDefaultStyle: LinkStyle.Dashed })
    data.inputPointPositions = new Float32Array([0, 0, 1, 1])
    data.inputLinks = new Float32Array([0, 1, 1, 0])
    data.inputLinkStyles = new Float32Array([LinkStyle.Dotted, 7])
    data.update()
    expect(Array.from(data.linkStyles as Float32Array)).toEqual([LinkStyle.Dotted, LinkStyle.Dashed])
  })

  it('skips links whose endpoints are not real points', () => {
    // An out-of-range endpoint would otherwise extend the adjacency past the
    // point count and be reported as a neighbour the caller cannot look up.
    const data = makeData()
    data.inputPointPositions = new Float32Array([0, 0, 1, 1])
    data.inputLinks = new Float32Array([0, 1, 0, 99, -1, 1, 0, 1.5])
    data.update()
    expect(data.getNeighboringPointIndices(0)).toEqual([1])
    expect(data.degree).toEqual([1, 1])
  })

  it('keeps link indices the caller\'s own when some links are skipped', () => {
    // Skipped, not dropped: link 2 must still be link 2.
    const data = makeData()
    data.inputPointPositions = new Float32Array([0, 0, 1, 1, 2, 2])
    data.inputLinks = new Float32Array([0, 99, 0, 1, 1, 2])
    data.update()
    expect(data.getConnectedLinkIndices([0, 1])).toEqual([1])
    expect(data.getConnectedPointIndices(2)).toEqual([1, 2])
  })

  it('counts in- and out-degree separately', () => {
    const data = makeData()
    data.inputPointPositions = new Float32Array([0, 0, 1, 1, 2, 2])
    data.inputLinks = new Float32Array([0, 1, 0, 2])
    data.update()
    expect(data.outDegree).toEqual([2, 0, 0])
    expect(data.inDegree).toEqual([0, 1, 1])
    expect(data.degree).toEqual([2, 1, 1])
  })

  it('defaults image sizes to the resolved point size', () => {
    const data = makeData({ pointDefaultSize: 6 })
    data.inputPointPositions = new Float32Array([0, 0, 1, 1])
    data.inputPointSizes = new Float32Array([NaN, 12])
    data.update()
    expect(Array.from(data.pointImageSizes as Float32Array)).toEqual([6, 12])
  })
})
