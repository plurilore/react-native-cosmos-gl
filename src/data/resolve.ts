import { SeededRandom } from '../core/helper'
import { PointShape } from '../core/enums'
import type { Rgba } from '../core/color'
import { DataFrame, type Row } from './data-frame'
import {
  encodeColors,
  encodeSizes,
  encodeLinkWidths,
  type ColorStrategy,
  type SizeStrategy,
  type LinkWidthStrategy,
  type ResolvedColorEncoding,
  type ResolvedSizeEncoding,
} from './encode'

/**
 * How columns of a record set map onto the graph's channels.
 *
 * This is the whole of the data-aware layer's input. Everything it produces is
 * derived from these mappings plus the records themselves, which is what keeps
 * `resolveGraphData` a pure function that can be tested without a GPU.
 */
export type GraphDataMapping = {
  pointData?: Row[]
  linkData?: Row[]

  pointIdBy?: string
  linkSourceBy?: string
  linkTargetBy?: string

  /**
   * Column already holding each point's row index.
   *
   * When the caller has computed indices, naming them here skips the id lookup
   * entirely — links resolve by reading a number instead of hashing a string
   * per endpoint. Falls back to id resolution for any row whose index is
   * missing or out of range, so a partially-indexed dataset still works.
   */
  pointIndexBy?: string
  /** Columns holding link endpoints as point indices rather than ids. */
  linkSourceIndexBy?: string
  linkTargetIndexBy?: string

  pointXBy?: string
  pointYBy?: string

  pointColorBy?: string
  pointColorStrategy?: ColorStrategy
  pointColorPalette?: string[]
  pointColorMap?: Record<string, string | Rgba>
  pointColorByFn?: (value: unknown, index: number) => string | Rgba
  pointColorMidpoint?: number

  pointSizeBy?: string
  pointSizeStrategy?: SizeStrategy
  pointSizeRange?: [number, number]
  pointSizeByFn?: (value: unknown, index: number) => number

  pointLabelBy?: string
  pointLabelWeightBy?: string
  pointShapeBy?: string

  pointClusterBy?: string
  pointClusterStrengthBy?: string
  clusterPositionsMap?: Record<string, [number, number]>

  linkColorBy?: string
  linkColorStrategy?: ColorStrategy
  linkColorPalette?: string[]
  linkColorByFn?: (value: unknown, index: number) => string | Rgba

  linkWidthBy?: string
  linkWidthRange?: [number, number]
  linkWidthByFn?: (value: unknown, index: number) => number
  /**
   * How links sharing an ordered source→target pair combine into one width.
   * Defaults to `direct` (no aggregation); `sum` matches Cosmograph.
   */
  linkWidthStrategy?: LinkWidthStrategy

  linkStrengthBy?: string
  linkStrengthRange?: [number, number]

  /** Extent of the simulation space, for the initial scatter. */
  spaceSize?: number
  /** Makes the initial scatter reproducible. */
  randomSeed?: number | string
  /** Fallback point size when nothing resolves one. */
  pointDefaultSize?: number
}

export type GraphDataStats = {
  pointsCount: number
  linksCount: number
  /** Links dropped because an endpoint id matched no point. */
  unresolvedLinksCount: number
}

export type ResolvedGraphData = {
  pointPositions: Float32Array
  links?: Float32Array
  pointColors?: Float32Array
  pointSizes?: Float32Array
  pointShapes?: Float32Array
  linkColors?: Float32Array
  linkWidths?: Float32Array
  linkStrength?: Float32Array
  pointClusters?: (number | undefined)[]
  clusterPositions?: (number | undefined)[]
  pointClusterStrength?: Float32Array

  /** Point id per index, when `pointIdBy` was given. */
  pointIds?: (string | undefined)[]
  /** Reverse lookup, for resolving ids the caller supplies later. */
  idToIndex?: Map<string, number>
  /** Label per point, when `pointLabelBy` was given. */
  pointLabels?: (string | undefined)[]
  /**
   * Ranking weight per point, used to choose which labels to show. Always
   * present: with no weight column it falls back to degree.
   */
  pointLabelWeights: Float64Array
  /** Link count per point, computed from the resolved links. */
  degrees: number[]
  /** Cluster value per cluster index, for legends. */
  clusterValues?: string[]

  colorEncoding?: ResolvedColorEncoding
  sizeEncoding?: ResolvedSizeEncoding
  linkColorEncoding?: ResolvedColorEncoding
  linkWidthEncoding?: ResolvedSizeEncoding

  /** The point frame, kept so histograms and search can query it. */
  pointFrame: DataFrame
  linkFrame?: DataFrame
  stats: GraphDataStats
}

