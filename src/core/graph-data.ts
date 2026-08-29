import { getRgbaColor, isNumber, isPointAbsent } from './helper'
import type { GraphConfigInterface } from './config'
import { defaultConfigValues, EXIT_DEFAULT_SIZE, EXIT_DEFAULT_COLOR_CHANNEL } from './variables'
import type { Rgba } from './color'

export { PointShape, LinkStyle } from './enums'

/**
 * Raw pixels for a point image, in the form React Native can actually produce.
 *
 * The web engine takes a DOM `ImageData`, which does not exist here. Callers
 * decode however they like — `expo-image-manipulator`, a native module, a
 * bundled asset — and hand over the RGBA bytes.
 */
export type PointImageData = {
  width: number
  height: number
  /** Tightly packed RGBA, 4 bytes per pixel, `width * height * 4` long. */
  data: Uint8Array | Uint8ClampedArray
}

const MAX_SHAPE = 8
const MAX_LINK_STYLE = 2

/**
 * The data model: flat typed arrays, one entry per point or link.
 *
 * `inputPoint*` / `inputLink*` hold exactly what the caller passed; the
 * unprefixed fields hold the validated, default-filled versions the GPU
 * consumes. Caller arrays are never mutated — where a value needs resolving
 * (a `NaN` color channel, an out-of-range shape) it is either resolved at read
 * time or written into a copy.
 */
export class GraphData {
  public inputPointPositions: Float32Array | undefined
  public inputPointColors: Float32Array | undefined
  public inputPointSizes: Float32Array | undefined
  public inputPointShapes: Float32Array | undefined
  public inputImageData: PointImageData[] | undefined
  public inputPointImageIndices: Float32Array | undefined
  public inputPointImageSizes: Float32Array | undefined
  public inputLinkColors: Float32Array | undefined
  public inputLinkWidths: Float32Array | undefined
  public inputLinkStyles: Float32Array | undefined
  public inputLinkStrength: Float32Array | undefined
  public inputPointClusters: (number | undefined)[] | undefined
  public inputClusterPositions: (number | undefined)[] | undefined
  public inputClusterStrength: Float32Array | undefined
  public inputPinnedPoints: number[] | undefined

  public pointPositions: Float32Array | undefined
  /** Point count before the latest update — the `from` value for transitions. */
  public sourcePointsNumber = 0
  /** Point count after the latest update — the `to` value for transitions. */
  public targetPointsNumber = 0
  public pointColors: Float32Array | undefined
  public pointSizes: Float32Array | undefined
  public pointShapes: Float32Array | undefined
  public pointImageIndices: Float32Array | undefined
  public pointImageSizes: Float32Array | undefined

  public inputLinks: Float32Array | undefined
  public links: Float32Array | undefined
  public linkColors: Float32Array | undefined
  public linkWidths: Float32Array | undefined
  public linkStyles: Float32Array | undefined
  public linkArrowsBoolean: boolean[] | undefined
  public linkArrows: number[] | undefined
  public linkStrength: Float32Array | undefined

  public pointClusters: (number | undefined)[] | undefined
  public clusterPositions: (number | undefined)[] | undefined
  public clusterStrength: Float32Array | undefined

  /**
   * Adjacency, as `[neighbourPointIndex, linkIndex]` pairs per point. Carrying
   * the link index alongside is what lets `getConnectedLinkIndices` answer
   * without a second scan of `links`.
   */
  public sourceIndexToTargetIndices: ([number, number][] | undefined)[] | undefined
  public targetIndexToSourceIndices: ([number, number][] | undefined)[] | undefined

  public degree: number[] | undefined
  public inDegree: number[] | undefined
  public outDegree: number[] | undefined

  private _config: GraphConfigInterface
  /** Lazily parsed `pointDefaultColor` — see the `defaultRgba` getter. */
  private _defaultRgba: Rgba | undefined

  public constructor (config: GraphConfigInterface) {
    this._config = config
  }

  public get pointsNumber (): number | undefined {
    return this.pointPositions && this.pointPositions.length / 2
  }

  public get linksNumber (): number | undefined {
    return this.links && this.links.length / 2
  }

