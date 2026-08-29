/**
 * A small columnar view over an array of records.
 *
 * The graph layer wants typed arrays, one value per point, and the caller has
 * an array of objects. Converting on every read would walk the objects again
 * for every encoding; converting once and caching per column means a 100k-row
 * dataset is traversed once per column that is actually used, and never again.
 *
 * This is also where the web library reaches for DuckDB. That is the right
 * answer for SQL over files in a browser; it is the wrong answer for a phone
 * rendering data it already holds in memory, so the operations the encodings
 * genuinely need — extents, categories, percentiles, histograms — are computed
 * directly here instead.
 */

export type Row = Record<string, unknown>

export type ColumnType = 'number' | 'string' | 'boolean' | 'date' | 'mixed' | 'empty'

export type Histogram = {
  /** Bin counts. */
  counts: Uint32Array
  /** `counts.length + 1` bin boundaries. */
  edges: Float64Array
}

/** How many rows to inspect when guessing a column's type. */
const TYPE_SAMPLE_SIZE = 200

export class DataFrame {
  public readonly rows: readonly Row[]

  private readonly columnNames: string[]
  private readonly typeCache = new Map<string, ColumnType>()
  private readonly numericCache = new Map<string, Float64Array>()
  private readonly stringCache = new Map<string, (string | undefined)[]>()
  private readonly extentCache = new Map<string, [number, number] | undefined>()
  private readonly categoryCache = new Map<string, string[]>()

  public constructor (rows: readonly Row[]) {
    this.rows = rows
    // Union of keys across a sample rather than just the first row: records
    // from a real source are often sparse, and a column that happens to be
    // missing from row 0 still needs to be addressable.
    const names = new Set<string>()
    const limit = Math.min(rows.length, TYPE_SAMPLE_SIZE)
    for (let i = 0; i < limit; i++) {
      const row = rows[i]
      if (row) for (const key in row) names.add(key)
    }
    this.columnNames = [...names]
  }

  public get length (): number {
    return this.rows.length
  }

  public get columns (): readonly string[] {
    return this.columnNames
  }

  public has (column: string): boolean {
    return this.columnNames.includes(column)
  }

  /**
   * The column's type, guessed from a sample of non-null values. `'mixed'` when
   * the sample disagrees — which encodings treat as categorical, since that is
   * the only reading that is always safe.
   */
  public type (column: string): ColumnType {
    const cached = this.typeCache.get(column)
    if (cached) return cached

    let seen: ColumnType | undefined
    let count = 0
    for (let i = 0; i < this.rows.length && count < TYPE_SAMPLE_SIZE; i++) {
      const value = this.rows[i]?.[column]
      if (value === undefined || value === null || value === '') continue
      count++
      const type = typeOf(value)
      if (seen === undefined) seen = type
      else if (seen !== type) {
        seen = 'mixed'
        break
      }
    }

    const result = seen ?? 'empty'
    this.typeCache.set(column, result)
    return result
  }

  /**
   * The column as `Float64Array`, with `NaN` wherever a value is missing or not
   * numeric. `NaN` rather than `0` because zero is a legitimate value and would
   * silently join the data.
   */
  public numeric (column: string): Float64Array {
    const cached = this.numericCache.get(column)
    if (cached) return cached

    const out = new Float64Array(this.rows.length)
    for (let i = 0; i < this.rows.length; i++) {
      out[i] = toNumber(this.rows[i]?.[column])
    }
    this.numericCache.set(column, out)
    return out
  }

  /** The column as strings, with `undefined` for missing values. */
  public strings (column: string): (string | undefined)[] {
    const cached = this.stringCache.get(column)
    if (cached) return cached

    const out = new Array<string | undefined>(this.rows.length)
    for (let i = 0; i < this.rows.length; i++) {
      const value = this.rows[i]?.[column]
      out[i] = value === undefined || value === null ? undefined : String(value)
    }
    this.stringCache.set(column, out)
    return out
  }

  public value (row: number, column: string): unknown {
    return this.rows[row]?.[column]
  }

