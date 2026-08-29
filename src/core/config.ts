import type { PointShape, LinkStyle } from './enums'
import type { TransitionEasing } from './transition'
import type { Rgba } from './color'

/** A color as a CSS string or as normalized `[r, g, b, a]` in `0..1`. */
export type ColorValue = string | Rgba

/**
 * A pointer interaction, in the coordinate space of the graph view.
 *
 * Upstream cosmos.gl types its callbacks with `MouseEvent` and d3's zoom/drag
 * events. Neither exists in React Native, and neither carries anything the
 * engine needs beyond a position and the kind of input — so callbacks receive
 * this instead, which is produced identically from a touch, a pen, or a mouse.
 */
export type CosmosPointerEvent = {
  /** Position within the graph view, in logical (CSS-equivalent) pixels. */
  x: number
  y: number
  /** Milliseconds on the same clock as `transition`'s. */
  timestamp: number
  pointerType: 'touch' | 'mouse' | 'pen'
  /** Pointers currently down. `2` during a pinch. */
  pointerCount: number
  /** True for the secondary button (right-click) or a long press. */
  isSecondary: boolean
}

/** The view transform: a uniform scale `k` and a translation. */
export type ZoomTransform = {
  x: number
  y: number
  k: number
}

export type CosmosZoomEvent = {
  transform: ZoomTransform
  /** False when the change came from an API call rather than a gesture. */
  userDriven: boolean
}

export type CosmosDragEvent = {
  /** Point being dragged. */
  pointIndex: number
  /** Pointer position within the graph view. */
  x: number
  y: number
}

export interface GraphConfigInterface {
  /**
   * Whether the graph runs the force simulation. When `false` points stay where
   * they are placed and the engine only renders — the fast path for a
   * precomputed layout or a scatter plot.
   * @default true
   */
  enableSimulation: boolean

  /**
   * Duration in milliseconds of the animation between data updates. `0` snaps.
   * @default 800
   */
  transitionDuration: number

  /**
   * Easing curve for data-update animations.
   * @default TransitionEasing.CubicInOut
   */
  transitionEasing: TransitionEasing | `${TransitionEasing}`

  /** Fires when a transition cycle begins. */
  onTransitionStart?: () => void
  /** Fires each frame of a transition with eased progress in `0..1`. */
  onTransition?: (progress: number) => void
  /** Fires when a transition ends; `interrupted` is true if it was cut short. */
  onTransitionEnd?: (interrupted: boolean) => void

  /**
   * Canvas background color.
   * @default '#222222'
   */
  backgroundColor: ColorValue

  /**
   * Size of the simulation space, in simulation units. Capped by the device's
   * maximum texture size.
   *
   * Defaults to 4096 because larger values crash the graph on iOS
   * (cosmosgl/graph#203) — a constraint that binds harder here than on the web.
   * @default 4096
   */
  spaceSize: number

  /**
   * Color used for points with no per-point color.
   * @default '#b3b3b3'
   */
  pointDefaultColor: ColorValue

  /** Color greyed-out points are drawn in. Unset keeps their own color, dimmed. */
  pointGreyoutColor?: ColorValue

  /** Opacity of greyed-out points. */
  pointGreyoutOpacity?: number

  /**
   * Size used for points with no per-point size.
   * @default 4
   */
  pointDefaultSize: number

  /**
   * Shape used for points with no per-point shape.
   * @default PointShape.Circle
   */
  pointDefaultShape: PointShape | `${PointShape}`

  /**
   * Opacity applied to every point.
   * @default 1
   */
  pointOpacity: number

  /**
   * Multiplier applied to every point size.
   * @default 1
   */
  pointSizeScale: number

  /**
   * Draws opaque point interiors front-to-back with depth testing so hidden
   * fragments are rejected early. A large win on dense graphs; harmless on
   * sparse ones.
   * @default true
   */
  pointOcclusionCulling: boolean

  /**
   * Whether point sizes scale with the zoom level.
   * @default false
   */
  scalePointsOnZoom: boolean

  /** Ring drawn around the point under the pointer. */
  renderHoveredPointRing: boolean
  hoveredPointRingColor: ColorValue
  focusedPointRingColor: ColorValue
  /** Point drawn with a focus ring, or `undefined` for none. */
  focusedPointIndex?: number
  /** Points drawn at full opacity while everything else is greyed out. */
  highlightedPointIndices?: number[]
  /** Points drawn with an outline ring. */
  outlinedPointIndices?: number[]
  outlinedPointRingColor: ColorValue

  /**
   * Whether links are drawn at all.
   * @default true
   */
  renderLinks: boolean

  linkDefaultColor: ColorValue
  linkOpacity: number
  linkGreyoutOpacity: number
  highlightedLinkIndices?: number[]
  focusedLinkIndex?: number
  focusedLinkWidthIncrease: number
  linkDefaultWidth: number
  linkDefaultStyle: LinkStyle | `${LinkStyle}`
  linkDashLength: number
  linkDashGap: number

  /**
   * Interpolates each link's color between its endpoints' colors rather than
   * using a single per-link color.
   * @default false
   */
  linkColorInterpolateFromEndpoints: boolean

  hoveredLinkColor?: ColorValue
  hoveredLinkWidthIncrease: number
  linkWidthScale: number
  scaleLinksOnZoom: boolean

  /**
   * Alpha blending for links. Turning it off is significantly faster on dense
   * graphs, at the cost of correct overlap.
   * @default true
   */
  linkBlending: boolean

  curvedLinks: boolean
  curvedLinkSegments: number
  curvedLinkWeight: number
  curvedLinkControlPointDistance: number
  linkDefaultArrows: boolean
  linkArrowsSizeScale: number

