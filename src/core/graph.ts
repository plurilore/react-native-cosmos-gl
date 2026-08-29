import { Device, type GL } from '../gl'
import { GraphData, type PointImageData } from './graph-data'
import { PointShape, LinkStyle } from './enums'
import { Store, ALPHA_MIN, MAX_POINT_SIZE } from './store'
import { Zoom } from './zoom'
import { ZoomTransform, zoomIdentity } from './zoom-transform'
import { Transition, TransitionProperty, currentTime } from './transition'
import { Points } from './modules/points'
import { Lines } from './modules/lines'
import {
  ForceGravity,
  ForceCenter,
  ForceMouse,
  ForceLink,
  ForceManyBody,
  LinkDirection,
} from './modules/forces'
import { Clusters } from './modules/clusters'
import { ForceCollision } from './modules/force-collision'
import {
  createDefaultConfig,
  applyConfig,
  resetConfigToDefaults,
} from './variables'
import type { GraphConfig, GraphConfigInterface, CosmosPointerEvent } from './config'
import { getRgbaColor } from './color'
import { textureSizeFor, clamp } from './helper'

export type { GraphConfig, GraphConfigInterface }

/**
 * A GPU-accelerated force graph.
 *
 * Unlike the web engine this class does not own a canvas, a render loop, or any
 * input handling. It is handed a WebGL2 context, and `render()` draws exactly
 * one frame when something else calls it. That inversion is what lets the same
 * engine sit under an `expo-gl` surface on a phone and a `<canvas>` on the web:
 * the host owns the frame clock and the gestures, and feeds this both.
 */
export class Graph {
  public readonly device: Device
  public readonly config: GraphConfigInterface
  public readonly store = new Store()
  public readonly data: GraphData
  public readonly zoomInstance: Zoom
  public readonly transition: Transition

  public points: Points | undefined
  public lines: Lines | undefined

  private forceGravity: ForceGravity | undefined
  private forceCenter: ForceCenter | undefined
  private forceManyBody: ForceManyBody | undefined
  private forceLinkIncoming: ForceLink | undefined
  private forceLinkOutgoing: ForceLink | undefined
  private forceMouse: ForceMouse | undefined
  private forceCollision: ForceCollision | undefined
  private clusters: Clusters | undefined
  /** Collision resources are allocated on first use, then kept until data changes. */
  private isForceCollisionReady = false
  private isPointClusterUpdateNeeded = false

  private isDestroyed = false
  private hasInitialized = false
  /** Set by any data setter; consumed by the next `render()`. */
  private isDataUpdateNeeded = false
  private isPointPositionsUpdateNeeded = false
  private isPointColorUpdateNeeded = false
  private isPointSizeUpdateNeeded = false
  private isPointShapeUpdateNeeded = false
  private isLinkUpdateNeeded = false
  private isLinkColorUpdateNeeded = false
  private isLinkWidthUpdateNeeded = false
  private isForceLinkUpdateNeeded = false
  private isForceManyBodyUpdateNeeded = false
  private isPointStatusUpdateNeeded = false

  private isRepulsionFromPointerActive = false
  private fitViewTimeout: ReturnType<typeof setTimeout> | undefined
  private hasFitViewOnInitRun = false

  public constructor (gl: GL, config?: GraphConfig) {
    this.device = new Device(gl)
    this.config = createDefaultConfig()
    if (config) applyConfig(this.config, config)

    this.data = new GraphData(this.config)
    this.transition = new Transition(this.config)
    this.zoomInstance = new Zoom(this.store, this.config)

    if (this.config.randomSeed !== undefined) this.store.addRandomSeed(this.config.randomSeed)
    this.store.setMaxTextureSize(this.device.features.maxTextureSize)
    this.store.adjustSpaceSize(this.config.spaceSize, this.device.features.maxTextureSize)
    this.store.maxPointSize = Math.min(MAX_POINT_SIZE, this.readMaxPointSize())
    this.applyConfigToStore()

    if (this.config.initialZoomLevel !== undefined) {
      this.zoomInstance.eventTransform = new ZoomTransform(this.config.initialZoomLevel, 0, 0)
    }

    this.points = new Points(this.device, this.config, this.store, this.data)
    this.points.transition = this.transition
    this.lines = new Lines(this.device, this.config, this.store, this.data, this.points)
    this.lines.transition = this.transition

    this.forceGravity = new ForceGravity(this.device, this.config, this.store, this.data, this.points)
    this.forceCenter = new ForceCenter(this.device, this.config, this.store, this.data, this.points)
    this.forceManyBody = new ForceManyBody(this.device, this.config, this.store, this.data, this.points)
    this.forceLinkIncoming = new ForceLink(this.device, this.config, this.store, this.data, this.points)
    this.forceLinkOutgoing = new ForceLink(this.device, this.config, this.store, this.data, this.points)
    this.forceMouse = new ForceMouse(this.device, this.config, this.store, this.data, this.points)
    this.forceCollision = new ForceCollision(this.device, this.config, this.store, this.data, this.points)
    this.clusters = new Clusters(this.device, this.config, this.store, this.data, this.points)
  }