  /**
   * Parsed `pointDefaultColor`, cached between updates (`updatePointColor`
   * invalidates it, so config changes are picked up). Public so the draw pass
   * can feed it to the shader without re-parsing the color string every frame.
   */
  public get defaultRgba (): Rgba {
    this._defaultRgba ??= getRgbaColor(this._config.pointDefaultColor)
    return this._defaultRgba
  }

  public updatePoints (): void {
    // Positions must hold whole [x, y] pairs: an odd length makes
    // `pointsNumber` fractional, which the adjacency and degree builds pass to
    // `new Array()`. `subarray` is a view — the caller's array is not edited.
    if (this.inputPointPositions !== undefined && this.inputPointPositions.length % 2 !== 0) {
      console.warn(
        `Invalid point positions length: ${this.inputPointPositions.length}. ` +
        'The array must hold [x, y] pairs — the trailing value was ignored.'
      )
      this.inputPointPositions = this.inputPointPositions.subarray(0, this.inputPointPositions.length - 1)
    }

    // Don't sync the same positions twice — it breaks animations when points
    // are added or removed.
    if (this.pointPositions === this.inputPointPositions) return

    this.sourcePointsNumber = this.pointPositions ? this.pointPositions.length / 2 : 0
    this.pointPositions = this.inputPointPositions
    this.targetPointsNumber = this.pointPositions ? this.pointPositions.length / 2 : 0
  }

  /**
   * Point colors are not resolved here. A missing or mismatched input becomes
   * an all-`NaN` array meaning "resolve every channel", and resolution happens
   * at read time — in the draw shader, or through
   * `getResolvedPointColorChannel` for CPU consumers. That keeps the caller's
   * array untouched and the two resolution paths in agreement.
   */
  public updatePointColor (): void {
    if (this.pointsNumber === undefined) {
      this.pointColors = undefined
      return
    }

    this._defaultRgba = undefined // config may have changed — re-parse lazily
    if (this.inputPointColors === undefined || this.inputPointColors.length / 4 !== this.pointsNumber) {
      this.pointColors = new Float32Array(this.pointsNumber * 4).fill(NaN)
    } else {
      this.pointColors = this.inputPointColors
    }
  }

  /**
   * Resolves one color channel the way the draw shader does: a `NaN` channel
   * means the exit default (transparent) for an **absent** point, and the
   * config default otherwise.
   */
  public getResolvedPointColorChannel (index: number, channel: number): number {
    const raw = this.pointColors?.[index * 4 + channel]
    if (isNumber(raw)) return raw as number
    if (this.pointPositions && isPointAbsent(this.pointPositions, index)) return EXIT_DEFAULT_COLOR_CHANNEL
    return this.defaultRgba[channel] as number
  }

  public updatePointSize (): void {
    if (this.pointsNumber === undefined) {
      this.pointSizes = undefined
      return
    }

    if (this.inputPointSizes === undefined || this.inputPointSizes.length !== this.pointsNumber) {
      this.pointSizes = new Float32Array(this.pointsNumber).fill(NaN)
    } else {
      this.pointSizes = this.inputPointSizes
    }
  }

  /**
   * Resolves a point's size the way the draw shader does: `NaN` means the exit
   * default (`0`) for an **absent** point, the config default otherwise.
   */
  public getResolvedPointSize (index: number): number {
    const raw = this.pointSizes?.[index]
    if (isNumber(raw)) return raw as number
    if (this.pointPositions && isPointAbsent(this.pointPositions, index)) return EXIT_DEFAULT_SIZE
    return this._config.pointDefaultSize
  }

