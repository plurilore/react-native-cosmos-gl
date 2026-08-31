export type LabelAtlasSlot = {
  key: string
  x: number
  y: number
  width: number
  height: number
}

export type LabelAtlasLookup = {
  slot: LabelAtlasSlot
  hit: boolean
}

/**
 * Persistent shelf allocator for text sprites.
 *
 * It knows nothing about Skia or GL. A rasterizer fills newly allocated slots
 * and the renderer uploads those rectangles; existing strings retain their UVs
 * across label-policy refreshes.
 */
export class LabelAtlasCache {
  public readonly width: number
  public readonly height: number
  public readonly gap: number
  public generation = 0
  public hits = 0
  public misses = 0
  public overflows = 0

  private readonly slots = new Map<string, LabelAtlasSlot>()
  private cursorX = 0
  private cursorY = 0
  private rowHeight = 0

  public constructor (width: number, height: number, gap = 1) {
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new RangeError('label atlas dimensions must be positive integers')
    }
    this.width = width
    this.height = height
    this.gap = Number.isFinite(gap) ? Math.max(0, Math.floor(gap)) : 1
  }

  public get size (): number {
    return this.slots.size
  }

  public get (key: string): LabelAtlasSlot | undefined {
    return this.slots.get(key)
  }

  public acquire (key: string, width: number, height: number): LabelAtlasLookup | undefined {
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      this.overflows += 1
      return undefined
    }
    const existing = this.slots.get(key)
    if (existing) {
      if (existing.width !== Math.ceil(width) || existing.height !== Math.ceil(height)) {
        throw new RangeError('label atlas cache keys must include font generation, size and raster scale')
      }
      this.hits += 1
      return { slot: existing, hit: true }
    }

    const slotWidth = Math.max(1, Math.ceil(width))
    const slotHeight = Math.max(1, Math.ceil(height))
    if (slotWidth > this.width || slotHeight > this.height) {
      this.overflows += 1
      return undefined
    }

    if (this.cursorX > 0 && this.cursorX + slotWidth > this.width) {
      this.cursorX = 0
      this.cursorY += this.rowHeight + this.gap
      this.rowHeight = 0
    }
    if (this.cursorY + slotHeight > this.height) {
      this.overflows += 1
      return undefined
    }

    const slot = { key, x: this.cursorX, y: this.cursorY, width: slotWidth, height: slotHeight }
    this.slots.set(key, slot)
    this.cursorX += slotWidth + this.gap
    this.rowHeight = Math.max(this.rowHeight, slotHeight)
    this.misses += 1
    return { slot, hit: false }
  }

  /** Clears UV ownership. The GL allocation itself can stay alive. */
  public reset (): void {
    this.slots.clear()
    this.cursorX = 0
    this.cursorY = 0
    this.rowHeight = 0
    this.generation += 1
  }
}

/** Stable collision-free key for a string rasterized under one font generation. */
export function labelAtlasCacheKey (
  text: string,
  fontGeneration: number,
  fontSize: number,
  rasterScale: number
): string {
  return `${text.length}:${text}|${fontGeneration}|${fontSize}|${rasterScale}`
}