  public get isSimulationRunning (): boolean {
    return this.store.isSimulationRunning
  }

  public get progress (): number {
    return this.store.simulationProgress
  }

  /** The current view transform. */
  public get zoomTransform (): ZoomTransform {
    return this.zoomInstance.eventTransform
  }

  // ---------------------------------------------------------------- data ---

  /**
   * Point positions as `[x0, y0, x1, y1, …]`. Establishes the index space every
   * other per-point array aligns to.
   *
   * A `NaN` pair marks an absent point: it is excluded from physics, drawing and
   * picking, and animates out rather than disappearing. That is how a point is
   * removed without renumbering everything after it.
   */
  public setPointPositions (positions: Float32Array): void {
    this.data.inputPointPositions = positions
    this.isPointPositionsUpdateNeeded = true
    this.isDataUpdateNeeded = true
    this.transition.queue(TransitionProperty.Positions)
  }

  /** Link endpoints as `[source0, target0, source1, target1, …]` of point indices. */
  public setLinks (links: Float32Array): void {
    this.data.inputLinks = links
    this.isLinkUpdateNeeded = true
    this.isForceLinkUpdateNeeded = true
    this.isDataUpdateNeeded = true
  }

  /** Per-point RGBA in `0..1`, four values per point. `NaN` means "use the default". */
  public setPointColors (colors: Float32Array): void {
    this.data.inputPointColors = colors
    this.isPointColorUpdateNeeded = true
    this.isDataUpdateNeeded = true
    this.transition.queue(TransitionProperty.PointColors)
  }

  /** Per-point size. `NaN` means "use the default". */
  public setPointSizes (sizes: Float32Array): void {
    this.data.inputPointSizes = sizes
    this.isPointSizeUpdateNeeded = true
    this.isDataUpdateNeeded = true
    this.transition.queue(TransitionProperty.PointSizes)
  }

  /** Per-point shape, as `PointShape` values. */
  public setPointShapes (shapes: Float32Array): void {
    this.data.inputPointShapes = shapes
    this.isPointShapeUpdateNeeded = true
    this.isDataUpdateNeeded = true
  }

  public setLinkColors (colors: Float32Array): void {
    this.data.inputLinkColors = colors
    this.isLinkColorUpdateNeeded = true
    this.isDataUpdateNeeded = true
    this.transition.queue(TransitionProperty.LinkColors)
  }

  public setLinkWidths (widths: Float32Array): void {
    this.data.inputLinkWidths = widths
    this.isLinkWidthUpdateNeeded = true
    this.isDataUpdateNeeded = true
    this.transition.queue(TransitionProperty.LinkWidths)
  }

  public setLinkStyles (styles: Float32Array): void {
    this.data.inputLinkStyles = styles
    this.isDataUpdateNeeded = true
  }

  public setLinkArrows (arrows: boolean[]): void {
    this.data.linkArrowsBoolean = arrows
    this.isDataUpdateNeeded = true
  }

  public setLinkStrength (strength: Float32Array): void {
    this.data.inputLinkStrength = strength
    this.isForceLinkUpdateNeeded = true
    this.isDataUpdateNeeded = true
  }

  /** Point indices held in place by the simulation. */
  public setPinnedPoints (indices: number[]): void {
    this.data.inputPinnedPoints = indices
    this.isDataUpdateNeeded = true
  }