  public updatePointShape (): void {
    if (this.pointsNumber === undefined) {
      this.pointShapes = undefined
      return
    }

    const { pointDefaultShape } = this._config
    const configShape = typeof pointDefaultShape === 'string' ? Number(pointDefaultShape) : pointDefaultShape
    // PointShape is an integer enum and the draw shader matches by exact
    // equality, so a fractional value would silently render as the shader's
    // fallback. `Number.isInteger` also rejects NaN.
    const defaultShape = (Number.isInteger(configShape) && configShape >= 0 && configShape <= MAX_SHAPE)
      ? configShape
      : defaultConfigValues.pointDefaultShape

    if (this.inputPointShapes === undefined || this.inputPointShapes.length !== this.pointsNumber) {
      this.pointShapes = new Float32Array(this.pointsNumber).fill(defaultShape)
    } else {
      this.pointShapes = new Float32Array(this.inputPointShapes)
      const pointShapes = this.pointShapes
      for (let i = 0; i < pointShapes.length; i++) {
        const shape = pointShapes[i] ?? -1
        if (!Number.isInteger(shape) || shape < 0 || shape > MAX_SHAPE) pointShapes[i] = defaultShape
      }
    }
  }

  public updatePointImageIndices (): void {
    if (this.pointsNumber === undefined) {
      this.pointImageIndices = undefined
      return
    }

    if (this.inputPointImageIndices === undefined || this.inputPointImageIndices.length !== this.pointsNumber) {
      this.pointImageIndices = new Float32Array(this.pointsNumber).fill(-1)
    } else {
      const pointImageIndices = new Float32Array(this.inputPointImageIndices)
      for (let i = 0; i < pointImageIndices.length; i++) {
        const rawIndex = pointImageIndices[i]
        const imageIndex = rawIndex === undefined ? NaN : rawIndex
        if (!Number.isFinite(imageIndex) || imageIndex < 0) pointImageIndices[i] = -1
        else pointImageIndices[i] = Math.trunc(imageIndex)
      }
      this.pointImageIndices = pointImageIndices
    }
  }

  public updatePointImageSizes (): void {
    if (this.pointsNumber === undefined) {
      this.pointImageSizes = undefined
      return
    }

    // Point sizes are read through the resolver: the raw array may hold NaN
    // ("use the default"), which must not reach the image-size buffer.
    if (this.inputPointImageSizes === undefined || this.inputPointImageSizes.length !== this.pointsNumber) {
      this.pointImageSizes = new Float32Array(this.pointsNumber)
      for (let i = 0; i < this.pointsNumber; i++) this.pointImageSizes[i] = this.getResolvedPointSize(i)
    } else {
      this.pointImageSizes = new Float32Array(this.inputPointImageSizes)
      for (let i = 0; i < this.pointImageSizes.length; i++) {
        if (!isNumber(this.pointImageSizes[i])) this.pointImageSizes[i] = this.getResolvedPointSize(i)
      }
    }
  }

  /**
   * True when `index` addresses a real point. Link endpoints come straight from
   * the caller, so they may be out of range, negative or fractional.
   */
  public isPointIndex (index: number | undefined): index is number {
    return index !== undefined && Number.isInteger(index) && index >= 0 && index < (this.pointsNumber ?? 0)
  }

  public updateLinks (): void {
    // Links must hold whole [source, target] pairs: an odd length makes
    // `linksNumber` fractional, and `new Array(linksNumber)` in `updateArrows`
    // then throws from inside the deferred render, leaving the graph blank with
    // no error surfaced.
    if (this.inputLinks !== undefined && this.inputLinks.length % 2 !== 0) {
      console.warn(
        `Invalid links length: ${this.inputLinks.length}. ` +
        'The array must hold [source, target] pairs — the trailing value was ignored.'
      )
      this.inputLinks = this.inputLinks.subarray(0, this.inputLinks.length - 1)
    }

    this.links = this.inputLinks
  }

  public updateLinkColor (): void {
    if (this.linksNumber === undefined) {
      this.linkColors = undefined
      return
    }

    const defaultRgba = getRgbaColor(this._config.linkDefaultColor)
    if (this.inputLinkColors === undefined || this.inputLinkColors.length / 4 !== this.linksNumber) {
      this.linkColors = new Float32Array(this.linksNumber * 4)
      for (let i = 0; i < this.linksNumber; i++) {
        this.linkColors[i * 4] = defaultRgba[0]
        this.linkColors[i * 4 + 1] = defaultRgba[1]
        this.linkColors[i * 4 + 2] = defaultRgba[2]
        this.linkColors[i * 4 + 3] = defaultRgba[3]
      }
    } else {
      this.linkColors = this.inputLinkColors
      for (let i = 0; i < this.linksNumber; i++) {
        if (!isNumber(this.linkColors[i * 4])) this.linkColors[i * 4] = defaultRgba[0]
        if (!isNumber(this.linkColors[i * 4 + 1])) this.linkColors[i * 4 + 1] = defaultRgba[1]
        if (!isNumber(this.linkColors[i * 4 + 2])) this.linkColors[i * 4 + 2] = defaultRgba[2]
        if (!isNumber(this.linkColors[i * 4 + 3])) this.linkColors[i * 4 + 3] = defaultRgba[3]
      }
    }
  }