const DEFAULT_SPACE_SIZE = 4096
const DEFAULT_POINT_SIZE = 4
/** Cosmograph's `linkStrengthRange`, and the range the simulation is tuned for. */
const DEFAULT_LINK_STRENGTH_RANGE: [number, number] = [0.2, 1]

/** Shapes assigned in order when `pointShapeBy` is used. `None` is excluded. */
const SHAPE_SEQUENCE: PointShape[] = [
  PointShape.Circle,
  PointShape.Square,
  PointShape.Triangle,
  PointShape.Diamond,
  PointShape.Pentagon,
  PointShape.Hexagon,
  PointShape.Star,
  PointShape.Cross,
]

/**
 * Turns records and column mappings into the typed arrays the graph consumes.
 *
 * Pure: same input, same output, no GPU and no React. That is deliberate —
 * it makes the interesting part of the data layer (id resolution, encoding,
 * degree computation) testable on its own, and lets callers who drive `Graph`
 * directly use it without the component.
 */
export function resolveGraphData (mapping: GraphDataMapping): ResolvedGraphData {
  const pointRows = mapping.pointData ?? []
  const pointFrame = new DataFrame(pointRows)
  const count = pointFrame.length
  const spaceSize = mapping.spaceSize ?? DEFAULT_SPACE_SIZE

  const { pointIds, idToIndex } = buildIdIndex(pointFrame, mapping.pointIdBy)
  validatePointIndexColumn(pointFrame, mapping.pointIndexBy)
  const pointPositions = buildPositions(pointFrame, mapping, count, spaceSize)

  const linkRows = mapping.linkData
  const linkFrame = linkRows ? new DataFrame(linkRows) : undefined
  const { links, keptRows, unresolvedLinksCount } = resolveLinks(linkFrame, mapping, idToIndex, count)

  // Degrees come from the *resolved* links, so a link dropped for an unknown
  // endpoint does not inflate a degree-based encoding.
  const degrees = computeDegrees(links, count)

  // Link encodings must be indexed by kept link, not by input row: dropping a
  // link shifts every index after it, and colouring by the original row order
  // would misalign every link past the first bad one.
  const keptLinkFrame = linkFrame && keptRows
    ? new DataFrame(keptRows.map((row) => linkRows?.[row] ?? {}))
    : linkFrame

  const colorResult = hasColorEncoding(mapping)
    ? encodeColors(pointFrame, count, {
      strategy: mapping.pointColorStrategy,
      by: mapping.pointColorBy,
      palette: mapping.pointColorPalette,
      map: mapping.pointColorMap,
      fn: mapping.pointColorByFn,
      midpoint: mapping.pointColorMidpoint,
    }, degrees)
    : undefined

  const sizeResult = hasSizeEncoding(mapping)
    ? encodeSizes(pointFrame, count, {
      strategy: mapping.pointSizeStrategy,
      by: mapping.pointSizeBy,
      range: mapping.pointSizeRange,
      fn: mapping.pointSizeByFn,
    }, mapping.pointDefaultSize ?? DEFAULT_POINT_SIZE, degrees)
    : undefined

  const linksCount = links ? links.length / 2 : 0
  const linkColorResult = keptLinkFrame && hasLinkColorEncoding(mapping)
    ? encodeColors(keptLinkFrame, linksCount, {
      strategy: mapping.linkColorStrategy,
      by: mapping.linkColorBy,
      palette: mapping.linkColorPalette,
      fn: mapping.linkColorByFn,
    })
    : undefined

  const linkWidthResult = keptLinkFrame && (mapping.linkWidthBy || mapping.linkWidthByFn)
    ? encodeLinkWidths(keptLinkFrame, linksCount, {
      by: mapping.linkWidthBy,
      range: mapping.linkWidthRange,
      fn: mapping.linkWidthByFn,
      aggregate: mapping.linkWidthStrategy,
    }, links, 1)
    : undefined

  // Symmetric-log over the column's full extent, which is what a strength
  // column means: its own endpoints are the interesting ones, so there is
  // nothing here for a percentile band to protect against.
  const linkStrength = keptLinkFrame && mapping.linkStrengthBy
    ? encodeSizes(keptLinkFrame, linksCount, {
      strategy: 'symlog',
      by: mapping.linkStrengthBy,
      range: mapping.linkStrengthRange ?? DEFAULT_LINK_STRENGTH_RANGE,
    }, 1).sizes
    : undefined

  const clusters = buildClusters(pointFrame, mapping, count)

  return {
    pointPositions,
    links,
    pointColors: colorResult?.colors,
    pointSizes: sizeResult?.sizes,
    pointShapes: buildShapes(pointFrame, mapping.pointShapeBy, count),
    linkColors: linkColorResult?.colors,
    linkWidths: linkWidthResult?.sizes,
    linkStrength,
    pointClusters: clusters.pointClusters,
    clusterPositions: clusters.clusterPositions,
    pointClusterStrength: clusters.pointClusterStrength,
    clusterValues: clusters.clusterValues,

    pointIds,
    idToIndex,
    pointLabels: mapping.pointLabelBy ? pointFrame.strings(mapping.pointLabelBy) : undefined,
    pointLabelWeights: buildLabelWeights(pointFrame, mapping.pointLabelWeightBy, degrees, count),
    degrees,

    colorEncoding: colorResult?.resolved,
    sizeEncoding: sizeResult?.resolved,
    linkColorEncoding: linkColorResult?.resolved,
    linkWidthEncoding: linkWidthResult?.resolved,

    pointFrame,
    linkFrame: keptLinkFrame,
    stats: { pointsCount: count, linksCount, unresolvedLinksCount },
  }
}