  /**
   * Assigns each point to a cluster, as `[cluster0, cluster1, …]` aligned to the
   * point index space. `undefined` leaves a point unclustered and unaffected by
   * the cluster force.
   */
  public setPointClusters (clusters: (number | undefined)[]): void {
    this.data.inputPointClusters = clusters
    this.isPointClusterUpdateNeeded = true
    this.isDataUpdateNeeded = true
  }

  /**
   * Pins clusters to explicit positions as `[x0, y0, x1, y1, …]`, indexed by
   * cluster. A cluster with no position given is pulled toward the centroid of
   * its own members instead.
   */
  public setClusterPositions (positions: (number | undefined)[]): void {
    this.data.inputClusterPositions = positions
    this.isPointClusterUpdateNeeded = true
    this.isDataUpdateNeeded = true
  }

  /** Per-point multiplier on the cluster force, aligned to the point index space. */
  public setPointClusterStrength (strength: Float32Array): void {
    this.data.inputClusterStrength = strength
    this.isPointClusterUpdateNeeded = true
    this.isDataUpdateNeeded = true
  }

  public setPointImages (images: PointImageData[], indices: Float32Array, sizes?: Float32Array): void {
    this.data.inputImageData = images
    this.data.inputPointImageIndices = indices
    if (sizes) this.data.inputPointImageSizes = sizes
    this.isDataUpdateNeeded = true
  }

  // -------------------------------------------------------------- config ---

  /** Replaces the configuration, resetting anything omitted to its default. */
  public setConfig (config: GraphConfig): void {
    // `initialZoomLevel` and `randomSeed` describe how the graph was created,
    // not how it currently looks, so they survive a reset that would otherwise
    // silently re-seed the layout.
    const preserved = {
      initialZoomLevel: this.config.initialZoomLevel,
      randomSeed: this.config.randomSeed,
    }
    resetConfigToDefaults(this.config)
    Object.assign(this.config, preserved)
    applyConfig(this.config, config)
    this.applyConfigToStore()
  }

  /** Updates individual properties, leaving the rest as they are. */
  public setConfigPartial (config: GraphConfig): void {
    applyConfig(this.config, config, true)
    this.applyConfigToStore()
  }

  // -------------------------------------------------------------- viewport ---

  /**
   * Sets the drawing surface size in logical pixels.
   *
   * Called by the host whenever the view is laid out. Anything sized by the
   * screen — the picking buffer, the projection — rebuilds from here.
   */
  public setSize (width: number, height: number): void {
    if (this.store.screenSize[0] === width && this.store.screenSize[1] === height) return
    this.store.updateScreenSize(width, height)
    this.zoomInstance.refresh()
    if (this.points) this.points.isPickingBufferStale = true
  }

  // -------------------------------------------------------------- lifecycle ---

  /**
   * Draws one frame: applies pending data updates, advances the simulation and
   * any transition, then renders points and links.
   *
   * `viewport` is in device pixels — the drawing buffer's own size, which is
   * the logical size times the pixel ratio.
   */
  public render (viewport: readonly [number, number, number, number]): void {
    if (this.isDestroyed) return
    const { points, lines } = this
    if (!points || !lines) return

    if (!this.hasInitialized) {
      points.create()
      lines.initPrograms()
      this.hasInitialized = true
    }

    if (this.isDataUpdateNeeded) this.applyDataUpdates()

    const now = currentTime()
    if (this.transition.isPending) this.transition.start(now)
    if (this.transition.isActive) {
      this.transition.step(now)
      this.applyTransitionProgress()
    }
    this.zoomInstance.step(now)

    this.runSimulationStep()
    // After every write to the position texture, so the label cache describes
    // this frame rather than the one before it.
    points.trackPoints()

    const [, , bufferWidth, bufferHeight] = viewport
    this.device.setViewport(0, 0, bufferWidth, bufferHeight)
    this.clearBackground()

    if (this.config.renderLinks) lines.draw(viewport, null)
    points.draw(viewport, null)
  }

  /** Starts (or restarts) the simulation with a full alpha. */
  public start (alpha = 1): void {
    if (!this.config.enableSimulation) return
    this.store.alpha = clamp(alpha, 0, 1)
    this.store.isSimulationRunning = true
    this.config.onSimulationStart?.()
  }

