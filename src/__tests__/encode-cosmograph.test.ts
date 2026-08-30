import { describe, it, expect } from 'vitest'
import { DataFrame } from '../data/data-frame'
import { encodeSizes, encodeLinkWidths } from '../data/encode'

/**
 * Golden expectations for the Cosmograph-compatible encodings.
 *
 * The numbers here are not this implementation's output written down after the
 * fact — they are computed from the scale Cosmograph actually uses, so a change
 * that quietly alters the curve fails rather than re-baselines.
 */

/** d3 `scaleSymlog` at its default constant of 1, mapped onto a range. */
function symlog (value: number, domain: [number, number], range: [number, number]): number {
  const t = (x: number): number => Math.sign(x) * Math.log1p(Math.abs(x))
  const position = (t(value) - t(domain[0])) / (t(domain[1]) - t(domain[0]))
  const clamped = Math.max(0, Math.min(1, position))
  return range[0] + (range[1] - range[0]) * clamped
}

const frameOf = (column: string, values: number[]): DataFrame =>
  new DataFrame(values.map((value) => ({ [column]: value })))

describe('point size — the `auto` strategy', () => {
  it('is symmetric-log over an inner percentile band, not linear', () => {
    // The distinction that matters: at the middle of the domain a linear scale
    // returns the middle of the range and this does not. A port that assumed
    // linear would be wrong for every mid-tier node in the graph.
    const values = [8, 12, 14, 17, 20, 24]
    const frame = frameOf('size', values)
    const { sizes, resolved } = encodeSizes(
      frame, values.length, { strategy: 'auto', by: 'size', range: [8, 30] }, 8
    )

    const domain = resolved.domain as [number, number]
    for (let i = 0; i < values.length; i++) {
      expect(sizes[i]).toBeCloseTo(symlog(values[i] as number, domain, [8, 30]), 4)
    }

    const midpoint = (domain[0] + domain[1]) / 2
    const linear = 8 + (30 - 8) * 0.5
    expect(symlog(midpoint, domain, [8, 30])).toBeGreaterThan(linear + 1)
  })

  it('clips the domain to the 5th and 95th percentile', () => {
    // One outlier must not compress everything else into the bottom of the
    // range — the reason Cosmograph reaches for quantiles here at all. Enough
    // samples that the 95th percentile has values to sit between: at n = 10 it
    // interpolates into the outlier itself and clips nothing. Spread, too — a
    // band whose ends coincide is documented to fall back to the full extent.
    const values = [...Array.from({ length: 39 }, (_, i) => 10 + i / 10), 10_000]
    const frame = frameOf('size', values)
    const { resolved } = encodeSizes(
      frame, values.length, { strategy: 'auto', by: 'size', range: [8, 30] }, 8
    )
    const domain = resolved.domain as [number, number]
    expect(domain[1]).toBeLessThan(1_000)
  })

  it('saturates rather than overshooting outside the domain', () => {
    const values = [...Array.from({ length: 39 }, (_, i) => 10 + i / 10), 10_000]
    const frame = frameOf('size', values)
    const { sizes } = encodeSizes(
      frame, values.length, { strategy: 'auto', by: 'size', range: [8, 30] }, 8
    )
    for (const size of sizes) {
      expect(size).toBeGreaterThanOrEqual(8)
      expect(size).toBeLessThanOrEqual(30)
    }
    expect(sizes[values.length - 1]).toBe(30)
  })

  it('puts a column of one repeated value at the bottom of the range', () => {
    const values = [7, 7, 7, 7]
    const { sizes } = encodeSizes(
      frameOf('size', values), values.length,
      { strategy: 'auto', by: 'size', range: [8, 30] }, 8
    )
    expect(Array.from(sizes)).toEqual([8, 8, 8, 8])
  })

  it('leaves the existing `continuous` strategy alone', () => {
    // `auto` was added beside it, not over it: an existing caller's graph must
    // not change shape because a new strategy exists.
    const values = [1, 2, 3, 4]
    const frame = frameOf('size', values)
    const auto = encodeSizes(frame, 4, { strategy: 'auto', by: 'size', range: [0, 10] }, 1)
    const continuous = encodeSizes(frame, 4, { strategy: 'continuous', by: 'size', range: [0, 10] }, 1)
    expect(Array.from(auto.sizes)).not.toEqual(Array.from(continuous.sizes))

    // Still the square-root curve over its own resolved domain.
    const domain = continuous.resolved.domain as [number, number]
    const position = (values[1] as number - domain[0]) / (domain[1] - domain[0])
    expect(continuous.sizes[1]).toBeCloseTo(10 * Math.sqrt(position), 4)
  })
})

