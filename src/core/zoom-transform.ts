/**
 * An immutable pan/zoom transform: `screen = point * k + (x, y)`.
 *
 * A direct stand-in for d3-zoom's `ZoomTransform`, which the engine's view math
 * is written against but which cannot come along — d3-zoom binds itself to DOM
 * event listeners. The value semantics are identical, so the ported math is
 * unchanged; only the gesture source differs, and that lives in the React layer.
 */
export class ZoomTransform {
  public readonly k: number
  public readonly x: number
  public readonly y: number

  public constructor (k: number, x: number, y: number) {
    this.k = k
    this.x = x
    this.y = y
  }

  /** Post-translates by `(x, y)` in the transform's own scaled space. */
  public translate (x: number, y: number): ZoomTransform {
    if (x === 0 && y === 0) return this
    return new ZoomTransform(this.k, this.x + this.k * x, this.y + this.k * y)
  }

  /** Multiplies the scale, keeping the origin fixed. */
  public scale (k: number): ZoomTransform {
    return k === 1 ? this : new ZoomTransform(this.k * k, this.x, this.y)
  }

  /** Applies the transform to a point. */
  public apply (point: readonly [number, number]): [number, number] {
    return [point[0] * this.k + this.x, point[1] * this.k + this.y]
  }

  public applyX (x: number): number {
    return x * this.k + this.x
  }

  public applyY (y: number): number {
    return y * this.k + this.y
  }

  /** Inverts the transform for a point. */
  public invert (point: readonly [number, number]): [number, number] {
    return [(point[0] - this.x) / this.k, (point[1] - this.y) / this.k]
  }

  public invertX (x: number): number {
    return (x - this.x) / this.k
  }

  public invertY (y: number): number {
    return (y - this.y) / this.k
  }

  /**
   * Scales by `factor` about the screen point `(px, py)`, which stays fixed —
   * the operation behind pinch-to-zoom and a wheel zoom at the cursor.
   */
  public scaleAbout (factor: number, px: number, py: number): ZoomTransform {
    const k = this.k * factor
    return new ZoomTransform(k, px - (px - this.x) * factor, py - (py - this.y) * factor)
  }

  public toString (): string {
    return `translate(${this.x},${this.y}) scale(${this.k})`
  }

  public equals (other: ZoomTransform): boolean {
    return this.k === other.k && this.x === other.x && this.y === other.y
  }
}

export const zoomIdentity = new ZoomTransform(1, 0, 0)
