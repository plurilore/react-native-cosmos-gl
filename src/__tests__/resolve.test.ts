import { describe, it, expect, vi } from 'vitest'
import { resolveGraphData } from '../data/resolve'
import { DataFrame } from '../data/data-frame'
import { encodeColors, encodeSizes } from '../data/encode'
import { CATEGORICAL_PALETTE_DARK } from '../data/palettes'
import { PointShape } from '../core/enums'

const PEOPLE = [
  { id: 'a', name: 'Ada', team: 'core', score: 10 },
  { id: 'b', name: 'Grace', team: 'core', score: 20 },
  { id: 'c', name: 'Alan', team: 'infra', score: 30 },
  { id: 'd', name: 'Barbara', team: 'infra', score: 1000 },
]

const FOLLOWS = [
  { from: 'a', to: 'b', weight: 1 },
  { from: 'b', to: 'c', weight: 5 },
  { from: 'c', to: 'a', weight: 3 },
]

describe('resolveGraphData', () => {
  it('maps records onto point positions and index-space links', () => {
    const data = resolveGraphData({
      pointData: PEOPLE,
      linkData: FOLLOWS,
      pointIdBy: 'id',
      linkSourceBy: 'from',
      linkTargetBy: 'to',
    })

    expect(data.stats.pointsCount).toBe(4)
    expect(data.stats.linksCount).toBe(3)
    expect(data.pointPositions).toHaveLength(8)
    // Links must come out as point *indices*, not the ids they were written as.
    expect(Array.from(data.links as Float32Array)).toEqual([0, 1, 1, 2, 2, 0])
  })

  it('drops links naming an unknown point rather than pointing them at index 0', () => {
    // Resolving a bad endpoint to 0 would draw an edge to an unrelated point
    // and quietly distort the layout.
    const data = resolveGraphData({
      pointData: PEOPLE,
      linkData: [...FOLLOWS, { from: 'a', to: 'ghost' }, { from: 'nobody', to: 'b' }],
      pointIdBy: 'id',
      linkSourceBy: 'from',
      linkTargetBy: 'to',
    })
    expect(data.stats.linksCount).toBe(3)
    expect(data.stats.unresolvedLinksCount).toBe(2)
    expect(Array.from(data.links as Float32Array)).toEqual([0, 1, 1, 2, 2, 0])
  })

  it('keeps per-link encodings aligned when links are dropped', () => {
    // The dropped link is first, so encoding by input-row order would shift
    // every colour by one and mis-paint the whole graph.
    const data = resolveGraphData({
      pointData: PEOPLE,
      linkData: [{ from: 'a', to: 'ghost', weight: 99 }, ...FOLLOWS],
      pointIdBy: 'id',
      linkSourceBy: 'from',
      linkTargetBy: 'to',
      linkWidthBy: 'weight',
      linkWidthRange: [1, 10],
    })
    expect(data.stats.linksCount).toBe(3)
    const widths = data.linkWidths as Float32Array
    expect(widths).toHaveLength(3)
    // Weights 1, 5, 3 — so the middle link is widest.
    expect(widths[1]).toBeGreaterThan(widths[0] as number)
    expect(widths[1]).toBeGreaterThan(widths[2] as number)
  })

  it('computes degree from resolved links only', () => {
    const data = resolveGraphData({
      pointData: PEOPLE,
      linkData: [...FOLLOWS, { from: 'd', to: 'ghost' }],
      pointIdBy: 'id',
      linkSourceBy: 'from',
      linkTargetBy: 'to',
    })
    // 'd' has only the dropped link, so its degree is 0 — an unresolved link
    // must not inflate a degree-driven encoding.
    expect(data.degrees).toEqual([2, 2, 2, 0])
  })

  it('treats endpoints as indices when no id column is configured', () => {
    const data = resolveGraphData({
      pointData: PEOPLE,
      linkData: [{ from: 0, to: 2 }, { from: 1, to: 9 }],
      linkSourceBy: 'from',
      linkTargetBy: 'to',
    })
    expect(Array.from(data.links as Float32Array)).toEqual([0, 2])
    expect(data.stats.unresolvedLinksCount).toBe(1)
  })

  it('resolves duplicate ids to the first occurrence, consistently', () => {
    const data = resolveGraphData({
      pointData: [{ id: 'x' }, { id: 'x' }, { id: 'y' }],
      linkData: [{ from: 'x', to: 'y' }],
      pointIdBy: 'id',
      linkSourceBy: 'from',
      linkTargetBy: 'to',
    })
    expect(Array.from(data.links as Float32Array)).toEqual([0, 2])
  })

  it('warns and ignores links when the endpoint columns are not named', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const data = resolveGraphData({ pointData: PEOPLE, linkData: FOLLOWS, pointIdBy: 'id' })
    expect(data.links).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('resolves links by index when index columns are given', () => {
    const data = resolveGraphData({
      pointData: PEOPLE,
      linkData: [{ s: 0, t: 2 }, { s: 1, t: 3 }],
      pointIdBy: 'id',
      linkSourceIndexBy: 's',
      linkTargetIndexBy: 't',
    })
    expect(Array.from(data.links as Float32Array)).toEqual([0, 2, 1, 3])
  })

  it('drops an out-of-range index rather than clamping it', () => {
    const data = resolveGraphData({
      pointData: PEOPLE,
      linkData: [{ s: 0, t: 2 }, { s: 1, t: 99 }, { s: -1, t: 0 }, { s: 0.5, t: 1 }],
      linkSourceIndexBy: 's',
      linkTargetIndexBy: 't',
    })
    expect(Array.from(data.links as Float32Array)).toEqual([0, 2])
    expect(data.stats.unresolvedLinksCount).toBe(3)
  })

  it('prefers index columns over id columns when both are present', () => {
    // The index path exists to skip the hash lookup; if ids won, it would
    // never be taken.
    const data = resolveGraphData({
      pointData: PEOPLE,
      linkData: [{ from: 'a', to: 'b', s: 2, t: 3 }],
      pointIdBy: 'id',
      linkSourceBy: 'from',
      linkTargetBy: 'to',
      linkSourceIndexBy: 's',
      linkTargetIndexBy: 't',
    })
    expect(Array.from(data.links as Float32Array)).toEqual([2, 3])
  })

  it('warns when pointIndexBy disagrees with row order', () => {
    // The column's whole value is that it can be trusted without a lookup, so
    // a mismatch has to be reported rather than silently mis-resolving links.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    resolveGraphData({
      pointData: [{ idx: 0 }, { idx: 5 }, { idx: 2 }],
      pointIndexBy: 'idx',
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not match row order'))
    warn.mockRestore()
  })

  it('accepts a pointIndexBy column that is in row order', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    resolveGraphData({ pointData: [{ idx: 0 }, { idx: 1 }, { idx: 2 }], pointIndexBy: 'idx' })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('scatters points rather than stacking them at the origin', () => {
    // Coincident points feel no repulsion from each other, so a graph started
    // from one point would never separate.
    const data = resolveGraphData({ pointData: PEOPLE, spaceSize: 4096 })
    const xs = new Set<number>()
    for (let i = 0; i < 4; i++) xs.add(data.pointPositions[i * 2] as number)
    expect(xs.size).toBe(4)
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(0)
  })

  it('is deterministic for a given seed and differs across seeds', () => {
    const a = resolveGraphData({ pointData: PEOPLE, randomSeed: 'one' })
    const b = resolveGraphData({ pointData: PEOPLE, randomSeed: 'one' })
    const c = resolveGraphData({ pointData: PEOPLE, randomSeed: 'two' })
    expect(Array.from(a.pointPositions)).toEqual(Array.from(b.pointPositions))
    expect(Array.from(a.pointPositions)).not.toEqual(Array.from(c.pointPositions))
  })

  it('uses given coordinates and scatters only the rows missing them', () => {
    const data = resolveGraphData({
      pointData: [{ x: 10, y: 20 }, { x: 30, y: 40 }, { y: 50 }],
      pointXBy: 'x',
      pointYBy: 'y',
      spaceSize: 1000,
    })
    expect(data.pointPositions[0]).toBe(10)
    expect(data.pointPositions[3]).toBe(40)
    // The incomplete row is scattered, not pinned at 0 alongside every other
    // incomplete row.
    expect(data.pointPositions[4]).not.toBe(0)
  })

  it('assigns shapes per category, so identity survives past three colours', () => {
    const data = resolveGraphData({ pointData: PEOPLE, pointShapeBy: 'team' })
    const shapes = data.pointShapes as Float32Array
    expect(shapes[0]).toBe(PointShape.Circle)
    expect(shapes[1]).toBe(PointShape.Circle)
    expect(shapes[2]).toBe(PointShape.Square)
    expect(shapes[3]).toBe(PointShape.Square)
  })

  it('ranks labels by degree when no weight column is given', () => {
    const data = resolveGraphData({
      pointData: PEOPLE,
      linkData: FOLLOWS,
      pointIdBy: 'id',
      linkSourceBy: 'from',
      linkTargetBy: 'to',
      pointLabelBy: 'name',
    })
    expect(data.pointLabels).toEqual(['Ada', 'Grace', 'Alan', 'Barbara'])
    expect(Array.from(data.pointLabelWeights)).toEqual([2, 2, 2, 0])
  })

  it('maps clusters and their fixed positions', () => {
    const data = resolveGraphData({
      pointData: PEOPLE,
      pointClusterBy: 'team',
      clusterPositionsMap: { core: [100, 200], infra: [300, 400] },
    })
    expect(data.pointClusters).toEqual([0, 0, 1, 1])
    expect(data.clusterValues).toEqual(['core', 'infra'])
    expect(data.clusterPositions).toEqual([100, 200, 300, 400])
  })

  it('leaves a point with no cluster value unclustered', () => {
    const data = resolveGraphData({
      pointData: [{ team: 'core' }, {}, { team: 'infra' }],
      pointClusterBy: 'team',
    })
    // `undefined` means no pull, which is not the same as belonging to
    // cluster 0.
    expect(data.pointClusters).toEqual([0, undefined, 1])
  })
})

describe('encodings', () => {
  const frame = new DataFrame(PEOPLE)

  it('assigns categorical colours in first-seen order', () => {
    const { resolved } = encodeColors(frame, 4, { by: 'team', strategy: 'categorical' })
    expect(resolved.categories?.map((c) => c.value)).toEqual(['core', 'infra'])
    expect(resolved.categories?.[0]?.color).toBe(CATEGORICAL_PALETTE_DARK[0])
    expect(resolved.categories?.[1]?.color).toBe(CATEGORICAL_PALETTE_DARK[1])
  })

  it('infers categorical for a string column and continuous for a numeric one', () => {
    expect(encodeColors(frame, 4, { by: 'team' }).resolved.strategy).toBe('categorical')
    expect(encodeColors(frame, 4, { by: 'score' }).resolved.strategy).toBe('continuous')
  })

  it('clamps a continuous domain to percentiles so an outlier cannot flatten it', () => {
    // score = [10, 20, 30, 1000]. On the raw extent the first three values
    // would land within 2% of each other and be indistinguishable.
    const { resolved } = encodeColors(frame, 4, { by: 'score', strategy: 'continuous' })
    const [min, max] = resolved.domain as [number, number]
    expect(max).toBeLessThan(1000)
    expect(min).toBeGreaterThanOrEqual(10)
  })

  it('gives missing values the unknown colour, never a NaN channel', () => {
    // A NaN channel means "resolve the configured default" to the graph, which
    // would render a point with no data as though it were merely unstyled.
    const sparse = new DataFrame([{ team: 'core' }, {}])
    const { colors } = encodeColors(sparse, 2, { by: 'team', strategy: 'categorical' })
    for (const channel of colors) expect(Number.isNaN(channel)).toBe(false)
    expect(colors[4]).not.toBe(colors[0])
  })

  it('scales size by area, not radius', () => {
    // A point drawn twice as wide covers four times the screen, so mapping
    // magnitude to radius overstates large values fourfold.
    const values = new DataFrame([{ v: 0 }, { v: 1 }])
    const { sizes } = encodeSizes(values, 2, { by: 'v', range: [0, 100] }, 4)
    const midpoint = new DataFrame([{ v: 0 }, { v: 0.5 }, { v: 1 }])
    const mid = encodeSizes(midpoint, 3, { by: 'v', range: [0, 100] }, 4).sizes[1] as number
    expect(sizes[0]).toBe(0)
    expect(sizes[1]).toBe(100)
    // sqrt(0.5) ≈ 0.707, so the middle value sits well above the linear 50.
    expect(mid).toBeGreaterThan(60)
    expect(mid).toBeLessThan(75)
  })

  it('places the diverging midpoint at the centre of the ramp', () => {
    const values = new DataFrame([{ v: -10 }, { v: 0 }, { v: 10 }])
    const { colors } = encodeColors(values, 3, { by: 'v', strategy: 'diverging', midpoint: 0 })
    const at = (i: number): number[] => Array.from(colors.slice(i * 4, i * 4 + 4))
    // The poles differ from each other and from the neutral middle.
    expect(at(0)).not.toEqual(at(2))
    expect(at(1)).not.toEqual(at(0))
  })

  it('reads a column that already holds colours directly', () => {
    const colored = new DataFrame([{ c: '#ff0000' }, { c: 'rgb(0, 0, 255)' }])
    const { colors, resolved } = encodeColors(colored, 2, { by: 'c' })
    expect(resolved.strategy).toBe('direct')
    expect(Array.from(colors.slice(0, 4))).toEqual([1, 0, 0, 1])
    expect(Array.from(colors.slice(4, 8))).toEqual([0, 0, 1, 1])
  })

  it('lets an explicit function override the strategy entirely', () => {
    const { colors } = encodeColors(frame, 4, {
      by: 'score',
      fn: (value) => ((value as number) > 15 ? '#ffffff' : '#000000'),
    })
    expect(Array.from(colors.slice(0, 3))).toEqual([0, 0, 0])
    expect(Array.from(colors.slice(4, 7))).toEqual([1, 1, 1])
  })

  it('colours by degree from the graph rather than from a column', () => {
    const { colors } = encodeColors(frame, 4, { strategy: 'degree' }, [0, 5, 10, 0])
    const first = Array.from(colors.slice(0, 4))
    const third = Array.from(colors.slice(8, 12))
    expect(first).not.toEqual(third)
  })
})

describe('DataFrame', () => {
  const frame = new DataFrame(PEOPLE)

  it('detects column types, reading numeric strings as numbers', () => {
    expect(frame.type('score')).toBe('number')
    expect(frame.type('team')).toBe('string')
    // CSV-derived data arrives numeric-as-string; reading it as a category
    // would produce one colour per distinct value.
    expect(new DataFrame([{ n: '1' }, { n: '2.5' }]).type('n')).toBe('number')
  })

  it('unions column names across sparse records', () => {
    const sparse = new DataFrame([{ a: 1 }, { b: 2 }])
    expect(sparse.columns).toContain('a')
    expect(sparse.columns).toContain('b')
  })

  it('reports NaN for missing numeric values rather than zero', () => {
    // Zero is a legitimate value and would silently join the data.
    const sparse = new DataFrame([{ v: 5 }, {}])
    expect(Number.isNaN(sparse.numeric('v')[1] as number)).toBe(true)
  })

  it('computes percentiles and a histogram', () => {
    expect(frame.percentile('score', 0)).toBe(10)
    expect(frame.percentile('score', 1)).toBe(1000)
    const histogram = frame.histogram('score', 4)
    expect(histogram?.counts).toHaveLength(4)
    expect(histogram?.edges).toHaveLength(5)
    // Every finite value must land in a bin — the top value included.
    const total = [...(histogram?.counts ?? [])].reduce((a, b) => a + b, 0)
    expect(total).toBe(4)
  })

  it('survives a column whose values are all identical', () => {
    const flat = new DataFrame([{ v: 7 }, { v: 7 }])
    const histogram = flat.histogram('v', 4)
    expect(histogram).toBeDefined()
    expect([...(histogram?.counts ?? [])].reduce((a, b) => a + b, 0)).toBe(2)
  })
})