function hasColorEncoding (mapping: GraphDataMapping): boolean {
  return Boolean(mapping.pointColorBy || mapping.pointColorByFn || mapping.pointColorMap ||
    mapping.pointColorStrategy)
}

function hasSizeEncoding (mapping: GraphDataMapping): boolean {
  return Boolean(mapping.pointSizeBy || mapping.pointSizeByFn || mapping.pointSizeStrategy)
}

function hasLinkColorEncoding (mapping: GraphDataMapping): boolean {
  return Boolean(mapping.linkColorBy || mapping.linkColorByFn || mapping.linkColorStrategy)
}

function buildIdIndex (
  frame: DataFrame,
  pointIdBy: string | undefined
): { pointIds?: (string | undefined)[]; idToIndex?: Map<string, number> } {
  if (!pointIdBy) return {}
  const pointIds = frame.strings(pointIdBy)
  const idToIndex = new Map<string, number>()
  for (let i = 0; i < pointIds.length; i++) {
    const id = pointIds[i]
    if (id === undefined) continue
    // First occurrence wins. A duplicate id is the caller's bug, but silently
    // remapping every link to the *last* duplicate would be a stranger failure
    // than consistently resolving to the first.
    if (!idToIndex.has(id)) idToIndex.set(id, i)
  }
  return { pointIds, idToIndex }
}

/**
 * Point positions: the given coordinates, or a deterministic scatter.
 *
 * A scatter rather than a single origin because coincident points feel no
 * repulsion from each other — the force is zero at zero distance — so a graph
 * started from one point would never separate.
 */
