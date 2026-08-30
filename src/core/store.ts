import * as mat3 from './mat3'
import type { Mat3, Mat4Array } from './mat3'
import { getRgbaColor, rgbToBrightness, SeededRandom } from './helper'
import { hoveredPointRingOpacity, focusedPointRingOpacity, defaultConfigValues } from './variables'
import type { GraphConfigInterface, ColorValue } from './config'

export const ALPHA_MIN = 0.001
export const MAX_POINT_SIZE = 64

/**
 * Minimum pointer movement, in pixels, before hover detection re-runs. Below it
 * the previous result still holds, and picking is skipped.
 *
 * Larger than the web engine's threshold: a finger resting on a touchscreen
 * jitters by a pixel or two from contact-area noise alone, which would
 * otherwise re-pick every frame.
 */
export const MIN_POINTER_MOVEMENT_THRESHOLD = 3

/**
 * Frames to coalesce before running hover detection. Picking costs a GPU
 * readback, and a pointer moving across the screen does not need one per frame.
 */
export const MAX_HOVER_DETECTION_DELAY = 4

export type Hovered = { index: number; position: [number, number] }
type Focused = { index: number }

/**
 * Mutable state shared by every module: the view transform, the screen size,
 * simulation alpha, hover/focus, and the derived colors.
 *
 * One instance per graph, handed to each module at construction, so a change
 * here is visible everywhere on the next frame without any plumbing.
 */
export class Store {
  public pointsTextureSize = 0
  public linksTextureSize = 0
  public alpha = 1
  public transform: Mat3 = mat3.create()
  public screenSize: [number, number] = [0, 0]
  /** Pointer position in simulation space. */
  public pointerPosition: [number, number] = [0, 0]
  /** Pointer position in screen pixels. */
  public screenPointerPosition: [number, number] = [0, 0]
  public searchArea: [[number, number], [number, number]] = [[0, 0], [0, 0]]
  public isSimulationRunning = false
  public simulationProgress = 0
  public maxPointSize = MAX_POINT_SIZE
  public hoveredPoint: Hovered | undefined = undefined
  public focusedPoint: Focused | undefined = undefined
  public draggingPointIndex: number | undefined = undefined
  public hoveredLinkIndex: number | undefined = undefined
  public adjustedSpaceSize = defaultConfigValues.spaceSize
  public maxTextureSize = 4096

  public hoveredPointRingColor: [number, number, number, number] = [1, 1, 1, hoveredPointRingOpacity]
  public focusedPointRingColor: [number, number, number, number] = [1, 1, 1, focusedPointRingOpacity]
  public outlinedPointRingColor: [number, number, number, number] = [1, 1, 1, 1]
  public highlightedPointSet: Set<number> | undefined = undefined
  public outlinedPointSet: Set<number> | undefined = undefined
  /** `-1` in every channel means "not set". */
  public hoveredLinkColor: [number, number, number, number] = [-1, -1, -1, -1]
  public greyoutPointColor: [number, number, number, number] = [-1, -1, -1, -1]
  /** True when the background is dark enough that greyout should darken rather than lighten. */
  public isDarkenGreyout = false
  /** Whether any link-hover callback is configured; link picking is skipped when not. */
  public isLinkHoveringEnabled = false

  private alphaTarget = 0
  private random = new SeededRandom()
  private _backgroundColor: [number, number, number, number] = [0, 0, 0, 0]
  /** Cached linear scale endpoints, recomputed only in `updateScreenSize`. */
  private scaleXOffset = 0
  private scaleYOffset = 0

  public get backgroundColor (): [number, number, number, number] {
    return this._backgroundColor
  }

  public set backgroundColor (color: [number, number, number, number]) {
    this._backgroundColor = color
    this.isDarkenGreyout = rgbToBrightness(color[0], color[1], color[2]) < 0.65
  }

  /**
   * The view transform as a 4×4 for the shader uniform. See
   * `mat3.toMat4Array` for why the widening is necessary.
   */
  public get transformationMatrix4x4 (): Mat4Array {
    return mat3.toMat4Array(this.transform)
  }

  public addRandomSeed (seed: number | string): void {
    this.random.reseed(seed)
  }

  public getRandomFloat (min: number, max: number): number {
    return this.random.float(min, max)
  }

