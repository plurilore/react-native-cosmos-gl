import { getRgbaColor, type Rgba } from '../core/color'
import { DataFrame } from './data-frame'
import {
  CATEGORICAL_PALETTE_DARK,
  SEQUENTIAL_PALETTE,
  DIVERGING_PALETTE,
  UNKNOWN_COLOR,
  CONTINUOUS_PERCENTILE_MIN,
  CONTINUOUS_PERCENTILE_MAX,
} from './palettes'

/**
 * How a column becomes a color.
 *
 * - `categorical` — one palette slot per distinct value, assigned in first-seen
 *   order so a value keeps its color as data changes.
 * - `continuous` — position along a single-hue ramp, clamped to an inner
 *   percentile range so outliers cannot flatten everything else.
 * - `diverging` — distance either side of a midpoint, through a neutral middle.
 * - `degree` — like `continuous`, but over each point's link count rather than a
 *   column. The one encoding that comes from the graph's structure rather than
 *   its data.
 * - `direct` — the column already holds colors (CSS strings or RGBA arrays).
 * - `map` — an explicit value → color lookup the caller supplies.
 */
export type ColorStrategy = 'categorical' | 'continuous' | 'diverging' | 'degree' | 'direct' | 'map'

/** How a column becomes a size or width. */
export type SizeStrategy = 'continuous' | 'degree' | 'direct'

export type ColorEncoding = {
  strategy?: ColorStrategy
  /** Column to read. Omitted for `degree`, which reads the graph. */
  by?: string
  palette?: readonly string[]
  /** Explicit lookup for `map`. */
  map?: Record<string, string | Rgba>
  /** Derives a color from the raw value, bypassing the strategy. */
  fn?: (value: unknown, index: number) => string | Rgba
  /** Midpoint for `diverging`. Defaults to zero. */
  midpoint?: number
}

export type SizeEncoding = {
  strategy?: SizeStrategy
  by?: string
  /** `[min, max]` output range. */
  range?: [number, number]
  fn?: (value: unknown, index: number) => number
}

/** What an encoding resolved to, for the legend to describe. */
export type ResolvedColorEncoding = {
  strategy: ColorStrategy
  /** Populated for `categorical` and `map`: the value → color pairs, in order. */
  categories?: { value: string; color: string }[]
  /** Populated for `continuous`, `diverging` and `degree`. */
  domain?: [number, number]
  palette?: readonly string[]
}

export type ResolvedSizeEncoding = {
  strategy: SizeStrategy
  domain?: [number, number]
  range: [number, number]
}

const DEFAULT_SIZE_RANGE: [number, number] = [2, 9]
const DEFAULT_WIDTH_RANGE: [number, number] = [1, 9]

/**
 * Picks a strategy when the caller did not.
 *
 * The choice follows the data's type, which is almost always what was meant: a
 * numeric column is a magnitude, a string column is an identity, and a column
 * that already holds colors should be used verbatim.
 */
function inferColorStrategy (frame: DataFrame, encoding: ColorEncoding): ColorStrategy {
  if (encoding.strategy) return encoding.strategy
  if (encoding.map) return 'map'
  if (!encoding.by) return 'categorical'

  const type = frame.type(encoding.by)
  if (type === 'number' || type === 'date') return 'continuous'
  if (type === 'string' && looksLikeColors(frame, encoding.by)) return 'direct'
  return 'categorical'
}