  public updateLinkWidth (): void {
    if (this.linksNumber === undefined) {
      this.linkWidths = undefined
      return
    }

    const defaultWidth = this._config.linkDefaultWidth
    if (this.inputLinkWidths === undefined || this.inputLinkWidths.length !== this.linksNumber) {
      this.linkWidths = new Float32Array(this.linksNumber).fill(defaultWidth)
    } else {
      this.linkWidths = this.inputLinkWidths
      for (let i = 0; i < this.linkWidths.length; i++) {
        if (!isNumber(this.linkWidths[i])) this.linkWidths[i] = defaultWidth
      }
    }
  }

  public updateLinkStyles (): void {
    if (this.linksNumber === undefined) {
      this.linkStyles = undefined
      return
    }

    const { linkDefaultStyle } = this._config
    const configStyle = typeof linkDefaultStyle === 'string' ? Number(linkDefaultStyle) : linkDefaultStyle
    const defaultStyle = (Number.isInteger(configStyle) && configStyle >= 0 && configStyle <= MAX_LINK_STYLE)
      ? configStyle
      : defaultConfigValues.linkDefaultStyle

    if (this.inputLinkStyles === undefined || this.inputLinkStyles.length !== this.linksNumber) {
      this.linkStyles = new Float32Array(this.linksNumber).fill(defaultStyle)
    } else {
      this.linkStyles = new Float32Array(this.inputLinkStyles)
      const linkStyles = this.linkStyles
      for (let i = 0; i < linkStyles.length; i++) {
        const style = linkStyles[i] ?? -1
        if (!Number.isInteger(style) || style < 0 || style > MAX_LINK_STYLE) linkStyles[i] = defaultStyle
      }
    }
  }

  public updateArrows (): void {
    if (this.linksNumber === undefined) {
      this.linkArrows = undefined
      return
    }

    const defaultArrows = this._config.linkDefaultArrows
    if (this.linkArrowsBoolean === undefined || this.linkArrowsBoolean.length !== this.linksNumber) {
      this.linkArrows = new Array<number>(this.linksNumber).fill(+defaultArrows)
    } else {
      this.linkArrows = this.linkArrowsBoolean.map((d) => +d)
    }
  }

  public updateLinkStrength (): void {
    if (this.inputLinkStrength === undefined || this.inputLinkStrength.length !== this.linksNumber) {
      this.linkStrength = undefined
    } else {
      this.linkStrength = this.inputLinkStrength
    }
  }

  public updateClusters (): void {
    if (this.pointsNumber === undefined) {
      this.pointClusters = undefined
      this.clusterPositions = undefined
      return
    }
    this.pointClusters = (this.inputPointClusters === undefined || this.inputPointClusters.length !== this.pointsNumber)
      ? undefined
      : this.inputPointClusters
    this.clusterPositions = this.inputClusterPositions
    this.clusterStrength = (this.inputClusterStrength === undefined || this.inputClusterStrength.length !== this.pointsNumber)
      ? undefined
      : this.inputClusterStrength
  }

  public update (): void {
    this.updatePoints()
    this.updatePointColor()
    this.updatePointSize()
    this.updatePointShape()
    this.updatePointImageIndices()
    this.updatePointImageSizes()

    this.updateLinks()
    this.updateLinkColor()
    this.updateLinkWidth()
    this.updateArrows()
    this.updateLinkStyles()
    this.updateLinkStrength()

    this.updateClusters()

    this._createAdjacencyLists()
    this._calculateDegrees()
  }

