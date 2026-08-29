export { getRgbaColor, rgbToBrightness, type Rgba } from './color'

export function clamp (value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** True for a real number — rejects `undefined`, `null` and `NaN`. */
/**
 * Applies a `FitViewBounds` to a scale, ignoring bounds that are not finite
 * positive numbers rather than letting one poison the result.
 */
export function boundScale (scale: number, bounds?: { minScale?: number; maxScale?: number }): number {
  if (!bounds) return scale
  let result = scale
  const { minScale, maxScale } = bounds
  if (typeof maxScale === 'number' && maxScale > 0 && result > maxScale) result = maxScale
  if (typeof minScale === 'number' && minScale > 0 && result < minScale) result = minScale
  return result
}

export function isNumber (value: number | undefined | null): boolean {
  return value !== undefined && value !== null && !Number.isNaN(value)
}

/**
 * Reports whether the point at `index` is absent (removed): its position is
 * `NaN`. A point is absent when either coordinate is `NaN`.
 */
export function isPointAbsent (pointPositions: Float32Array, index: number): boolean {
  return Number.isNaN(pointPositions[index * 2] as number) ||
    Number.isNaN(pointPositions[index * 2 + 1] as number)
}

/**
 * Extracts point indices from a pixel readback buffer. Every 4th value (the R
 * channel) is checked — non-zero means the point at that index was found.
 *
 * @param pointsNumber Number of real points. The texture is square, so texels
 * past this count are padding holding position `(0, 0)`; they match any search
 * area covering the space origin and would otherwise be reported as points that
 * do not exist. Omit it to read the whole buffer.
 */
export function extractIndicesFromPixels (pixels: Float32Array, pointsNumber?: number): number[] {
  const result: number[] = []
  const count = Math.min(pixels.length / 4, pointsNumber ?? Infinity)
  for (let i = 0; i < count; i += 1) {
    if (pixels[i * 4] !== 0) result.push(i)
  }
  return result
}

/**
 * Side of the square texture needed to hold `count` elements, one per texel.
 *
 * The engine stores every per-point and per-link channel this way, so a point's
 * texel is `(index % size, floor(index / size))` everywhere. Returns 0 for an
 * empty set so callers can skip allocation entirely.
 */
export function textureSizeFor (count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.ceil(Math.sqrt(count))
}

/**
 * Formats a number as a GLSL float literal for injection as a `#define`.
 * GLSL treats a bare `0` as an int, so integers need a `.0` suffix.
 */
export function glslFloatLiteral (value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value)
}

/** Ensures a value is a `[number, number]` tuple, falling back when it is not. */
export function ensureVec2 (
  array: readonly number[] | undefined,
  fallback: [number, number]
): [number, number] {
  if (!array || array.length !== 2) return fallback
  return [array[0] as number, array[1] as number]
}

/** Ensures a value is a `[number, number, number, number]` tuple. */
export function ensureVec4 (
  array: readonly number[] | undefined,
  fallback: [number, number, number, number]
): [number, number, number, number] {
  if (!array || array.length !== 4) return fallback
  return [array[0] as number, array[1] as number, array[2] as number, array[3] as number]
}

/**
 * A small deterministic PRNG (mulberry32) with a seedable stream.
 *
 * Replaces the `random` package. Seeding matters because the engine scatters
 * points and jitters link distances randomly: without a seed, the same data
 * lays out differently on every run, and `config.randomSeed` exists so callers
 * can pin that down.
 */
export class SeededRandom {
  private state: number

  public constructor (seed?: number | string) {
    this.state = seed === undefined ? (Math.random() * 0x100000000) >>> 0 : hashSeed(seed)
  }

  /** A uniform float in `[min, max)`. */
  public float (min = 0, max = 1): number {
    return min + this.next() * (max - min)
  }

  /** A uniform integer in `[min, max]`. */
  public integer (min: number, max: number): number {
    return Math.floor(this.float(min, max + 1))
  }

  public reseed (seed: number | string): void {
    this.state = hashSeed(seed)
  }

  private next (): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashSeed (seed: number | string): number {
  if (typeof seed === 'number') return Math.floor(seed) >>> 0
  // FNV-1a: cheap, and spreads similar strings ("run-1", "run-2") apart.
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Generates a short random id, used to namespace per-instance resources so two
 * graphs in one app never collide.
 */
export function generateRandomId (): string {
  const part = (): string => Math.floor(Math.random() * 0x100000000).toString(36).padStart(7, '0')
  return `${part()}${part()}`
}