function buildPositions (
  frame: DataFrame,
  mapping: GraphDataMapping,
  count: number,
  spaceSize: number
): Float32Array {
  const positions = new Float32Array(count * 2)
  const { pointXBy, pointYBy } = mapping

  if (pointXBy && pointYBy && frame.has(pointXBy) && frame.has(pointYBy)) {
    const xs = frame.numeric(pointXBy)
    const ys = frame.numeric(pointYBy)
    const random = new SeededRandom(mapping.randomSeed ?? 'cosmos')
    for (let i = 0; i < count; i++) {
      const x = xs[i] as number
      const y = ys[i] as number
      // A row missing a coordinate gets scattered rather than pinned at the
      // origin, where it would sit in a pile with every other incomplete row.
      positions[i * 2] = Number.isFinite(x) ? x : random.float(0, spaceSize)
      positions[i * 2 + 1] = Number.isFinite(y) ? y : random.float(0, spaceSize)
    }
    return positions
  }

  const random = new SeededRandom(mapping.randomSeed ?? 'cosmos')
  for (let i = 0; i < count; i++) {
    positions[i * 2] = random.float(0, spaceSize)
    positions[i * 2 + 1] = random.float(0, spaceSize)
  }
  return positions
}

/**
 * Resolves link endpoints from ids to point indices.
 *
 * Links naming an unknown point are dropped rather than pointed at index 0,
 * which would draw an edge to an unrelated point and quietly distort the
 * layout. `keptRows` records which input rows survived so per-link encodings
 * stay aligned.
 */
function resolveLinks (
  frame: DataFrame | undefined,
  mapping: GraphDataMapping,
  idToIndex: Map<string, number> | undefined,
  pointsCount: number
): { links?: Float32Array; keptRows?: number[]; unresolvedLinksCount: number } {
  if (!frame || frame.length === 0) return { unresolvedLinksCount: 0 }

  const { linkSourceBy, linkTargetBy, linkSourceIndexBy, linkTargetIndexBy } = mapping

  // The index columns are the fast path when present: resolving an endpoint
  // becomes a bounds check rather than a hash lookup.
  const sourceIndices = linkSourceIndexBy && frame.has(linkSourceIndexBy)
    ? frame.numeric(linkSourceIndexBy)
    : undefined
  const targetIndices = linkTargetIndexBy && frame.has(linkTargetIndexBy)
    ? frame.numeric(linkTargetIndexBy)
    : undefined

  if (sourceIndices && targetIndices) {
    const resolved: number[] = []
    const keptRows: number[] = []
    let unresolved = 0
    for (let i = 0; i < frame.length; i++) {
      const source = sourceIndices[i] as number
      const target = targetIndices[i] as number
      if (!isPointIndexInRange(source, pointsCount) || !isPointIndexInRange(target, pointsCount)) {
        unresolved++
        continue
      }
      resolved.push(source, target)
      keptRows.push(i)
    }
    return { links: Float32Array.from(resolved), keptRows, unresolvedLinksCount: unresolved }
  }

  if (!linkSourceBy || !linkTargetBy) {
    console.warn(
      'Links were supplied without `linkSourceBy` / `linkTargetBy`, so there is no way to tell ' +
      'which columns hold the endpoints. Links ignored.'
    )
    return { unresolvedLinksCount: frame.length }
  }

  const sources = frame.strings(linkSourceBy)
  const targets = frame.strings(linkTargetBy)
  const resolved: number[] = []
  const keptRows: number[] = []
  let unresolved = 0

  for (let i = 0; i < frame.length; i++) {
    const source = resolveEndpoint(sources[i], idToIndex, pointsCount)
    const target = resolveEndpoint(targets[i], idToIndex, pointsCount)
    if (source === undefined || target === undefined) {
      unresolved++
      continue
    }
    resolved.push(source, target)
    keptRows.push(i)
  }

  return { links: Float32Array.from(resolved), keptRows, unresolvedLinksCount: unresolved }
}

/**
 * An endpoint is either an id to look up or, with no id column configured, a
 * point index written directly.
 */
function isPointIndexInRange (value: number, pointsCount: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < pointsCount
}

function resolveEndpoint (
  value: string | undefined,
  idToIndex: Map<string, number> | undefined,
  pointsCount: number
): number | undefined {
  if (value === undefined) return undefined
  if (idToIndex) return idToIndex.get(value)
  const index = Number(value)
  if (!Number.isInteger(index) || index < 0 || index >= pointsCount) return undefined
  return index
}

function computeDegrees (links: Float32Array | undefined, count: number): number[] {
  const degrees = new Array<number>(count).fill(0)
  if (!links) return degrees
  for (let i = 0; i < links.length; i += 2) {
    const source = links[i] as number
    const target = links[i + 1] as number
    degrees[source] = (degrees[source] ?? 0) + 1
    degrees[target] = (degrees[target] ?? 0) + 1
  }
  return degrees
}