  /**
   * Screen-space link length range, in pixels, over which links fade out. Links
   * shorter than the first value are drawn at `linkVisibilityMinTransparency`.
   * @default [50, 150]
   */
  linkVisibilityDistanceRange: number[]
  linkVisibilityMinTransparency: number

  /**
   * How long the simulation takes to cool. Higher means a longer-running,
   * slower-settling layout.
   * @default 5000
   */
  simulationDecay: number
  /** Pull toward the center of the space. */
  simulationGravity: number
  /** Pull toward the centroid of all points. */
  simulationCenter: number
  /** Strength of point-to-point repulsion. */
  simulationRepulsion: number
  /** Barnes–Hut accuracy: lower is more accurate and slower. */
  simulationRepulsionTheta: number
  /** Strength of the link spring force. */
  simulationLinkSpring: number
  /** Rest length of link springs. */
  simulationLinkDistance: number
  /** Random multiplier range applied to each link's rest length. */
  simulationLinkDistRandomVariationRange: number[]
  /** Repulsion from the pointer position while held. */
  simulationRepulsionFromMouse: number
  enableRightClickRepulsion: boolean
  /** Velocity retained each tick. Lower settles faster. */
  simulationFriction: number
  /** Strength of the pull toward each point's cluster centroid. */
  simulationCluster: number
  /**
   * Strength of the collision force keeping points from overlapping. `0`
   * disables it, skipping the spatial-hash grid entirely.
   * @default 0
   */
  simulationCollision: number
  /** Fixed collision radius. Unset derives it from each point's size. */
  simulationCollisionRadius: number | undefined
  /** Extra gap between points on top of their collision radius. */
  simulationCollisionPadding: number

  onSimulationStart?: () => void
  onSimulationTick?: (alpha: number, hoveredPointIndex?: number, pointPosition?: [number, number]) => void
  onSimulationEnd?: () => void
  onSimulationPause?: () => void
  onSimulationUnpause?: () => void

  onClick?: (index: number | undefined, pointPosition: [number, number] | undefined, event: CosmosPointerEvent) => void
  onPointClick?: (index: number, pointPosition: [number, number], event: CosmosPointerEvent) => void
  onLinkClick?: (linkIndex: number, event: CosmosPointerEvent) => void
  onBackgroundClick?: (event: CosmosPointerEvent) => void
  onContextMenu?: (index: number | undefined, pointPosition: [number, number] | undefined, event: CosmosPointerEvent) => void
  onPointContextMenu?: (index: number, pointPosition: [number, number], event: CosmosPointerEvent) => void
  onLinkContextMenu?: (linkIndex: number, event: CosmosPointerEvent) => void
  onBackgroundContextMenu?: (event: CosmosPointerEvent) => void
  onMouseMove?: (index: number | undefined, pointPosition: [number, number] | undefined, event: CosmosPointerEvent) => void
  onPointMouseOver?: (
    index: number,
    pointPosition: [number, number],
    event: CosmosPointerEvent | undefined,
    isHighlighted?: boolean,
    isOutlined?: boolean
  ) => void
  onPointMouseOut?: (event: CosmosPointerEvent | undefined) => void
  onLinkMouseOver?: (linkIndex: number) => void
  onLinkMouseOut?: (event: CosmosPointerEvent | undefined) => void

  onZoomStart?: (event: CosmosZoomEvent) => void
  onZoom?: (event: CosmosZoomEvent) => void
  onZoomEnd?: (event: CosmosZoomEvent) => void

  onDragStart?: (event: CosmosDragEvent) => void
  onDrag?: (event: CosmosDragEvent) => void
  onDragEnd?: (event: CosmosDragEvent) => void

  /**
   * Device pixel ratio the drawing buffer is sized by. Defaults to the device's
   * own ratio, capped at 2 — a phone at ratio 3 pays 2.25× the fragment cost for
   * a difference that is not visible on a graph of small points.
   */
  pixelRatio: number

  /** Initial zoom level; unset lets `fitViewOnInit` decide. */
  initialZoomLevel?: number

  /**
   * Whether pinch-to-zoom and pan gestures are enabled.
   * @default true
   */
  enableZoom: boolean

  /** Keeps the simulation running during a zoom gesture. */
  enableSimulationDuringZoom: boolean

  /**
   * Whether points can be dragged. Off by default: on touch a drag is
   * indistinguishable from a pan until it is disambiguated, so enabling it
   * changes how the whole surface responds.
   * @default false
   */
  enableDrag: boolean

  fitViewOnInit: boolean
  fitViewDelay: number
  fitViewPadding: number
  fitViewDuration: number
  fitViewByPointsInRect?: [[number, number], [number, number]] | [number, number][]
  fitViewByPointIndices?: number[]

  /** Seed making the layout reproducible across runs. */
  randomSeed?: number | string

  /** Screen-space spacing, in pixels, between sampled points. */
  pointSamplingDistance: number
  /** Screen-space spacing, in pixels, between sampled links. */
  linkSamplingDistance: number

  /**
   * Rescales incoming positions to fit the space. Useful when coordinates come
   * in a range the simulation space does not share (geographic coordinates,
   * embedding outputs).
   */
  rescalePositions?: boolean
}

/**
 * Requires all keys from `T` to be present, while preserving the original value
 * types (including `| undefined` for optional properties).
 */
export type Complete<T> = { [K in keyof Required<T>]: T[K] }

/**
 * Configuration for the graph. All properties are optional; omitted ones use
 * their defaults.
 *
 * Note that `setConfig()` resets to defaults before applying, so properties not
 * included revert rather than persist. `setConfigPartial()` updates in place.
 */
export type GraphConfig = Partial<GraphConfigInterface>
