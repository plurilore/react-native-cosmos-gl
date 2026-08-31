/**
 * react-native-cosmos-gl — a GPU-accelerated force graph for React Native.
 *
 * A port of [cosmos.gl](https://github.com/cosmosgl/graph). The force
 * simulation and the rendering both run in GLSL on the GPU; positions live in
 * float textures and never round-trip through JavaScript.
 *
 * Two ways in:
 *
 * - `<CosmosGraph />` — the view. It owns the drawing surface, the frame clock
 *   and touch input, and takes data as props.
 * - `Graph` — the engine. Hand it a WebGL2 context and call `render()` when you
 *   want a frame. Use this to embed the engine in a surface this package does
 *   not provide.
 */

// --- React layer ---
export {
  CosmosGraph,
  useCosmosGraph,
  type CosmosGraphProps,
  type CosmosGraphRef,
  type CosmosGraphContextValue,
  type CosmosSearchResult,
  type SelectionOptions,
} from './react/CosmosGraph'
export { CosmosLabels, type CosmosLabelsProps } from './react/CosmosLabels'
export {
  LabelManager,
  collectCandidates,
  trackedPointIndices,
  resolveCollisions,
  prioritise,
  clusterPriority,
  normaliseColumnWeight,
  countExtent,
  LABEL_PRIORITY_BAND,
  CLUSTER_PRIORITY_RANGE,
  COLUMN_WEIGHT_SPAN,
  type LabelSource,
  type MeasureLabel,
  type ResolvedLabel,
  type LabelBox,
  type LabelCandidate,
  type LabelClass,
  type LabelPolicy,
  type PrioritisedLabel,
  type MeasuredLabel,
  createLabelLayoutBuffers,
  layoutLabels,
  toLabelPlacement,
  EMPTY_LABEL_PLACEMENT,
  packLabels,
  type LabelLayoutBuffers,
  type LabelPlacement,
  type PackedAtlas,
  type PackedSprite,
  LabelAtlasCache,
  labelAtlasCacheKey,
  type LabelAtlasLookup,
  type LabelAtlasSlot,
  LabelRefreshScheduler,
  type LabelRefreshReason,
} from './labels'
export { projectViewPoint, type ViewProjection } from './core/view-projection'
export type {
  LabelAtlasData,
  LabelAtlasPatch,
  LabelDrawData,
  LabelRendererStats,
} from './core/labels'
export type { FramePerformanceSample } from './core/performance'
export { CosmosClusterLabels, type CosmosClusterLabelsProps } from './react/CosmosClusterLabels'
export { CosmosLegend, type CosmosLegendProps } from './react/CosmosLegend'
export { CosmosSearch, type CosmosSearchProps } from './react/CosmosSearch'
export { CosmosHistogram, type CosmosHistogramProps } from './react/CosmosHistogram'
export { CosmosTimeline, type CosmosTimelineProps } from './react/CosmosTimeline'
export { GestureController } from './react/gestures'
export type { ExpoWebGLRenderingContext } from './react/gl-view'

// --- Data layer ---
// Records in, GPU arrays out. `resolveGraphData` is pure, so it can be used
// without React by anyone driving `Graph` directly.
export {
  resolveGraphData,
  type GraphDataMapping,
  type ResolvedGraphData,
  type GraphDataStats,
} from './data/resolve'
export { DataFrame, type Row, type ColumnType, type Histogram } from './data/data-frame'
export { Selection } from './data/selection'
export { searchPoints, type SearchResult } from './data/search'
export {
  encodeColors,
  encodeSizes,
  encodeLinkWidths,
  type ColorStrategy,
  type SizeStrategy,
  type LinkWidthStrategy,
  type ColorEncoding,
  type SizeEncoding,
  type LinkWidthEncoding,
  type ResolvedColorEncoding,
  type ResolvedSizeEncoding,
} from './data/encode'
export {
  CATEGORICAL_PALETTE_DARK,
  CATEGORICAL_PALETTE_LIGHT,
  CATEGORICAL_ALL_PAIRS_SAFE_LIMIT,
  SEQUENTIAL_PALETTE,
  DIVERGING_PALETTE,
  UNKNOWN_COLOR,
} from './data/palettes'

// --- Engine ---
export { Graph } from './core/graph'
export { GraphData, type PointImageData } from './core/graph-data'
export { PointShape, LinkStyle } from './core/enums'
export { Store, type Hovered } from './core/store'
export { Zoom } from './core/zoom'
export { ZoomTransform, zoomIdentity } from './core/zoom-transform'
export { Transition, TransitionEasing, TransitionProperty } from './core/transition'

// --- Configuration ---
export type {
  GraphConfig,
  GraphConfigInterface,
  ColorValue,
  CosmosPointerEvent,
  CosmosZoomEvent,
  CosmosDragEvent,
  FitViewBounds,
} from './core/config'
export { defaultConfigValues, createDefaultConfig } from './core/variables'

// --- Utilities ---
export { getRgbaColor, rgbToBrightness, type Rgba } from './core/color'
export { SeededRandom, clamp, textureSizeFor } from './core/helper'

// --- GPU layer ---
// Exported for consumers embedding the engine in their own surface, or probing
// device support before mounting a graph.
export {
  Device,
  DeviceError,
  ShaderCompilationError,
  type DeviceFeatures,
  type GL,
} from './gl'
// Run this on a real device before writing anything against the engine: it
// turns "the graph is blank" into a specific, reportable answer.
export { probeDevice, formatDeviceReport, type DeviceReport } from './gl/probe'
