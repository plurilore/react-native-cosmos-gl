import * as mat3 from './mat3'
import { ZoomTransform, zoomIdentity } from './zoom-transform'
import type { Store } from './store'
import type { GraphConfigInterface } from './config'
import { clamp } from './helper'
import { currentTime } from './transition'

const DEFAULT_SCALE_EXTENT: [number, number] = [0.001, Infinity]

/** An in-flight programmatic zoom animation. */
type ZoomAnimation = {
  from: ZoomTransform
  to: ZoomTransform
  startTime: number
  duration: number
}

/**
 * Owns the view transform.
 *
 * Deliberately knows nothing about gestures. Upstream this class *is* a
 * d3-zoom behaviour, wired straight to DOM listeners; here the transform is
 * simply state that something else drives — the React layer's gesture handlers
 * on device, `setTransform` from the public API, or the tween below. That split
 * is what lets the same view math serve a mouse wheel and a two-finger pinch.
 */
export class Zoom {
  public readonly store: Store
  public readonly config: GraphConfigInterface
  public eventTransform: ZoomTransform = zoomIdentity
  public scaleExtent: [number, number] = [...DEFAULT_SCALE_EXTENT]
  /** True while a gesture or an animation is changing the transform. */
  public isRunning = false
  /**
   * Per-call override of `enableSimulationDuringZoom`, set by the programmatic
   * zoom methods. A stale value once the animation ends is harmless, since
   * `isRunning` is false by then. Cleared when a gesture starts.
   */
  public shouldEnableSimulationDuringZoomOverride: boolean | undefined = undefined

  private animation: ZoomAnimation | undefined

  public constructor (store: Store, config: GraphConfigInterface) {
    this.store = store
    this.config = config
  }

  /**
   * Sets the transform and recomputes the matrix the shaders read.
   *
   * `userDriven` distinguishes a gesture from an API call: it decides whether
   * the simulation keeps running during the change and is reported to the
   * `onZoom*` callbacks.
   */
  public setTransform (transform: ZoomTransform, userDriven = false): void {
    const clampedScale = clamp(transform.k, this.scaleExtent[0], this.scaleExtent[1])
    this.eventTransform = clampedScale === transform.k
      ? transform
      : new ZoomTransform(clampedScale, transform.x, transform.y)
    this.updateTransformMatrix()
    this.config.onZoom?.({ transform: this.eventTransform, userDriven })
  }

  /** Begins a gesture. Clears any programmatic override and animation. */
  public start (userDriven = true): void {
    this.isRunning = true
    if (userDriven) {
      this.shouldEnableSimulationDuringZoomOverride = undefined
      this.animation = undefined
    }
    this.config.onZoomStart?.({ transform: this.eventTransform, userDriven })
  }

  public end (userDriven = true): void {
    this.isRunning = false
    this.config.onZoomEnd?.({ transform: this.eventTransform, userDriven })
  }

  /**
   * Animates to `target` over `duration` ms. The render loop advances it via
   * `step()`; a duration of 0 applies immediately.
   *
   * `now` shares a clock with `step()`, so a caller driving both from one
   * timestamp — a test, or a host with its own frame clock — gets exact pacing
   * rather than a start time sampled a few milliseconds earlier.
   */
  public animateTo (
    target: ZoomTransform,
    duration: number,
    enableSimulationDuringZoom?: boolean,
    now = currentTime()
  ): void {
    this.shouldEnableSimulationDuringZoomOverride = enableSimulationDuringZoom
    if (duration <= 0) {
      this.setTransform(target, false)
      return
    }
    this.animation = {
      from: this.eventTransform,
      to: target,
      startTime: now,
      duration,
    }
    this.isRunning = true
    this.config.onZoomStart?.({ transform: this.eventTransform, userDriven: false })
  }

  /**
   * Advances an in-flight animation. Returns true while one is running, so the
   * render loop knows to keep drawing.
   *
   * Scale is interpolated geometrically and translation is interpolated in the
   * *scaled* frame, so a zoom-and-pan holds a consistent apparent speed instead
   * of racing at the wide end and crawling at the tight one.
   */
  public step (now = currentTime()): boolean {
    const animation = this.animation
    if (!animation) return false

    const linear = Math.min((now - animation.startTime) / animation.duration, 1)
    const t = easeCubicInOut(linear)
    const { from, to } = animation

    const k = from.k * Math.pow(to.k / from.k, t)
    // Interpolating the screen-space translation directly would drift the
    // focal point whenever the scale changes; interpolating the *centre* the
    // transform points at keeps it fixed.
    const [w, h] = this.store.screenSize
    const fromCenterX = (w / 2 - from.x) / from.k
    const fromCenterY = (h / 2 - from.y) / from.k
    const toCenterX = (w / 2 - to.x) / to.k
    const toCenterY = (h / 2 - to.y) / to.k
    const centerX = fromCenterX + (toCenterX - fromCenterX) * t
    const centerY = fromCenterY + (toCenterY - fromCenterY) * t

    this.eventTransform = new ZoomTransform(k, w / 2 - centerX * k, h / 2 - centerY * k)
    this.updateTransformMatrix()
    this.config.onZoom?.({ transform: this.eventTransform, userDriven: false })

    if (linear >= 1) {
      this.animation = undefined
      this.isRunning = false
      this.config.onZoomEnd?.({ transform: this.eventTransform, userDriven: false })
      return false
    }
    return true
  }

  public get isAnimating (): boolean {
    return this.animation !== undefined
  }

  public stopAnimation (): void {
    if (!this.animation) return
    this.animation = undefined
    this.isRunning = false
  }