function buildShapes (
  frame: DataFrame,
  pointShapeBy: string | undefined,
  count: number
): Float32Array | undefined {
  if (!pointShapeBy || !frame.has(pointShapeBy)) return undefined
  const categories = frame.categories(pointShapeBy)
  const lookup = new Map<string, number>()
  categories.forEach((value, index) => {
    lookup.set(value, SHAPE_SEQUENCE[index % SHAPE_SEQUENCE.length] as number)
  })

  const values = frame.strings(pointShapeBy)
  const shapes = new Float32Array(count).fill(PointShape.Circle)
  for (let i = 0; i < count; i++) {
    const value = values[i]
    if (value !== undefined) shapes[i] = lookup.get(value) ?? PointShape.Circle
  }
  return shapes
}

/**
 * Weight deciding which labels survive when there is not room for all of them.
 * Degree by default: in a graph, the best-connected points are the ones worth
 * naming.
 */
function buildLabelWeights (
  frame: DataFrame,
  column: string | undefined,
  degrees: number[],
  count: number
): Float64Array {
  const weights = new Float64Array(count)
  if (column && frame.has(column)) {
    const values = frame.numeric(column)
    for (let i = 0; i < count; i++) {
      const value = values[i] as number
      weights[i] = Number.isFinite(value) ? value : 0
    }
    return weights
  }
  for (let i = 0; i < count; i++) weights[i] = degrees[i] ?? 0
  return weights
}

function buildClusters (
  frame: DataFrame,
  mapping: GraphDataMapping,
  count: number
): {
  pointClusters?: (number | undefined)[]
  clusterPositions?: (number | undefined)[]
  pointClusterStrength?: Float32Array
  clusterValues?: string[]
} {
  const column = mapping.pointClusterBy
  if (!column || !frame.has(column)) return {}

  const clusterValues = frame.categories(column)
  const lookup = new Map<string, number>()
  clusterValues.forEach((value, index) => lookup.set(value, index))

  const values = frame.strings(column)
  const pointClusters = new Array<number | undefined>(count)
  for (let i = 0; i < count; i++) {
    const value = values[i]
    // `undefined` means unclustered, which the force reads as "no pull" —
    // different from belonging to a cluster that happens to be empty.
    pointClusters[i] = value === undefined ? undefined : lookup.get(value)
  }

  let clusterPositions: (number | undefined)[] | undefined
  if (mapping.clusterPositionsMap) {
    clusterPositions = new Array<number | undefined>(clusterValues.length * 2)
    clusterValues.forEach((value, index) => {
      const position = mapping.clusterPositionsMap?.[value]
      clusterPositions![index * 2] = position?.[0]
      clusterPositions![index * 2 + 1] = position?.[1]
    })
  }

  let pointClusterStrength: Float32Array | undefined
  const strengthColumn = mapping.pointClusterStrengthBy
  if (strengthColumn && frame.has(strengthColumn)) {
    const raw = frame.numeric(strengthColumn)
    pointClusterStrength = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      const value = raw[i] as number
      pointClusterStrength[i] = Number.isFinite(value) ? value : 1
    }
  }

  return { pointClusters, clusterPositions, pointClusterStrength, clusterValues }
}


/**
 * Checks that a supplied index column really is the row order.
 *
 * The whole value of `pointIndexBy` is that an index can be trusted without a
 * lookup, so a column that disagrees with row order would silently mis-resolve
 * every link that uses it. Rather than reordering the data — which would move
 * points out from under every other array the caller passed — this reports the
 * mismatch and leaves the id path to handle it.
 */
function validatePointIndexColumn (frame: DataFrame, column: string | undefined): void {
  if (!column || !frame.has(column)) return
  const values = frame.numeric(column)
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== i) {
      console.warn(
        `\`pointIndexBy\` column "${column}" does not match row order (row ${i} holds ` +
        `${String(values[i])}). Links will be resolved by id instead. The column must be a ` +
        'sequential integer starting at 0 for the index fast path to be safe.'
      )
      return
    }
  }
}