  /** Unique point indices connected to the given point(s) in either direction. */
  public getNeighboringPointIndices (pointIndices: number | number[]): number[] {
    const indices = Array.isArray(pointIndices) ? pointIndices : [pointIndices]
    const result = new Set<number>()
    for (const index of indices) {
      if (!this.isPointIndex(index)) continue
      for (const [pointIndex] of this.sourceIndexToTargetIndices?.[index] ?? []) result.add(pointIndex)
      for (const [pointIndex] of this.targetIndexToSourceIndices?.[index] ?? []) result.add(pointIndex)
    }
    return [...result]
  }

  /** Link indices whose **both** endpoints lie within the given point set. */
  public getConnectedLinkIndices (pointIndices: number | number[]): number[] {
    const indices = Array.isArray(pointIndices) ? pointIndices : [pointIndices]
    const indexSet = new Set(indices)
    const result = new Set<number>()
    for (const index of indexSet) {
      if (!this.isPointIndex(index)) continue
      for (const [targetIndex, linkIndex] of this.sourceIndexToTargetIndices?.[index] ?? []) {
        if (indexSet.has(targetIndex)) result.add(linkIndex)
      }
    }
    return [...result]
  }

  /** Point indices at the endpoints of the given link(s). */
  public getConnectedPointIndices (linkIndices: number | number[]): number[] {
    const indices = Array.isArray(linkIndices) ? linkIndices : [linkIndices]
    const result = new Set<number>()
    if (this.links === undefined) return []
    const linksNumber = this.linksNumber ?? 0
    for (const linkIndex of indices) {
      // A fractional index would read one endpoint from each of two links.
      if (!Number.isInteger(linkIndex) || linkIndex < 0 || linkIndex >= linksNumber) continue
      const sourceIndex = this.links[linkIndex * 2]
      const targetIndex = this.links[linkIndex * 2 + 1]
      // Read straight from `links`, so the endpoint check the adjacency build
      // applies has to be repeated here.
      if (!this.isPointIndex(sourceIndex) || !this.isPointIndex(targetIndex)) continue
      result.add(sourceIndex)
      result.add(targetIndex)
    }
    return [...result]
  }

  private _createAdjacencyLists (): void {
    if (this.linksNumber === undefined || this.links === undefined) {
      this.sourceIndexToTargetIndices = undefined
      this.targetIndexToSourceIndices = undefined
      return
    }

    this.sourceIndexToTargetIndices = new Array(this.pointsNumber).fill(undefined)
    this.targetIndexToSourceIndices = new Array(this.pointsNumber).fill(undefined)
    for (let i = 0; i < this.linksNumber; i++) {
      const sourceIndex = this.links[i * 2]
      const targetIndex = this.links[i * 2 + 1]
      // Both endpoints must be real points: an out-of-range index would extend
      // these arrays past the point count and come back out of
      // `getNeighboringPointIndices` as a point the caller cannot look up.
      // Skipped rather than dropped, so link indices stay the caller's own.
      if (this.isPointIndex(sourceIndex) && this.isPointIndex(targetIndex)) {
        this.sourceIndexToTargetIndices[sourceIndex] ??= []
        this.sourceIndexToTargetIndices[sourceIndex]?.push([targetIndex, i])
        this.targetIndexToSourceIndices[targetIndex] ??= []
        this.targetIndexToSourceIndices[targetIndex]?.push([sourceIndex, i])
      }
    }
  }

  private _calculateDegrees (): void {
    if (this.pointsNumber === undefined) {
      this.degree = undefined
      this.inDegree = undefined
      this.outDegree = undefined
      return
    }

    this.degree = new Array<number>(this.pointsNumber).fill(0)
    this.inDegree = new Array<number>(this.pointsNumber).fill(0)
    this.outDegree = new Array<number>(this.pointsNumber).fill(0)

    for (let i = 0; i < this.pointsNumber; i++) {
      this.inDegree[i] = this.targetIndexToSourceIndices?.[i]?.length ?? 0
      this.outDegree[i] = this.sourceIndexToTargetIndices?.[i]?.length ?? 0
      this.degree[i] = (this.inDegree[i] ?? 0) + (this.outDegree[i] ?? 0)
    }
  }
}