  /** Finite `[min, max]`, or `undefined` when the column holds no finite value. */
  public extent (column: string): [number, number] | undefined {
    if (this.extentCache.has(column)) return this.extentCache.get(column)

    const values = this.numeric(column)
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < values.length; i++) {
      const value = values[i] as number
      if (!Number.isFinite(value)) continue
      if (value < min) min = value
      if (value > max) max = value
    }

    const result: [number, number] | undefined = Number.isFinite(min) ? [min, max] : undefined
    this.extentCache.set(column, result)
    return result
  }

  /**
   * Distinct values in first-seen order.
   *
   * First-seen rather than sorted so a palette assigns colors in the order the
   * data presents them — which keeps the mapping stable when rows are appended,
   * where sorting would reshuffle every color as soon as a new category sorts
   * into the middle.
   */
  public categories (column: string): string[] {
    const cached = this.categoryCache.get(column)
    if (cached) return cached

    const seen = new Set<string>()
    const result: string[] = []
    const values = this.strings(column)
    for (let i = 0; i < values.length; i++) {
      const value = values[i]
      if (value === undefined) continue
      if (seen.has(value)) continue
      seen.add(value)
      result.push(value)
    }
    this.categoryCache.set(column, result)
    return result
  }

  /**
   * A percentile of the column's finite values, `p` in `0..1`.
   *
   * Continuous scales clamp to an inner percentile range rather than the raw
   * extent: one outlier three orders of magnitude out would otherwise compress
   * every other value into the first swatch of the palette.
   */
  public percentile (column: string, p: number): number | undefined {
    const sorted = this.sortedFinite(column)
    if (sorted.length === 0) return undefined
    const position = (sorted.length - 1) * Math.min(Math.max(p, 0), 1)
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    const low = sorted[lower] as number
    if (lower === upper) return low
    const high = sorted[upper] as number
    return low + (high - low) * (position - lower)
  }

  /** Bin counts over the column's finite values. */
  public histogram (column: string, binCount = 32, range?: [number, number]): Histogram | undefined {
    const extent = range ?? this.extent(column)
    if (!extent) return undefined
    const bins = Math.max(1, Math.floor(binCount))
    const [min, max] = extent

    const edges = new Float64Array(bins + 1)
    // A degenerate range would give every value the same bin and a zero-width
    // axis; widen it so the single populated bin still has somewhere to sit.
    const span = max > min ? max - min : 1
    const start = max > min ? min : min - 0.5
    for (let i = 0; i <= bins; i++) edges[i] = start + (span * i) / bins

    const counts = new Uint32Array(bins)
    const values = this.numeric(column)
    for (let i = 0; i < values.length; i++) {
      const value = values[i] as number
      if (!Number.isFinite(value) || value < min || value > max) continue
      // The final bin is closed at the top, so the maximum lands inside it
      // rather than one past the end.
      const bin = Math.min(bins - 1, Math.floor(((value - start) / span) * bins))
      counts[bin] = (counts[bin] as number) + 1
    }

    return { counts, edges }
  }

  private readonly sortedCache = new Map<string, Float64Array>()

  private sortedFinite (column: string): Float64Array {
    const cached = this.sortedCache.get(column)
    if (cached) return cached

    const values = this.numeric(column)
    const finite = new Float64Array(values.length)
    let count = 0
    for (let i = 0; i < values.length; i++) {
      const value = values[i] as number
      if (Number.isFinite(value)) finite[count++] = value
    }
    const sorted = finite.subarray(0, count)
    sorted.sort()
    this.sortedCache.set(column, sorted)
    return sorted
  }
}

function typeOf (value: unknown): ColumnType {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (value instanceof Date) return 'date'
  if (typeof value === 'string') {
    // A numeric string is treated as a number: CSV-derived data routinely
    // arrives this way, and reading it as a category would produce one colour
    // per distinct value.
    if (value.trim() !== '' && Number.isFinite(Number(value))) return 'number'
    return 'string'
  }
  return 'mixed'
}

function toNumber (value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : NaN
  }
  return NaN
}
