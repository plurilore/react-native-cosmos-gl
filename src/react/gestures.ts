import type { Graph } from '../core/graph'
import { ZoomTransform } from '../core/zoom-transform'
import { currentTime } from '../core/transition'
import type { CosmosPointerEvent } from '../core/config'

/**
 * Translates raw gesture callbacks into engine operations.
 *
 * Deliberately not a React hook and not tied to `react-native-gesture-handler`:
 * it takes plain numbers, so the same logic serves RNGH on device, mouse and
 * wheel events on web, and a test that drives it directly.
 *
 * The engine's view transform is the single source of truth throughout — a
 * gesture reads it, produces the next one, and hands it back. Nothing here
 * keeps a shadow copy that could drift from what is on screen.
 */
export class GestureController {
  private readonly graph: Graph
  /** Transform at the start of the current pan or pinch. */
  private gestureStartTransform: ZoomTransform | undefined
  /** Whether the active pan is dragging a point rather than panning the view. */
  private isDraggingPoint = false
  private isGestureActive = false

  public constructor (graph: Graph) {
    this.graph = graph
  }

  public get isActive (): boolean {
    return this.isGestureActive
  }

  /**
   * Begins a pan.
   *
   * When dragging is enabled, a pan that starts on a point moves that point
   * instead of the view — which is why the pick has to happen here, at the
   * first touch, rather than on the first movement: by then the gesture has
   * already committed to one behaviour or the other.
   */
  public onPanStart (x: number, y: number): void {
    this.isGestureActive = true
    this.gestureStartTransform = this.graph.zoomTransform

    if (this.graph.config.enableDrag) {
      const index = this.graph.startDrag(x, y)
      this.isDraggingPoint = index !== undefined
      if (this.isDraggingPoint) return
    }
    this.isDraggingPoint = false
    if (this.graph.config.enableZoom) this.graph.zoomInstance.start(true)
  }

  /** `translationX` / `translationY` are cumulative from the gesture's start. */
  public onPanUpdate (x: number, y: number, translationX: number, translationY: number): void {
    if (this.isDraggingPoint) {
      this.graph.moveDrag(x, y)
      return
    }
    const start = this.gestureStartTransform
    if (!start || !this.graph.config.enableZoom) return
    // Translation is applied in screen space, so panning tracks the finger
    // exactly regardless of zoom level.
    this.graph.setZoomTransform(new ZoomTransform(start.k, start.x + translationX, start.y + translationY), true)
  }

  public onPanEnd (x: number, y: number): void {
    if (this.isDraggingPoint) {
      this.graph.endDrag(x, y)
      this.isDraggingPoint = false
    } else if (this.graph.config.enableZoom) {
      this.graph.zoomInstance.end(true)
    }
    this.gestureStartTransform = undefined
    this.isGestureActive = false
  }

  public onPinchStart (): void {
    this.isGestureActive = true
    this.gestureStartTransform = this.graph.zoomTransform
    if (this.graph.config.enableZoom) this.graph.zoomInstance.start(true)
  }

  /**
   * `scale` is cumulative from the gesture's start; `focalX` / `focalY` are the
   * midpoint between the fingers, which stays pinned under them.
   */
  public onPinchUpdate (scale: number, focalX: number, focalY: number): void {
    const start = this.gestureStartTransform
    if (!start || !this.graph.config.enableZoom) return
    this.graph.setZoomTransform(start.scaleAbout(scale, focalX, focalY), true)
  }

  public onPinchEnd (): void {
    if (this.graph.config.enableZoom) this.graph.zoomInstance.end(true)
    this.gestureStartTransform = undefined
    this.isGestureActive = false
  }

  public onTap (x: number, y: number): void {
    this.graph.handleTap(this.buildEvent(x, y, false))
  }

  public onLongPress (x: number, y: number): void {
    this.graph.handleTap(this.buildEvent(x, y, true))
  }

  public onHover (x: number, y: number): void {
    this.graph.handlePointerMove(this.buildEvent(x, y, false))
  }

  /**
   * A wheel or trackpad zoom, for web and desktop hosts.
   *
   * `delta` is the raw wheel delta; the exponential mapping gives the same
   * proportional zoom per notch at every scale, which is what makes zooming
   * feel uniform rather than accelerating as you go in.
   */
  public onWheel (delta: number, x: number, y: number): void {
    if (!this.graph.config.enableZoom) return
    const factor = Math.exp(-delta * 0.002)
    this.graph.setZoomTransform(this.graph.zoomTransform.scaleAbout(factor, x, y), true)
  }

  /** A double tap, zooming in about the tapped point. */
  public onDoubleTap (x: number, y: number, factor = 2, duration = 250): void {
    if (!this.graph.config.enableZoom) return
    this.graph.zoomInstance.animateTo(this.graph.zoomTransform.scaleAbout(factor, x, y), duration)
  }

  private buildEvent (x: number, y: number, isSecondary: boolean): CosmosPointerEvent {
    return {
      x,
      y,
      timestamp: currentTime(),
      pointerType: 'touch',
      pointerCount: 1,
      isSecondary,
    }
  }
}