  /** Stops the simulation and settles alpha to zero. */
  public stop (): void {
    if (!this.store.isSimulationRunning) return
    this.store.isSimulationRunning = false
    this.store.alpha = 0
    this.config.onSimulationEnd?.()
  }

  public pause (): void {
    if (!this.store.isSimulationRunning) return
    this.store.isSimulationRunning = false
    this.config.onSimulationPause?.()
  }

  public unpause (): void {
    if (this.store.isSimulationRunning || !this.config.enableSimulation) return
    this.store.isSimulationRunning = true
    this.config.onSimulationUnpause?.()
  }

  /** Advances the simulation by one tick, even while paused. */
  public step (): void {
    this.runSimulationStep(true)
  }

  /** Restarts the simulation from a warm alpha, as after a data change. */
  public restart (alpha = 1): void {
    this.start(alpha)
  }

  public destroy (): void {
    if (this.isDestroyed) return
    this.isDestroyed = true
    if (this.fitViewTimeout !== undefined) clearTimeout(this.fitViewTimeout)
    this.forceGravity?.destroy()
    this.forceCenter?.destroy()
    this.forceManyBody?.destroy()
    this.forceLinkIncoming?.destroy()
    this.forceLinkOutgoing?.destroy()
    this.forceMouse?.destroy()
    this.forceCollision?.destroy()
    this.clusters?.destroy()
    this.lines?.destroy()
    this.points?.destroy()
    this.points = undefined
    this.lines = undefined
  }

  // ---------------------------------------------------------------- view ---

  /** Fits every point into the viewport. */
  public fitView (duration = this.config.fitViewDuration, padding = this.config.fitViewPadding): void {
    const positions = this.getPointPositions()
    if (positions.length === 0) return
    this.zoomInstance.animateTo(this.zoomInstance.getTransform(positions, undefined, padding), duration)
  }

  /** Fits the given points into the viewport. */
  public fitViewByPointIndices (indices: number[], duration = this.config.fitViewDuration, padding = this.config.fitViewPadding): void {
    const all = this.getPointPositions()
    const subset = new Float32Array(indices.length * 2)
    indices.forEach((index, i) => {
      subset[i * 2] = all[index * 2] as number
      subset[i * 2 + 1] = all[index * 2 + 1] as number
    })
    this.zoomInstance.animateTo(this.zoomInstance.getTransform(subset, undefined, padding), duration)
  }

  public setZoomLevel (level: number, duration = 0): void {
    const [width, height] = this.store.screenSize
    const { x, y, k } = this.zoomInstance.eventTransform
    // Zoom about the view centre, so the content under the middle of the screen
    // stays put rather than the origin drifting into view.
    const factor = level / k
    const target = new ZoomTransform(
      level,
      width / 2 - (width / 2 - x) * factor,
      height / 2 - (height / 2 - y) * factor
    )
    this.zoomInstance.animateTo(target, duration)
  }

  public getZoomLevel (): number {
    return this.zoomInstance.eventTransform.k
  }

  /** Applies a view transform directly. Used by the host's gesture handlers. */
  public setZoomTransform (transform: ZoomTransform, userDriven = true): void {
    this.zoomInstance.setTransform(transform, userDriven)
    if (this.points) this.points.isPickingBufferStale = true
    this.lines?.markLinkPickingStale()
  }

  public spaceToScreenPosition (position: [number, number]): [number, number] {
    return this.zoomInstance.convertSpaceToScreenPosition(position)
  }

  public screenToSpacePosition (position: [number, number]): [number, number] {
    return this.zoomInstance.convertScreenToSpacePosition(position)
  }

  // ------------------------------------------------------------ interaction ---

  /**
   * The point at a screen position, or `undefined`.
   *
   * Coordinates are logical pixels with a top-left origin — what a gesture
   * handler reports.
   */
  public findPointOnScreen (x: number, y: number): { index: number; position: [number, number] } | undefined {
    return this.points?.findPointOnScreen(x, y)
  }