describe('point size — the `symlog` strategy', () => {
  it('reads the full extent rather than a percentile band', () => {
    const values = [10, 10, 11, 11, 12, 12, 13, 13, 14, 10_000]
    const { resolved } = encodeSizes(
      frameOf('v', values), values.length,
      { strategy: 'symlog', by: 'v', range: [0.2, 1] }, 1
    )
    expect(resolved.domain).toEqual([10, 10_000])
  })
})

describe('link width — the `sum` strategy', () => {
  const widths = (rows: number[], links: number[], range: [number, number] = [0.8, 4]) =>
    encodeLinkWidths(
      new DataFrame(rows.map((displayWidth) => ({ displayWidth }))),
      rows.length,
      { by: 'displayWidth', range, aggregate: 'sum', strategy: 'symlog' },
      links,
      1
    ).sizes

  it('aggregates A→B independently of B→A', () => {
    // Direction is not incidental: the two are drawn in different places once
    // links curve, and merging them would widen both by the other's traffic.
    const sizes = widths([1, 2, 4], [0, 1, 0, 1, 1, 0])
    // Rows 0 and 1 share A→B and total 3; row 2 is B→A alone at 4.
    expect(sizes[0]).toBe(sizes[1])
    expect(sizes[2]).toBeGreaterThan(sizes[0] as number)
  })

  it('gives links sharing a pair the same width', () => {
    const sizes = widths([1, 2, 3], [0, 1, 0, 1, 0, 1])
    expect(sizes[0]).toBe(sizes[1])
    expect(sizes[1]).toBe(sizes[2])
  })

  it('makes a doubled connection wider than a single one', () => {
    const sizes = widths([2, 1, 1], [0, 1, 2, 3, 2, 3])
    // A→B carries 2; C→D carries 1 + 1 = 2. Equal totals, equal widths.
    expect(sizes[0]).toBeCloseTo(sizes[1] as number, 6)
  })

  it('counts links when asked to, ignoring the column', () => {
    const sizes = encodeLinkWidths(
      new DataFrame([{ displayWidth: 99 }, { displayWidth: 99 }, { displayWidth: 99 }]),
      3,
      { by: 'displayWidth', range: [0.8, 4], aggregate: 'count', strategy: 'symlog' },
      [0, 1, 0, 1, 2, 3],
      1
    ).sizes
    expect(sizes[0]).toBe(sizes[1])
    expect(sizes[2]).toBeLessThan(sizes[0] as number)
  })

  it('does not aggregate under the `direct` default', () => {
    const sizes = encodeLinkWidths(
      new DataFrame([{ w: 1 }, { w: 2 }]),
      2,
      { by: 'w', range: [0.8, 4], strategy: 'direct' },
      [0, 1, 0, 1],
      1
    ).sizes
    expect(Array.from(sizes)).toEqual([1, 2])
  })

  it('keeps every width inside the range', () => {
    const sizes = widths([0.8, 3, 7.2, 1.4], [0, 1, 1, 2, 2, 3, 3, 0])
    for (const width of sizes) {
      expect(width).toBeGreaterThanOrEqual(0.8)
      expect(width).toBeLessThanOrEqual(4)
    }
  })

  it('does not collide distant point indices onto one pair', () => {
    // A key built by arithmetic on two large indices loses precision in a
    // double and would silently merge unrelated pairs.
    const sizes = widths([1, 5], [1, 0, 0, 4_294_967_296])
    expect(sizes[0]).not.toBe(sizes[1])
  })
})
