import type { GraphConfigInterface, GraphConfig, Complete } from './config'
import { PointShape, LinkStyle } from './enums'
import { TransitionEasing } from './transition'

/**
 * Default value for every graph configuration property.
 *
 * `pixelRatio` is the one default the core cannot resolve on its own — it has no
 * access to the display. It sits at 2 here and the React layer overrides it with
 * the device's real ratio, capped, when it mounts.
 */
export const defaultConfigValues = {
  // General
  enableSimulation: true,
  transitionDuration: 800,
  transitionEasing: TransitionEasing.CubicInOut,
  backgroundColor: '#222222',
  /** 4096 because larger values crash the graph on iOS (cosmosgl/graph#203). */
  spaceSize: 4096,

  // Points
  pointDefaultColor: '#b3b3b3',
  pointDefaultSize: 4,
  pointDefaultShape: PointShape.Circle,
  pointOpacity: 1.0,
  pointGreyoutOpacity: undefined,
  pointGreyoutColor: undefined,
  pointSizeScale: 1,
  pointOcclusionCulling: true,
  scalePointsOnZoom: false,

  // Point interaction
  renderHoveredPointRing: false,
  hoveredPointRingColor: 'white',
  focusedPointRingColor: 'white',
  focusedPointIndex: undefined,
  highlightedPointIndices: undefined,
  outlinedPointIndices: undefined,
  outlinedPointRingColor: 'white',

  // Links
  renderLinks: true,
  linkDefaultColor: '#666666',
  linkDefaultWidth: 1,
  linkDefaultStyle: LinkStyle.Solid,
  linkDashLength: 8,
  linkDashGap: 4,
  linkColorInterpolateFromEndpoints: false,
  linkOpacity: 1.0,
  linkGreyoutOpacity: 0.1,
  linkWidthScale: 1,
  scaleLinksOnZoom: false,
  linkBlending: true,
  curvedLinks: false,
  curvedLinkSegments: 19,
  curvedLinkWeight: 0.8,
  curvedLinkControlPointDistance: 0.5,
  linkDefaultArrows: false,
  linkArrowsSizeScale: 1,
  linkVisibilityDistanceRange: [50, 150],
  linkVisibilityMinTransparency: 0.25,

  // Link interaction
  hoveredLinkColor: undefined,
  hoveredLinkWidthIncrease: 5,
  highlightedLinkIndices: undefined,
  focusedLinkIndex: undefined,
  focusedLinkWidthIncrease: 5,

  // Simulation
  simulationDecay: 5000,
  simulationGravity: 0.25,
  simulationCenter: 0,
  simulationRepulsion: 1.0,
  simulationRepulsionTheta: 1.15,
  simulationLinkSpring: 1,
  simulationLinkDistance: 10,
  simulationLinkDistRandomVariationRange: [1, 1.2],
  simulationRepulsionFromMouse: 2,
  simulationFriction: 0.85,
  simulationCluster: 0.1,
  simulationCollision: 0,
  simulationCollisionRadius: undefined,
  simulationCollisionPadding: 0,
  enableRightClickRepulsion: false,

  // Simulation callbacks
  onSimulationStart: undefined,
  onSimulationTick: undefined,
  onSimulationEnd: undefined,
  onSimulationPause: undefined,
  onSimulationUnpause: undefined,

  // Transition callbacks
  onTransitionStart: undefined,
  onTransition: undefined,
  onTransitionEnd: undefined,

  // Interaction callbacks
  onClick: undefined,
  onPointClick: undefined,
  onLinkClick: undefined,
  onBackgroundClick: undefined,
  onContextMenu: undefined,
  onPointContextMenu: undefined,
  onLinkContextMenu: undefined,
  onBackgroundContextMenu: undefined,
  onMouseMove: undefined,
  onPointMouseOver: undefined,
  onPointMouseOut: undefined,
  onLinkMouseOver: undefined,
  onLinkMouseOut: undefined,

  // Zoom and pan callbacks
  onZoomStart: undefined,
  onZoom: undefined,
  onZoomEnd: undefined,

  // Drag callbacks
  onDragStart: undefined,
  onDrag: undefined,
  onDragEnd: undefined,

  // Display
  pixelRatio: 2,

  // Zoom and pan
  enableZoom: true,
  enableSimulationDuringZoom: false,
  initialZoomLevel: undefined,
  scaleExtent: [0.001, Infinity],

  // Drag
  enableDrag: false,

  // Fit view
  fitViewOnInit: true,
  fitViewDelay: 250,
  fitViewPadding: 0.1,
  fitViewDuration: 250,
  fitViewByPointsInRect: undefined,
  fitViewByPointIndices: undefined,

  // Sampling
  pointSamplingDistance: 100,
  linkSamplingDistance: 100,

  // Miscellaneous
  randomSeed: undefined,
  rescalePositions: undefined,
} satisfies Complete<GraphConfigInterface>

export const hoveredPointRingOpacity = 0.7
export const focusedPointRingOpacity = 0.95

/**
 * What a `NaN` size/color channel of an **absent** (removed) point resolves to:
 * fade to nothing. The single source for both resolution sites — the CPU mirrors
 * (`GraphData.getResolvedPoint*`) and the draw shader (injected as `#define`s).
 */
export const EXIT_DEFAULT_SIZE = 0
export const EXIT_DEFAULT_COLOR_CHANNEL = 0

/**
 * Fresh copy of the defaults, with arrays cloned so each graph instance owns
 * its own rather than sharing the module-level object's.
 */
export function createDefaultConfig (): GraphConfigInterface {
  const defaults: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(defaultConfigValues)) {
    defaults[key] = Array.isArray(value) ? [...value] : value
  }
  return defaults as unknown as GraphConfigInterface
}

/**
 * Resets `target` to defaults in place, preserving the object reference so the
 * modules holding it (Store, Zoom, the forces) stay in sync.
 */
export function resetConfigToDefaults (target: GraphConfigInterface): void {
  Object.assign(target, createDefaultConfig())
}

/**
 * Applies `source` onto `target` in place, leaving absent keys unchanged.
 *
 * Mutates rather than returning a new object because every module holds a
 * reference to the same config and must see updates immediately.
 *
 * With `useDefaultsForUndefined`, an explicit `undefined` resets that property
 * to its default instead of being skipped — the difference between "leave this
 * alone" and "clear this".
 */
export function applyConfig (
  target: GraphConfigInterface,
  source: GraphConfig,
  useDefaultsForUndefined = false
): void {
  const overrides: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      overrides[key] = value
    } else if (useDefaultsForUndefined) {
      const fallback = (defaultConfigValues as Record<string, unknown>)[key]
      overrides[key] = Array.isArray(fallback) ? [...fallback] : fallback
    }
  }
  Object.assign(target, overrides)
}