  /**
   * The link under a screen position, or `undefined`.
   *
   * Only runs when a link callback is configured — the index buffer costs a
   * pass over every link, and a graph nobody picks links on should not build
   * one.
   */
  public findLinkOnScreen (x: number, y: number): number | undefined {
    if (!this.store.isLinkHoveringEnabled) return undefined
    return this.lines?.findLinkOnScreen(x, y)
  }

  /** Begins dragging the point under `(x, y)`, if there is one. */
  public startDrag (x: number, y: number): number | undefined {
    if (!this.config.enableDrag) return undefined
    const hovered = this.findPointOnScreen(x, y)
    if (!hovered) return undefined
    this.store.draggingPointIndex = hovered.index
    this.store.hoveredPoint = hovered
    this.config.onDragStart?.({ pointIndex: hovered.index, x, y })
    return hovered.index
  }

  public moveDrag (x: number, y: number): void {
    const index = this.store.draggingPointIndex
    if (index === undefined) return
    this.store.pointerPosition = this.zoomInstance.convertScreenToSpacePosition([x, y])
    this.store.screenPointerPosition = [x, y]
    this.config.onDrag?.({ pointIndex: index, x, y })
  }

  public endDrag (x: number, y: number): void {
    const index = this.store.draggingPointIndex
    if (index === undefined) return
    this.store.draggingPointIndex = undefined
    this.config.onDragEnd?.({ pointIndex: index, x, y })
  }

  /** Reports a tap, dispatching to the point, link or background callbacks. */
  public handleTap (event: CosmosPointerEvent): void {
    const hovered = this.findPointOnScreen(event.x, event.y)
    // Points win over links: a point drawn on top of its own edges is what the
    // finger was aiming at, and a link is only the target where no point is.
    const linkIndex = hovered ? undefined : this.findLinkOnScreen(event.x, event.y)

    if (event.isSecondary) {
      this.config.onContextMenu?.(hovered?.index, hovered?.position, event)
      if (hovered) this.config.onPointContextMenu?.(hovered.index, hovered.position, event)
      else if (linkIndex !== undefined) this.config.onLinkContextMenu?.(linkIndex, event)
      else this.config.onBackgroundContextMenu?.(event)
      return
    }

    this.config.onClick?.(hovered?.index, hovered?.position, event)
    if (hovered) this.config.onPointClick?.(hovered.index, hovered.position, event)
    else if (linkIndex !== undefined) this.config.onLinkClick?.(linkIndex, event)
    else this.config.onBackgroundClick?.(event)
  }

  /**
   * Reports pointer movement, updating hover state.
   *
   * Picking runs only when a hover callback is configured and the pointer has
   * actually moved — a resting finger jitters by a pixel or two from
   * contact-area noise alone, and each pick costs a GPU readback.
   */
  public handlePointerMove (event: CosmosPointerEvent): void {
    const { store, config } = this
    store.screenPointerPosition = [event.x, event.y]
    store.pointerPosition = this.zoomInstance.convertScreenToSpacePosition([event.x, event.y])
    config.onMouseMove?.(store.hoveredPoint?.index, store.hoveredPoint?.position, event)

    // The ring is drawn from `store.hoveredPoint`, so it needs the pick even
    // when no callback wants to hear about it.
    const wantsPointHover = Boolean(
      config.onPointMouseOver || config.onPointMouseOut || config.renderHoveredPointRing
    )
    if (!wantsPointHover && !store.isLinkHoveringEnabled) return

    const hovered = wantsPointHover || store.isLinkHoveringEnabled
      ? this.findPointOnScreen(event.x, event.y)
      : undefined

    if (wantsPointHover && hovered?.index !== store.hoveredPoint?.index) {
      store.hoveredPoint = hovered
      if (hovered) {
        config.onPointMouseOver?.(
          hovered.index,
          hovered.position,
          event,
          store.highlightedPointSet?.has(hovered.index),
          store.outlinedPointSet?.has(hovered.index)
        )
      } else {
        config.onPointMouseOut?.(event)
      }
    } else if (wantsPointHover) {
      store.hoveredPoint = hovered
    }

    if (!store.isLinkHoveringEnabled) return
    // A point under the pointer occludes any link beneath it, so the link hover
    // clears rather than reporting an edge the finger is not actually over.
    const linkIndex = hovered ? undefined : this.findLinkOnScreen(event.x, event.y)
    if (linkIndex === store.hoveredLinkIndex) return

    store.hoveredLinkIndex = linkIndex
    if (linkIndex !== undefined) config.onLinkMouseOver?.(linkIndex)
    else config.onLinkMouseOut?.(event)
  }