  /**
   * Clamps `spaceSize` to what the GPU can actually allocate, without touching
   * the config value — so raising the device limit later takes effect without
   * the caller changing anything.
   *
   * Enforces a floor of 2, since the force pyramid takes `Math.log2` of it.
   */
  public adjustSpaceSize (configSpaceSize: number, maxTextureSize: number): void {
    let requested = configSpaceSize
    if (requested <= 0 || !Number.isFinite(requested)) {
      console.error(`Invalid spaceSize value: ${requested}. Using default value of ${defaultConfigValues.spaceSize}`)
      requested = defaultConfigValues.spaceSize
    }

    const minSpaceSize = 2
    if (requested < minSpaceSize) {
      console.warn(`spaceSize (${requested}) is too small. Using minimum value of ${minSpaceSize}`)
      requested = minSpaceSize
    }

    if (!Number.isFinite(maxTextureSize) || maxTextureSize < minSpaceSize) {
      console.warn(`Invalid maxTextureSize: ${maxTextureSize}. Using spaceSize without a device limit adjustment.`)
      this.adjustedSpaceSize = requested
      return
    }

    if (requested >= maxTextureSize) {
      this.adjustedSpaceSize = Math.max(maxTextureSize / 2, minSpaceSize)
      console.warn(`\`spaceSize\` reduced to ${this.adjustedSpaceSize} to fit this device's texture limit`)
    } else {
      this.adjustedSpaceSize = requested
    }
  }

  public setMaxTextureSize (maxTextureSize: number): void {
    this.maxTextureSize = maxTextureSize
  }

  /**
   * Recomputes the simulation-space → screen-space mapping.
   *
   * The space is centred in the view at zoom 1, and Y is flipped: simulation
   * space has Y increasing upward, the screen has it increasing downward.
   */
  public updateScreenSize (width: number, height: number): void {
    const { adjustedSpaceSize } = this
    this.screenSize = [width, height]
    this.scaleXOffset = (width - adjustedSpaceSize) / 2
    this.scaleYOffset = (height - adjustedSpaceSize) / 2
  }

  /**
   * The space→screen offsets, for a consumer projecting positions itself.
   *
   * Exposed because a label layer running on another thread cannot call back
   * into the engine per point: it needs the numbers, not the function.
   */
  public get spaceOffsets (): readonly [number, number] {
    return [this.scaleXOffset, this.scaleYOffset]
  }

  public scaleX (x: number): number {
    return x + this.scaleXOffset
  }

  public scaleY (y: number): number {
    return this.adjustedSpaceSize - y + this.scaleYOffset
  }

  public setHoveredPointRingColor (color: ColorValue): void {
    const rgba = getRgbaColor(color)
    this.hoveredPointRingColor[0] = rgba[0]
    this.hoveredPointRingColor[1] = rgba[1]
    this.hoveredPointRingColor[2] = rgba[2]
  }

  public setFocusedPointRingColor (color: ColorValue): void {
    const rgba = getRgbaColor(color)
    this.focusedPointRingColor[0] = rgba[0]
    this.focusedPointRingColor[1] = rgba[1]
    this.focusedPointRingColor[2] = rgba[2]
  }

  public setOutlinedPointRingColor (color: ColorValue): void {
    const rgba = getRgbaColor(color)
    this.outlinedPointRingColor[0] = rgba[0]
    this.outlinedPointRingColor[1] = rgba[1]
    this.outlinedPointRingColor[2] = rgba[2]
    this.outlinedPointRingColor[3] = rgba[3]
  }

  public setHighlightedPointSet (indices: number[] | undefined): void {
    this.highlightedPointSet = indices ? new Set(indices) : undefined
  }

  public setOutlinedPointSet (indices: number[] | undefined): void {
    this.outlinedPointSet = indices ? new Set(indices) : undefined
  }

  public setGreyoutPointColor (color: ColorValue | undefined): void {
    if (color === undefined) {
      this.greyoutPointColor = [-1, -1, -1, -1]
      return
    }
    const rgba = getRgbaColor(color)
    this.greyoutPointColor = [rgba[0], rgba[1], rgba[2], rgba[3]]
  }

  public setHoveredLinkColor (color?: ColorValue): void {
    if (color === undefined) {
      this.hoveredLinkColor = [-1, -1, -1, -1]
      return
    }
    const rgba = getRgbaColor(color)
    this.hoveredLinkColor = [rgba[0], rgba[1], rgba[2], rgba[3]]
  }

  public updateLinkHoveringEnabled (
    config: Pick<GraphConfigInterface, 'onLinkClick' | 'onLinkContextMenu' | 'onLinkMouseOver' | 'onLinkMouseOut'>
  ): void {
    this.isLinkHoveringEnabled = Boolean(
      config.onLinkClick || config.onLinkContextMenu || config.onLinkMouseOver || config.onLinkMouseOut
    )
    if (!this.isLinkHoveringEnabled) this.hoveredLinkIndex = undefined
  }

  public setFocusedPoint (index?: number): void {
    this.focusedPoint = index !== undefined ? { index } : undefined
  }

  /** The alpha decrement for one simulation tick, given the configured decay. */
  public addAlpha (decay: number): number {
    return (this.alphaTarget - this.alpha) * (1 - Math.pow(ALPHA_MIN, 1 / decay))
  }
}