/** Whether a string column's first few values parse as colors. */
function looksLikeColors (frame: DataFrame, column: string): boolean {
  const values = frame.strings(column)
  let checked = 0
  for (let i = 0; i < values.length && checked < 8; i++) {
    const value = values[i]
    if (value === undefined) continue
    checked++
    // `getRgbaColor` falls back to opaque black rather than failing, so the
    // test has to be on the syntax rather than on the result.
    if (!/^(#|rgb|hsl)/i.test(value.trim())) return false
  }
  return checked > 0
}

/**
 * Builds the per-point RGBA array the graph consumes.
 *
 * `NaN` is deliberately never written here: the graph reads a `NaN` channel as
 * "resolve the configured default", and a point whose encoding value is missing
 * should read as *unknown* — a specific, visible state — rather than silently
 * inheriting the default color of a styled point.
 */
export function encodeColors (
  frame: DataFrame,
  count: number,
  encoding: ColorEncoding,
  degrees?: readonly number[]
): { colors: Float32Array; resolved: ResolvedColorEncoding } {
  const colors = new Float32Array(count * 4)
  const strategy = inferColorStrategy(frame, encoding)
  const unknown = getRgbaColor(UNKNOWN_COLOR)

  const write = (index: number, rgba: Rgba): void => {
    colors[index * 4] = rgba[0]
    colors[index * 4 + 1] = rgba[1]
    colors[index * 4 + 2] = rgba[2]
    colors[index * 4 + 3] = rgba[3]
  }

  // An explicit function wins over any strategy: the caller has said exactly
  // what they want and the column's type stops mattering.
  if (encoding.fn) {
    const column = encoding.by
    for (let i = 0; i < count; i++) {
      const value = column ? frame.value(i, column) : i
      write(i, getRgbaColor(encoding.fn(value, i)))
    }
    return { colors, resolved: { strategy } }
  }

  switch (strategy) {
    case 'direct': {
      const values = encoding.by ? frame.strings(encoding.by) : []
      for (let i = 0; i < count; i++) {
        const value = values[i]
        write(i, value === undefined ? unknown : getRgbaColor(value))
      }
      return { colors, resolved: { strategy } }
    }

    case 'map': {
      const lookup = encoding.map ?? {}
      const values = encoding.by ? frame.strings(encoding.by) : []
      const cache = new Map<string, Rgba>()
      const categories: { value: string; color: string }[] = []
      for (const [key, color] of Object.entries(lookup)) {
        cache.set(key, getRgbaColor(color))
        categories.push({ value: key, color: typeof color === 'string' ? color : rgbaToCss(color) })
      }
      for (let i = 0; i < count; i++) {
        const value = values[i]
        write(i, (value !== undefined && cache.get(value)) || unknown)
      }
      return { colors, resolved: { strategy, categories } }
    }

    case 'categorical': {
      const palette = encoding.palette ?? CATEGORICAL_PALETTE_DARK
      const column = encoding.by
      if (!column) {
        const first = getRgbaColor(palette[0] ?? UNKNOWN_COLOR)
        for (let i = 0; i < count; i++) write(i, first)
        return { colors, resolved: { strategy, palette } }
      }

      const categoryNames = frame.categories(column)
      const values = frame.strings(column)
      const cache = new Map<string, Rgba>()
      const categories: { value: string; color: string }[] = []
      categoryNames.forEach((name, index) => {
        // Slots are assigned in order and wrap only once exhausted. Wrapping
        // makes two categories share a color, which is why the palette
        // documents how many stay distinguishable.
        const css = palette[index % palette.length] ?? UNKNOWN_COLOR
        cache.set(name, getRgbaColor(css))
        categories.push({ value: name, color: css })
      })

      for (let i = 0; i < count; i++) {
        const value = values[i]
        write(i, (value !== undefined && cache.get(value)) || unknown)
      }
      return { colors, resolved: { strategy, categories, palette } }
    }

    case 'degree':
    case 'continuous':
    case 'diverging': {
      const palette = encoding.palette ??
        (strategy === 'diverging' ? DIVERGING_PALETTE : SEQUENTIAL_PALETTE)
      const values = strategy === 'degree'
        ? degreesToFloat64(degrees, count)
        : encoding.by ? frame.numeric(encoding.by) : new Float64Array(count)

      const domain = strategy === 'degree' || !encoding.by
        ? finiteExtent(values)
        : percentileDomain(frame, encoding.by)

      if (!domain) {
        for (let i = 0; i < count; i++) write(i, unknown)
        return { colors, resolved: { strategy, palette } }
      }

      const ramp = palette.map((css) => getRgbaColor(css))
      const midpoint = encoding.midpoint ?? 0
      for (let i = 0; i < count; i++) {
        const value = values[i] as number
        if (!Number.isFinite(value)) {
          write(i, unknown)
          continue
        }
        const t = strategy === 'diverging'
          ? divergingPosition(value, domain, midpoint)
          : normalize(value, domain)
        write(i, sampleRamp(ramp, t))
      }
      return { colors, resolved: { strategy, domain, palette } }
    }
  }
}

/** Builds the per-point size (or per-link width) array. */
export function encodeSizes (
  frame: DataFrame,
  count: number,
  encoding: SizeEncoding,
  defaultValue: number,
  degrees?: readonly number[],
  isWidth = false
): { sizes: Float32Array; resolved: ResolvedSizeEncoding } {
  const sizes = new Float32Array(count)
  const range = encoding.range ?? (isWidth ? DEFAULT_WIDTH_RANGE : DEFAULT_SIZE_RANGE)
  const strategy: SizeStrategy = encoding.strategy ?? (encoding.by ? 'continuous' : 'degree')

  if (encoding.fn) {
    const column = encoding.by
    for (let i = 0; i < count; i++) {
      sizes[i] = encoding.fn(column ? frame.value(i, column) : i, i)
    }
    return { sizes, resolved: { strategy, range } }
  }

  if (strategy === 'direct' && encoding.by) {
    const values = frame.numeric(encoding.by)
    for (let i = 0; i < count; i++) {
      const value = values[i] as number
      sizes[i] = Number.isFinite(value) ? value : defaultValue
    }
    return { sizes, resolved: { strategy, range } }
  }

  const values = strategy === 'degree'
    ? degreesToFloat64(degrees, count)
    : encoding.by ? frame.numeric(encoding.by) : new Float64Array(count)

  const domain = strategy === 'degree' || !encoding.by
    ? finiteExtent(values)
    : percentileDomain(frame, encoding.by)

  if (!domain) {
    sizes.fill(defaultValue)
    return { sizes, resolved: { strategy, range } }
  }

  for (let i = 0; i < count; i++) {
    const value = values[i] as number
    if (!Number.isFinite(value)) {
      sizes[i] = defaultValue
      continue
    }
    // Area, not radius: a point drawn twice as wide covers four times the
    // screen, so mapping magnitude to radius overstates large values fourfold.
    // Taking the square root of the normalized position makes the *area*
    // proportional, which is what the eye actually compares.
    const t = Math.sqrt(normalize(value, domain))
    sizes[i] = range[0] + (range[1] - range[0]) * t
  }

  return { sizes, resolved: { strategy, domain, range } }
}

/**
 * The domain for a continuous scale: an inner percentile range rather than the
 * raw extent, so a lone outlier cannot compress everything else into one step.
 */
function percentileDomain (frame: DataFrame, column: string): [number, number] | undefined {
  const low = frame.percentile(column, CONTINUOUS_PERCENTILE_MIN)
  const high = frame.percentile(column, CONTINUOUS_PERCENTILE_MAX)
  if (low === undefined || high === undefined) return undefined
  // A column whose middle 90% is a single value still needs a usable domain;
  // fall back to the full extent before giving up.
  if (low === high) return frame.extent(column)
  return [low, high]
}

function finiteExtent (values: ArrayLike<number>): [number, number] | undefined {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as number
    if (!Number.isFinite(value)) continue
    if (value < min) min = value
    if (value > max) max = value
  }
  return Number.isFinite(min) ? [min, max] : undefined
}

function degreesToFloat64 (degrees: readonly number[] | undefined, count: number): Float64Array {
  const out = new Float64Array(count)
  if (!degrees) return out
  for (let i = 0; i < count; i++) out[i] = degrees[i] ?? 0
  return out
}

/** Clamped position of `value` within `domain`, in `0..1`. */
function normalize (value: number, domain: [number, number]): number {
  const [min, max] = domain
  if (max === min) return 0.5
  const t = (value - min) / (max - min)
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/**
 * Position in a diverging ramp, where the midpoint maps to the centre and each
 * arm is scaled by the larger of the two sides — so equal distances from the
 * midpoint are equally far from the centre regardless of which side they fall
 * on. Scaling each arm independently would make a small negative look as
 * extreme as a large positive.
 */
function divergingPosition (value: number, domain: [number, number], midpoint: number): number {
  const reach = Math.max(Math.abs(domain[0] - midpoint), Math.abs(domain[1] - midpoint))
  if (reach === 0) return 0.5
  const t = (value - midpoint) / reach
  return 0.5 + 0.5 * (t < -1 ? -1 : t > 1 ? 1 : t)
}

/** Samples a ramp at `t` in `0..1`, interpolating between adjacent stops. */
function sampleRamp (ramp: readonly Rgba[], t: number): Rgba {
  if (ramp.length === 0) return [0, 0, 0, 1]
  if (ramp.length === 1) return ramp[0] as Rgba
  const position = t * (ramp.length - 1)
  const lower = Math.floor(position)
  const upper = Math.min(lower + 1, ramp.length - 1)
  const f = position - lower
  const a = ramp[lower] as Rgba
  const b = ramp[upper] as Rgba
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
    a[3] + (b[3] - a[3]) * f,
  ]
}

function rgbaToCss (rgba: Rgba): string {
  const to255 = (v: number): number => Math.round(v * 255)
  return `rgba(${to255(rgba[0])}, ${to255(rgba[1])}, ${to255(rgba[2])}, ${rgba[3]})`
}