  /** Turns pointer repulsion on or off, for a press-and-hold interaction. */
  public setRepulsionFromPointer (active: boolean): void {
    this.isRepulsionFromPointerActive = active
  }

  // --------------------------------------------------------------- getters ---

  /**
   * Point indices inside a screen-space rectangle, given as two opposite
   * corners in logical pixels.
   */
  public findPointsInRect (rect: [[number, number], [number, number]]): number[] {
    return this.points?.findPointsInRect(rect) ?? []
  }

  /**
   * Point indices inside a screen-space polygon — the lasso-selection query.
   * The path is a list of vertices in logical pixels and is treated as closed.
   */
  public findPointsInPolygon (path: [number, number][]): number[] {
    return this.points?.findPointsInPolygon(path) ?? []
  }

  /** Current cluster centroids as `[x0, y0, x1, y1, …]`, indexed by cluster. */
  public getClusterPositions (): readonly number[] {
    if (!this.clusters || this.data.pointClusters === undefined) return []
    return this.clusters.getCentroidPositions()
  }

  /** Current point positions, read back from the GPU. */
  public getPointPositions (): Float32Array {
    return this.points?.getPointPositions() ?? new Float32Array()
  }

  public getNeighboringPointIndices (pointIndices: number | number[]): number[] {
    return this.data.getNeighboringPointIndices(pointIndices)
  }

  public getConnectedLinkIndices (pointIndices: number | number[]): number[] {
    return this.data.getConnectedLinkIndices(pointIndices)
  }

  public getConnectedPointIndices (linkIndices: number | number[]): number[] {
    return this.data.getConnectedPointIndices(linkIndices)
  }

  public get pointsNumber (): number {
    return this.data.pointsNumber ?? 0
  }

  public get linksNumber (): number {
    return this.data.linksNumber ?? 0
  }

  // --------------------------------------------------------------- internals ---

  private applyDataUpdates (): void {
    const { points, lines, store, data } = this
    if (!points || !lines) return

    this.isDataUpdateNeeded = false
    data.update()

    store.pointsTextureSize = textureSizeFor(data.pointsNumber ?? 0)
    store.linksTextureSize = textureSizeFor(data.linksNumber ?? 0)

    // Order matters: exit status is derived from positions and read by the
    // integrator, the forces, drawing and picking, so it has to be current
    // before any of them run.
    if (this.isPointPositionsUpdateNeeded) {
      points.updatePositions()
      points.updateExit()
      points.updatePinnedStatus()
      this.isPointPositionsUpdateNeeded = false
      this.isForceManyBodyUpdateNeeded = true
      this.isPointStatusUpdateNeeded = true
      // Every per-point channel is regenerated by `data.update()` — filled with
      // defaults when the caller supplied none — and the draw needs a buffer
      // for all of them. Without this, a graph given only positions has no
      // colour, size or shape buffer and the draw silently does nothing.
      this.isPointColorUpdateNeeded = true
      this.isPointSizeUpdateNeeded = true
      this.isPointShapeUpdateNeeded = true
    }
    if (this.isPointColorUpdateNeeded) {
      points.updateColor()
      this.isPointColorUpdateNeeded = false
    }
    if (this.isPointSizeUpdateNeeded) {
      points.updateSize()
      this.isPointSizeUpdateNeeded = false
    }
    if (this.isPointShapeUpdateNeeded) {
      points.updateShape()
      points.updateImages()
      this.isPointShapeUpdateNeeded = false
    }
    if (this.isPointStatusUpdateNeeded) {
      points.updatePointStatus()
      this.isPointStatusUpdateNeeded = false
    }

    if (this.isLinkUpdateNeeded) {
      // Same rule on the link side: colours and widths are regenerated with
      // defaults, and the draw needs their buffers.
      this.isLinkColorUpdateNeeded = true
      this.isLinkWidthUpdateNeeded = true
      lines.updatePointsBuffer()
      lines.updateArrow()
      lines.updateStyle()
      lines.updateLinkStatus()
      this.isLinkUpdateNeeded = false
    }
    if (this.isLinkColorUpdateNeeded) {
      lines.updateColor()
      this.isLinkColorUpdateNeeded = false
    }
    if (this.isLinkWidthUpdateNeeded) {
      lines.updateWidth()
      this.isLinkWidthUpdateNeeded = false
    }
    lines.create()

    if (this.config.enableSimulation) {
      if (this.isForceManyBodyUpdateNeeded) {
        this.forceManyBody?.create()
        this.forceManyBody?.initPrograms()
        this.isForceManyBodyUpdateNeeded = false
      }
      if (this.isForceLinkUpdateNeeded && store.linksTextureSize) {
        this.forceLinkIncoming?.create(LinkDirection.Incoming)
        this.forceLinkOutgoing?.create(LinkDirection.Outgoing)
        this.forceLinkIncoming?.initPrograms()
        this.forceLinkOutgoing?.initPrograms()
        this.isForceLinkUpdateNeeded = false
      }
      this.forceCenter?.create()
      this.forceGravity?.initPrograms()
      this.forceCenter?.initPrograms()
      this.forceMouse?.initPrograms()

      if (this.isPointClusterUpdateNeeded) {
        this.clusters?.create()
        this.clusters?.initPrograms()
        this.isPointClusterUpdateNeeded = false
      }
      // Point count or sizes changed, so the collision grid no longer matches.
      // Left unallocated until the force actually runs.
      this.isForceCollisionReady = false
    }

    this.scheduleFitViewOnInit()
  }