  /**
   * Rebuilds the matrix the shaders read from `eventTransform`.
   *
   * The chain maps a point given in `[-1, 1]` normalized space through the
   * half-extent scale, the view centre, the pan/zoom, and finally a pixel →
   * clip projection. The Y flip at the end reconciles simulation space
   * (Y up) with clip space as the rest of the chain leaves it.
   */
  private updateTransformMatrix (): void {
    const { x, y, k } = this.eventTransform
    const { transform, screenSize } = this.store
    const w = screenSize[0]
    const h = screenSize[1]
    if (!w || !h) return

    mat3.projection(transform, w, h)
    mat3.translate(transform, transform, x, y)
    mat3.scale(transform, transform, k, k)
    mat3.translate(transform, transform, w / 2, h / 2)
    mat3.scale(transform, transform, w / 2, h / 2)
    mat3.scale(transform, transform, 1, -1)
  }

  /** Recomputes the matrix after a screen resize, keeping the transform. */
  public refresh (): void {
    this.updateTransformMatrix()
  }

  /**
   * The transform that fits `positions` into the viewport.
   *
   * @param positions Flat `[x0, y0, x1, y1, …]` in simulation space.
   * @param scale Overrides the fitted scale.
   * @param padding Fraction of the viewport left empty on each side.
   */
  public getTransform (positions: number[] | Float32Array, scale?: number, padding = 0.1): ZoomTransform {
    if (positions.length === 0) return this.eventTransform
    const [width, height] = this.store.screenSize

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < positions.length; i += 2) {
      const x = positions[i] as number
      const y = positions[i + 1] as number
      // Absent points hold NaN and must not affect the extent.
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }

    // Nothing finite to fit: keep the current view rather than emitting a NaN
    // transform, which would blank the screen.
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return this.eventTransform

    const xExtent: [number, number] = [this.store.scaleX(minX), this.store.scaleX(maxX)]
    const yExtent: [number, number] = [this.store.scaleY(minY), this.store.scaleY(maxY)]
    // A single point, or a perfectly axis-aligned line, has zero extent on one
    // axis — widen it by a pixel so the scale stays finite.
    if (xExtent[0] === xExtent[1]) {
      xExtent[0] -= 0.5
      xExtent[1] += 0.5
    }
    if (yExtent[0] === yExtent[1]) {
      yExtent[0] += 0.5
      yExtent[1] -= 0.5
    }

    const xScale = (width * (1 - padding * 2)) / (xExtent[1] - xExtent[0])
    const yScale = (height * (1 - padding * 2)) / (yExtent[0] - yExtent[1])
    const clampedScale = clamp(scale ?? Math.min(xScale, yScale), this.scaleExtent[0], this.scaleExtent[1])
    const xCenter = (xExtent[1] + xExtent[0]) / 2
    const yCenter = (yExtent[1] + yExtent[0]) / 2

    return new ZoomTransform(
      clampedScale,
      width / 2 - xCenter * clampedScale,
      height / 2 - yCenter * clampedScale
    )
  }

  public getDistanceToPoint (position: [number, number]): number {
    const { x, y, k } = this.eventTransform
    const point = this.getTransform(position, k)
    const dx = x - point.x
    const dy = y - point.y
    return Math.sqrt(dx * dx + dy * dy)
  }

  /** A transform centred halfway between the current view and `position`. */
  public getMiddlePointTransform (position: [number, number]): ZoomTransform {
    if (!Number.isFinite(position[0]) || !Number.isFinite(position[1])) return this.eventTransform
    const [width, height] = this.store.screenSize
    const { x, y, k } = this.eventTransform
    const currentX = (width / 2 - x) / k
    const currentY = (height / 2 - y) / k
    const pointX = this.store.scaleX(position[0])
    const pointY = this.store.scaleY(position[1])
    const centerX = (currentX + pointX) / 2
    const centerY = (currentY + pointY) / 2

    return new ZoomTransform(1, width / 2 - centerX, height / 2 - centerY)
  }

  public convertScreenToSpacePosition (screenPosition: [number, number]): [number, number] {
    const { x, y, k } = this.eventTransform
    const [w, h] = this.store.screenSize
    const invertedX = (screenPosition[0] - x) / k
    const invertedY = (screenPosition[1] - y) / k
    return [
      invertedX - (w - this.store.adjustedSpaceSize) / 2,
      (h - invertedY) - (h - this.store.adjustedSpaceSize) / 2,
    ]
  }

  public convertSpaceToScreenPosition (spacePosition: [number, number]): [number, number] {
    return [
      this.eventTransform.applyX(this.store.scaleX(spacePosition[0])),
      this.eventTransform.applyY(this.store.scaleY(spacePosition[1])),
    ]
  }

  /**
   * A point's on-screen radius in pixels.
   *
   * With `scalePointsOnZoom` off, points still grow slightly with zoom — the
   * damped `k * 0.01` term — so that zooming into a dense cluster separates it
   * visually instead of leaving a wall of identical dots.
   */
  public convertSpaceToScreenRadius (spaceRadius: number): number {
    const { scalePointsOnZoom } = this.config
    const { maxPointSize } = this.store
    const { k } = this.eventTransform
    let size = spaceRadius * 2
    if (scalePointsOnZoom) size *= k
    else size *= Math.min(5.0, Math.max(1.0, k * 0.01))
    return Math.min(size, maxPointSize) / 2
  }
}

function easeCubicInOut (t: number): number {
  return ((t *= 2) <= 1 ? t * t * t : (t -= 2) * t * t + 2) / 2
}