  /**
   * One simulation tick.
   *
   * Each force gets its own swap → run → integrate cycle rather than
   * accumulating into a shared velocity. The swap before every write is what
   * makes `previous` hold the freshest positions for the shader to read while
   * `current` receives the result.
   */
  private runSimulationStep (forceExecution = false): void {
    const { config, store, points } = this
    if (!config.enableSimulation || !points) return

    if (this.isRepulsionFromPointerActive && config.enableRightClickRepulsion) {
      points.swapFbo()
      this.forceMouse?.run()
      points.updatePosition()
      points.isPickingBufferStale = true
    }

    const enableSimulationDuringZoom =
      this.zoomInstance.shouldEnableSimulationDuringZoomOverride ?? config.enableSimulationDuringZoom
    const shouldRun = forceExecution ||
      (store.isSimulationRunning && !(this.zoomInstance.isRunning && !enableSimulationDuringZoom))
    if (!shouldRun) return

    if (config.simulationGravity) {
      points.swapFbo()
      this.forceGravity?.run()
      points.updatePosition()
    }
    if (config.simulationCenter) {
      points.swapFbo()
      this.forceCenter?.run()
      points.updatePosition()
    }

    points.swapFbo()
    this.forceManyBody?.run()
    points.updatePosition()

    if (store.linksTextureSize) {
      points.swapFbo()
      this.forceLinkIncoming?.run()
      points.updatePosition()
      points.swapFbo()
      this.forceLinkOutgoing?.run()
      points.updatePosition()
    }

    if (this.data.pointClusters || this.data.clusterPositions) {
      points.swapFbo()
      this.clusters?.run()
      points.updatePosition()
    }

    // Collision runs after the attraction forces so it corrects the overlap
    // they introduce within the same tick, instead of lagging a frame behind
    // and oscillating against them.
    if (config.simulationCollision) {
      if (!this.isForceCollisionReady) {
        this.forceCollision?.create()
        this.forceCollision?.initPrograms()
        this.isForceCollisionReady = true
      }
      points.swapFbo()
      this.forceCollision?.run()
      points.updatePosition()
    }

    if (store.draggingPointIndex !== undefined) {
      points.swapFbo()
      points.drag()
    }

    points.isPickingBufferStale = true
    this.lines?.markLinkPickingStale()

    store.alpha += store.addAlpha(config.simulationDecay)
    if (this.isRepulsionFromPointerActive && config.enableRightClickRepulsion) {
      store.alpha = Math.max(store.alpha, 0.1)
    }
    store.simulationProgress = Math.sqrt(Math.min(1, ALPHA_MIN / store.alpha))

    config.onSimulationTick?.(store.alpha, store.hoveredPoint?.index, store.hoveredPoint?.position)

    if (store.alpha <= ALPHA_MIN && store.isSimulationRunning) this.stop()
  }

  /**
   * Registers points whose screen positions should be cheap to read back, for
   * label placement. Pass `undefined` to stop tracking.
   */
  public trackPointsByIndices (indices?: number[]): void {
    this.points?.trackPointsByIndices(indices)
  }

  /** Tracked point positions in simulation space, by point index. */
  public getTrackedPointPositionsMap (): Map<number, [number, number]> {
    return this.points?.getTrackedPositionsMap() ?? new Map()
  }

  private applyTransitionProgress (): void {
    const { points, lines, transition } = this
    const progress = transition.progress
    const animatePositions = transition.isActiveFor(TransitionProperty.Positions)

    points?.setTransitionProgress(
      progress,
      transition.isActiveFor(TransitionProperty.PointColors),
      transition.isActiveFor(TransitionProperty.PointSizes),
      animatePositions
    )
    lines?.setTransitionProgress(
      progress,
      transition.isActiveFor(TransitionProperty.LinkColors),
      transition.isActiveFor(TransitionProperty.LinkWidths),
      animatePositions
    )

    if (animatePositions) {
      points?.swapFbo()
      points?.interpolatePosition(progress)
    } else if (!transition.isActive) {
      points?.destroyTransitionResources()
    }
  }

  private clearBackground (): void {
    const gl = this.device.gl
    const [r, g, b, a] = this.store.backgroundColor
    this.device.bindFramebuffer(null)
    gl.clearColor(r, g, b, a)
    gl.clearDepth(1)
    // Depth writes must be enabled for a depth clear to land. The occlusion
    // pass leaves the mask off, so without re-enabling it here the depth buffer
    // keeps the previous frame's values and culls points that are now in front.
    this.device.setParameters({ depthTest: true, depthWriteEnabled: true, depthCompare: 'always' })
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  }

  private applyConfigToStore (): void {
    const { config, store } = this
    store.backgroundColor = getRgbaColor(config.backgroundColor)
    store.setHoveredPointRingColor(config.hoveredPointRingColor)
    store.setFocusedPointRingColor(config.focusedPointRingColor)
    store.setOutlinedPointRingColor(config.outlinedPointRingColor)
    store.setGreyoutPointColor(config.pointGreyoutColor)
    store.setHoveredLinkColor(config.hoveredLinkColor)
    store.setHighlightedPointSet(config.highlightedPointIndices)
    store.setOutlinedPointSet(config.outlinedPointIndices)
    store.setFocusedPoint(config.focusedPointIndex)
    store.updateLinkHoveringEnabled(config)
    store.adjustSpaceSize(config.spaceSize, this.device.features.maxTextureSize)
    this.isPointStatusUpdateNeeded = true
    this.isDataUpdateNeeded = true
  }

  /**
   * Fits the view once the first data lands.
   *
   * Delayed rather than immediate: with a simulation running, the layout at
   * frame zero is the initial scatter, and fitting to that leaves the settled
   * graph off-screen.
   */
  private scheduleFitViewOnInit (): void {
    if (!this.config.fitViewOnInit || this.hasFitViewOnInitRun) return
    if ((this.data.pointsNumber ?? 0) === 0) return
    this.hasFitViewOnInitRun = true
    this.fitViewTimeout = setTimeout(() => {
      if (this.isDestroyed) return
      const indices = this.config.fitViewByPointIndices
      if (indices) this.fitViewByPointIndices(indices)
      else this.fitView()
    }, this.config.fitViewDelay)
  }

  /** The device's maximum point sprite size, in logical pixels. */
  private readMaxPointSize (): number {
    try {
      const gl = this.device.gl
      const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as ArrayLike<number> | null
      const max = range?.[1]
      return typeof max === 'number' && max > 0 ? max / this.config.pixelRatio : MAX_POINT_SIZE
    } catch {
      return MAX_POINT_SIZE
    }
  }
}

export { PointShape, LinkStyle, ZoomTransform, zoomIdentity, TransitionProperty }
