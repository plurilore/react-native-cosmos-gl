import React, {
  createContext,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  View,
  PanResponder,
  PixelRatio,
  StyleSheet,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
  type GestureResponderEvent,
  type PanResponderGestureState,
  type PanResponderInstance,
} from 'react-native'

import { Graph } from '../core/graph'
import type { GraphConfig } from '../core/config'
import type { PointImageData } from '../core/graph-data'
import type { Rgba } from '../core/color'
import type { ColorStrategy, SizeStrategy } from '../data/encode'
import { GestureController } from './gestures'
import { getGLView, type ExpoWebGLRenderingContext } from './gl-view'
import { resolveGraphData, type GraphDataMapping, type ResolvedGraphData } from '../data/resolve'
import { Selection } from '../data/selection'
import type { Row } from '../data/data-frame'
import { searchPoints, type SearchResult } from '../data/search'

/**
 * Cap on the device pixel ratio used for the drawing buffer.
 *
 * Fragment cost scales with its square, so a phone reporting 3 would pay 2.25×
 * what 2 costs. On a graph of small points and thin lines that buys no visible
 * detail, and the frame budget is better spent on the simulation.
 */
const MAX_PIXEL_RATIO = 2

/** Movement, in points, beyond which a touch stops being a tap. */
const TAP_SLOP = 8

/** Hold duration, in ms, that turns a touch into a long press. */
const LONG_PRESS_DURATION = 500

export type CosmosGraphProps = GraphConfig & {
  /** Point positions as `[x0, y0, x1, y1, …]`. Sets the index space for everything else. */
  pointPositions?: Float32Array
  /** Link endpoints as `[source0, target0, …]` of point indices. */
  links?: Float32Array
  /** Per-point RGBA in `0..1`, four values per point. */
  pointColors?: Float32Array
  /** Per-point size. */
  pointSizes?: Float32Array
  /** Per-point shape, as `PointShape` values. */
  pointShapes?: Float32Array
  pointImages?: { images: PointImageData[]; indices: Float32Array; sizes?: Float32Array }
  linkColors?: Float32Array
  linkWidths?: Float32Array
  linkStyles?: Float32Array
  linkArrows?: boolean[]
  linkStrength?: Float32Array
  /** Point indices the simulation holds in place. */
  pinnedPoints?: number[]
  /** Cluster index per point; `undefined` leaves a point unclustered. */
  pointClusters?: (number | undefined)[]
  /** Explicit cluster positions as `[x0, y0, …]`, indexed by cluster. */
  clusterPositions?: (number | undefined)[]
  /** Per-point multiplier on the cluster force. */
  pointClusterStrength?: Float32Array

  /**
   * Point records, as an alternative to the typed arrays above.
   *
   * Supply these together with the `*By` column mappings and the component
   * derives every array the engine needs. The typed-array props remain the
   * fast path and take precedence: pass both and the explicit array wins, so
   * you can let the mapping handle most channels and override one by hand.
   */
  pointData?: Row[]
  /** Link records, referencing points by the values in `pointIdBy`. */
  linkData?: Row[]

  /**
   * Column holding each point's unique id.
   *
   * Required whenever `linkData` is supplied, since links name their endpoints
   * by id. Without links, point order alone is enough and this is optional.
   */
  pointIdBy?: string
  /** Column naming each link's source point, matched against `pointIdBy`. */
  linkSourceBy?: string
  /** Column naming each link's target point. */
  linkTargetBy?: string

  /** Columns holding precomputed coordinates. Both must be present to be used. */
  pointXBy?: string
  pointYBy?: string

  /** Column driving point color. */
  pointColorBy?: string
  /** How to turn that column into color. Inferred from the column's type when omitted. */
  pointColorStrategy?: ColorStrategy
  pointColorPalette?: string[]
  /** Explicit value → color lookup, for `pointColorStrategy: 'map'`. */
  pointColorMap?: Record<string, string | Rgba>
  /** Derives a color from the raw value, bypassing the strategy. */
  pointColorByFn?: (value: unknown, index: number) => string | Rgba
  /** Midpoint for `pointColorStrategy: 'diverging'`. */
  pointColorMidpoint?: number

  /** Column driving point size. */
  pointSizeBy?: string
  pointSizeStrategy?: SizeStrategy
  /** `[min, max]` in pixels. Defaults to `[2, 9]`. */
  pointSizeRange?: [number, number]
  pointSizeByFn?: (value: unknown, index: number) => number

  /** Column holding each point's label. */
  pointLabelBy?: string
  /**
   * Column deciding which labels win when there is not room for all of them.
   * Defaults to degree, so the best-connected points get named.
   */
  pointLabelWeightBy?: string

  /**
   * Column driving point shape.
   *
   * Worth pairing with `pointColorBy` on the same column once a categorical
   * encoding has more than three categories: past that, color alone stops being
   * reliably distinguishable, and shape carries the identity color cannot.
   */
  pointShapeBy?: string

  /** Column assigning points to clusters. */
  pointClusterBy?: string
  /** Column giving each point's pull toward its cluster. */
  pointClusterStrengthBy?: string
  /** Fixed positions for named clusters, as `{ clusterValue: [x, y] }`. */
  clusterPositionsMap?: Record<string, [number, number]>

  /** Column driving link color. */
  linkColorBy?: string
  linkColorStrategy?: ColorStrategy
  linkColorPalette?: string[]
  linkColorByFn?: (value: unknown, index: number) => string | Rgba

  /** Column driving link width. */
  linkWidthBy?: string
  /** `[min, max]` in pixels. Defaults to `[1, 9]`. */
  linkWidthRange?: [number, number]
  linkWidthByFn?: (value: unknown, index: number) => number

  /** Column driving each link's spring strength. */
  linkStrengthBy?: string
  /** `[min, max]` the strength column maps into. Defaults to `[0.2, 1]`. */
  linkStrengthRange?: [number, number]

  /** Tapping a point selects it, greying out everything else. */
  selectPointOnClick?: boolean
  /** A point selection also takes in that point's neighbours. */
  selectNeighborsOnClick?: boolean
  /** Tapping the background clears the selection. */
  resetSelectionOnBackgroundClick?: boolean
  /** Fires whenever the selection changes, including when it is cleared. */
  onSelectionChange?: (pointIndices: number[] | undefined, linkIndices: number[] | undefined) => void
  /** Fires once records have been resolved into GPU arrays. */
  onDataResolved?: (data: ResolvedGraphData) => void

  style?: StyleProp<ViewStyle>
  /** Multisample count for the surface. `0` disables MSAA, which is faster. */
  msaaSamples?: number
  /** Fires once the GL context exists and the engine is live. */
  onReady?: (graph: Graph) => void
  /** Fires if the surface or the engine could not be created. */
  onError?: (error: Error) => void

  /**
   * Overlays rendered above the graph surface.
   *
   * Children receive the live graph through context, so `<CosmosLabels />`,
   * `<CosmosLegend />` and the rest need no wiring — being inside the graph is
   * what connects them to it.
   */
  children?: React.ReactNode
}

/** How a selection expands from the points it was given. */
export type SelectionOptions = {
  /** Add to the current selection rather than replacing it. */
  additive?: boolean
  /** Also select each point's neighbours. */
  includeNeighbors?: boolean
  /** Also highlight links with both ends selected. Defaults to true. */
  includeLinks?: boolean
}

/** What overlay children read to reach the graph they sit on. */
export type CosmosGraphContextValue = {
  /** The engine, once the GL context exists. */
  graph: Graph | undefined
  /** Records resolved into GPU arrays, when `pointData` was supplied. */
  resolved: ResolvedGraphData | undefined
  /** True once the surface and engine are live. */
  isReady: boolean
  /** Currently selected point indices, or `undefined` when nothing is selected. */
  selectedPointIndices: number[] | undefined
  /** Selects points, greying out everything else. */
  selectPoints: (indices: number[], options?: SelectionOptions) => void
  clearSelection: () => void
  /** Substring search over the label column, ranked by label weight. */
  searchPoints: (query: string, limit?: number) => CosmosSearchResult[]
}

const CosmosGraphContext = createContext<CosmosGraphContextValue | undefined>(undefined)

/**
 * Reaches the graph an overlay is rendered inside.
 *
 * Throws rather than returning `undefined` when used outside one: an overlay
 * with no graph has nothing to draw, and a silent no-op would look like a
 * rendering bug rather than a misplaced component.
 */
export function useCosmosGraph (): CosmosGraphContextValue {
  const value = React.useContext(CosmosGraphContext)
  if (!value) {
    throw new Error(
      'useCosmosGraph must be called inside <CosmosGraph>. Overlays such as <CosmosLabels /> ' +
      'read the graph through context, so they have to be rendered as its children.'
    )
  }
  return value
}

/** Imperative handle for controlling the graph from a parent. */
export type CosmosGraphRef = {
  /** The underlying engine, or `undefined` before the context exists. */
  getGraph: () => Graph | undefined
  start: (alpha?: number) => void
  stop: () => void
  pause: () => void
  unpause: () => void
  step: () => void
  fitView: (duration?: number, padding?: number) => void
  fitViewByPointIndices: (indices: number[], duration?: number, padding?: number) => void
  setZoomLevel: (level: number, duration?: number) => void
  getZoomLevel: () => number
  getPointPositions: () => Float32Array
  findPointOnScreen: (x: number, y: number) => { index: number; position: [number, number] } | undefined
  /** Point indices inside a screen-space rectangle, given as opposite corners. */
  findPointsInRect: (rect: [[number, number], [number, number]]) => number[]
  /** Point indices inside a screen-space polygon — the lasso query. */
  findPointsInPolygon: (path: [number, number][]) => number[]
  /** Current cluster centroids as `[x0, y0, …]`. */
  getClusterPositions: () => readonly number[]

  /** The records resolved into GPU arrays, when `pointData` was supplied. */
  getResolvedData: () => ResolvedGraphData | undefined
  /** Point indices for the given ids, skipping ids that match no point. */
  getPointIndicesByIds: (ids: string[]) => number[]
  /** Point ids for the given indices. */
  getPointIdsByIndices: (indices: number[]) => (string | undefined)[]
  /** Selects points, greying out everything else. */
  selectPoints: (indices: number[], options?: SelectionOptions) => void
  /** Selects points by id. */
  selectPointsByIds: (ids: string[], options?: SelectionOptions) => void
  /** Clears the selection, returning the graph to full strength. */
  clearSelection: () => void
  /** The current selection, or `undefined` when nothing is selected. */
  getSelectedPointIndices: () => number[] | undefined
  /** Substring search over the label column, ranked by label weight. */
  searchPoints: (query: string, limit?: number) => CosmosSearchResult[]
}

/** A search hit. */
export type CosmosSearchResult = SearchResult

/**
 * A GPU force graph as a React Native view.
 *
 * Owns the three things the engine deliberately does not: the drawing surface,
 * the frame clock, and touch input. Data arrives as props and is pushed into
 * the engine on change; the engine renders continuously while there is
 * something to animate.
 */
export const CosmosGraph = forwardRef<CosmosGraphRef, CosmosGraphProps>(function CosmosGraph (props, ref) {
  const {
    pointPositions, links, pointColors, pointSizes, pointShapes, pointImages,
    linkColors, linkWidths, linkStyles, linkArrows, linkStrength, pinnedPoints,
    pointClusters, clusterPositions, pointClusterStrength,
    pointData, linkData, pointIdBy, linkSourceBy, linkTargetBy, pointXBy, pointYBy,
    pointColorBy, pointColorStrategy, pointColorPalette, pointColorMap, pointColorByFn,
    pointColorMidpoint, pointSizeBy, pointSizeStrategy, pointSizeRange, pointSizeByFn,
    pointLabelBy, pointLabelWeightBy, pointShapeBy,
    pointClusterBy, pointClusterStrengthBy, clusterPositionsMap,
    linkColorBy, linkColorStrategy, linkColorPalette, linkColorByFn,
    linkWidthBy, linkWidthRange, linkWidthByFn, linkStrengthBy, linkStrengthRange,
    selectPointOnClick, selectNeighborsOnClick, resetSelectionOnBackgroundClick,
    onSelectionChange, onDataResolved,
    style, msaaSamples = 0, onReady, onError, children,
    ...config
  } = props

  const graphRef = useRef<Graph | undefined>(undefined)
  const glRef = useRef<ExpoWebGLRenderingContext | undefined>(undefined)
  const gesturesRef = useRef<GestureController | undefined>(undefined)
  const frameRef = useRef<number | undefined>(undefined)
  const sizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 })
  const [isReady, setIsReady] = useState(false)

  // Config is read fresh every frame, so a prop change must not need a
  // re-render to take effect — the ref is what the frame loop sees.
  const configRef = useRef(config as GraphConfig)

  const pixelRatio = useMemo(() => Math.min(PixelRatio.get(), MAX_PIXEL_RATIO), [])

  /**
   * Records resolved into GPU arrays.
   *
   * Memoized on the record arrays and the mapping, because resolving walks
   * every row of every mapped column — cheap once, wasteful per render. Pass
   * stable references for the `*Fn` callbacks (a `useCallback`, or a module
   * constant); an inline arrow is a new value each render and defeats this.
   */
  const resolved = useMemo(() => {
    if (!pointData) return undefined
    return resolveGraphData({
      pointData, linkData, pointIdBy, linkSourceBy, linkTargetBy, pointXBy, pointYBy,
      pointColorBy, pointColorStrategy, pointColorPalette, pointColorMap, pointColorByFn,
      pointColorMidpoint, pointSizeBy, pointSizeStrategy, pointSizeRange, pointSizeByFn,
      pointLabelBy, pointLabelWeightBy, pointShapeBy,
      pointClusterBy, pointClusterStrengthBy, clusterPositionsMap,
      linkColorBy, linkColorStrategy, linkColorPalette, linkColorByFn,
      linkWidthBy, linkWidthRange, linkWidthByFn, linkStrengthBy, linkStrengthRange,
      spaceSize: config.spaceSize,
      randomSeed: config.randomSeed,
      pointDefaultSize: config.pointDefaultSize,
    } satisfies GraphDataMapping)
  }, [
    pointData, linkData, pointIdBy, linkSourceBy, linkTargetBy, pointXBy, pointYBy,
    pointColorBy, pointColorStrategy, pointColorPalette, pointColorMap, pointColorByFn,
    pointColorMidpoint, pointSizeBy, pointSizeStrategy, pointSizeRange, pointSizeByFn,
    pointLabelBy, pointLabelWeightBy, pointShapeBy,
    pointClusterBy, pointClusterStrengthBy, clusterPositionsMap,
    linkColorBy, linkColorStrategy, linkColorPalette, linkColorByFn,
    linkWidthBy, linkWidthRange, linkWidthByFn, linkStrengthBy, linkStrengthRange,
    config.spaceSize, config.randomSeed, config.pointDefaultSize,
  ])

  // An explicit typed array always wins over the resolved one, so a caller can
  // let the mapping handle most channels and still hand-supply a single
  // channel it does not cover.
  const effectivePointPositions = pointPositions ?? resolved?.pointPositions
  const effectiveLinks = links ?? resolved?.links
  const effectivePointColors = pointColors ?? resolved?.pointColors
  const effectivePointSizes = pointSizes ?? resolved?.pointSizes
  const effectivePointShapes = pointShapes ?? resolved?.pointShapes
  const effectiveLinkColors = linkColors ?? resolved?.linkColors
  const effectiveLinkWidths = linkWidths ?? resolved?.linkWidths
  const effectiveLinkStrength = linkStrength ?? resolved?.linkStrength
  const effectivePointClusters = pointClusters ?? resolved?.pointClusters
  const effectiveClusterPositions = clusterPositions ?? resolved?.clusterPositions
  const effectivePointClusterStrength = pointClusterStrength ?? resolved?.pointClusterStrength

  const selectionRef = useRef(new Selection())
  // The imperative handle is built once, so anything it reads must come
  // through a ref rather than a closed-over prop.
  const resolvedRef = useRef<ResolvedGraphData | undefined>(undefined)
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  resolvedRef.current = resolved
  // Selection lives in state rather than a ref because it feeds the highlight
  // config, which has to reach the engine through the render path.
  const [selectionConfig, setSelectionConfig] = useState<{
    highlightedPointIndices?: number[]
    highlightedLinkIndices?: number[]
  }>({})

  /**
   * Applies a point selection and pushes the highlighting it implies.
   *
   * `undefined` clears rather than selects nothing: with no selection the graph
   * shows everything at full strength, whereas an empty selection greys the
   * whole graph out. Those are different states and a tap on the background
   * means the first one.
   */
  const applySelection = useCallback((indices: number[] | undefined) => {
    const graph = graphRef.current
    if (!graph) return
    const selection = selectionRef.current
    if (!indices || indices.length === 0) selection.clear()
    else selection.selectPoints(graph, indices, { includeNeighbors: selectNeighborsOnClick })

    const next = selection.toConfig()
    setSelectionConfig(next)
    onSelectionChange?.(next.highlightedPointIndices, next.highlightedLinkIndices)
  }, [selectNeighborsOnClick, onSelectionChange])

  // Tap handling wraps the caller's callbacks rather than replacing them, so
  // selection is applied first and the caller still hears about every tap.
  configRef.current = useMemo((): GraphConfig => ({
    ...config,
    onPointClick: (index, position, event) => {
      if (selectPointOnClick) applySelection([index])
      config.onPointClick?.(index, position, event)
    },
    onBackgroundClick: (event) => {
      if (selectPointOnClick && resetSelectionOnBackgroundClick !== false) applySelection(undefined)
      config.onBackgroundClick?.(event)
    },
  }), [config, selectPointOnClick, resetSelectionOnBackgroundClick, applySelection])

  const renderFrame = useCallback(() => {
    const graph = graphRef.current
    const gl = glRef.current
    if (!graph || !gl) return

    graph.render([0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight])
    // expo-gl batches commands and only presents on this call; without it the
    // frame is computed and never shown.
    gl.endFrameEXP()
    frameRef.current = requestAnimationFrame(renderFrame)
  }, [])

  const onContextCreate = useCallback((gl: ExpoWebGLRenderingContext) => {
    try {
      const graph = new Graph(gl, { ...configRef.current, pixelRatio })
      graphRef.current = graph
      glRef.current = gl
      gesturesRef.current = new GestureController(graph)

      const { width, height } = sizeRef.current
      if (width && height) graph.setSize(width, height)

      setIsReady(true)
      onReady?.(graph)
      frameRef.current = requestAnimationFrame(renderFrame)
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)))
    }
    // `onReady` and `onError` are deliberately not dependencies: they are read
    // at call time, and re-creating the GL context because a parent passed a
    // new closure would destroy and rebuild the whole graph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pixelRatio, renderFrame])

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout
    sizeRef.current = { width, height }
    graphRef.current?.setSize(width, height)
  }, [])

  // --- data props -> engine -------------------------------------------------
  // Each effect is keyed on the array identity, so passing the same
  // `Float32Array` twice does no GPU work. Callers who mutate an array in place
  // should pass a new view (`array.subarray()`) to signal the change.

  useEffect(() => {
    if (!isReady || !effectivePointPositions) return
    graphRef.current?.setPointPositions(effectivePointPositions)
    graphRef.current?.start()
  }, [isReady, effectivePointPositions])

  useEffect(() => {
    if (!isReady || !effectiveLinks) return
    graphRef.current?.setLinks(effectiveLinks)
  }, [isReady, effectiveLinks])

  useEffect(() => {
    if (!isReady || !effectivePointColors) return
    graphRef.current?.setPointColors(effectivePointColors)
  }, [isReady, effectivePointColors])

  useEffect(() => {
    if (!isReady || !effectivePointSizes) return
    graphRef.current?.setPointSizes(effectivePointSizes)
  }, [isReady, effectivePointSizes])

  useEffect(() => {
    if (!isReady || !effectivePointShapes) return
    graphRef.current?.setPointShapes(effectivePointShapes)
  }, [isReady, effectivePointShapes])

  useEffect(() => {
    if (!isReady || !pointImages) return
    graphRef.current?.setPointImages(pointImages.images, pointImages.indices, pointImages.sizes)
  }, [isReady, pointImages])

  useEffect(() => {
    if (!isReady || !effectiveLinkColors) return
    graphRef.current?.setLinkColors(effectiveLinkColors)
  }, [isReady, effectiveLinkColors])

  useEffect(() => {
    if (!isReady || !effectiveLinkWidths) return
    graphRef.current?.setLinkWidths(effectiveLinkWidths)
  }, [isReady, effectiveLinkWidths])

  useEffect(() => {
    if (!isReady || !linkStyles) return
    graphRef.current?.setLinkStyles(linkStyles)
  }, [isReady, linkStyles])

  useEffect(() => {
    if (!isReady || !linkArrows) return
    graphRef.current?.setLinkArrows(linkArrows)
  }, [isReady, linkArrows])

  useEffect(() => {
    if (!isReady || !effectiveLinkStrength) return
    graphRef.current?.setLinkStrength(effectiveLinkStrength)
  }, [isReady, effectiveLinkStrength])

  useEffect(() => {
    if (!isReady || !pinnedPoints) return
    graphRef.current?.setPinnedPoints(pinnedPoints)
  }, [isReady, pinnedPoints])

  useEffect(() => {
    if (!isReady || !effectivePointClusters) return
    graphRef.current?.setPointClusters(effectivePointClusters)
  }, [isReady, effectivePointClusters])

  useEffect(() => {
    if (!isReady || !effectiveClusterPositions) return
    graphRef.current?.setClusterPositions(effectiveClusterPositions)
  }, [isReady, effectiveClusterPositions])

  useEffect(() => {
    if (!isReady || !effectivePointClusterStrength) return
    graphRef.current?.setPointClusterStrength(effectivePointClusterStrength)
  }, [isReady, effectivePointClusterStrength])

  // Config changes go through the partial setter, so properties this component
  // does not own — anything set imperatively through the ref — survive.
  useEffect(() => {
    if (!isReady) return
    // Selection is merged last so it wins over a `highlightedPointIndices`
    // passed as a prop — a tap must visibly do something even when the caller
    // also drives highlighting.
    graphRef.current?.setConfigPartial({ ...configRef.current, pixelRatio, ...selectionConfig })
  })

  useEffect(() => {
    if (!isReady || !resolved) return
    onDataResolved?.(resolved)
    // `onDataResolved` is read at call time; a parent passing a new closure
    // must not re-announce data that has not changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, resolved])

  useEffect(() => () => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    graphRef.current?.destroy()
    graphRef.current = undefined
    glRef.current = undefined
  }, [])

  useImperativeHandle(ref, (): CosmosGraphRef => ({
    getGraph: () => graphRef.current,
    start: (alpha) => graphRef.current?.start(alpha),
    stop: () => graphRef.current?.stop(),
    pause: () => graphRef.current?.pause(),
    unpause: () => graphRef.current?.unpause(),
    step: () => graphRef.current?.step(),
    fitView: (duration, padding) => graphRef.current?.fitView(duration, padding),
    fitViewByPointIndices: (indices, duration, padding) =>
      graphRef.current?.fitViewByPointIndices(indices, duration, padding),
    setZoomLevel: (level, duration) => graphRef.current?.setZoomLevel(level, duration),
    getZoomLevel: () => graphRef.current?.getZoomLevel() ?? 1,
    getPointPositions: () => graphRef.current?.getPointPositions() ?? new Float32Array(),
    findPointOnScreen: (x, y) => graphRef.current?.findPointOnScreen(x, y),
    findPointsInRect: (rect) => graphRef.current?.findPointsInRect(rect) ?? [],
    findPointsInPolygon: (path) => graphRef.current?.findPointsInPolygon(path) ?? [],
    getClusterPositions: () => graphRef.current?.getClusterPositions() ?? [],

    getResolvedData: () => resolvedRef.current,
    getPointIndicesByIds: (ids) => {
      const lookup = resolvedRef.current?.idToIndex
      if (!lookup) return []
      const result: number[] = []
      for (const id of ids) {
        const index = lookup.get(id)
        if (index !== undefined) result.push(index)
      }
      return result
    },
    getPointIdsByIndices: (indices) => {
      const ids = resolvedRef.current?.pointIds
      return indices.map((index) => ids?.[index])
    },
    selectPoints: (indices, options) => {
      const graph = graphRef.current
      if (!graph) return
      selectionRef.current.selectPoints(graph, indices, options)
      const next = selectionRef.current.toConfig()
      setSelectionConfig(next)
      onSelectionChangeRef.current?.(next.highlightedPointIndices, next.highlightedLinkIndices)
    },
    selectPointsByIds: (ids, options) => {
      const graph = graphRef.current
      const lookup = resolvedRef.current?.idToIndex
      if (!graph || !lookup) return
      const indices: number[] = []
      for (const id of ids) {
        const index = lookup.get(id)
        if (index !== undefined) indices.push(index)
      }
      selectionRef.current.selectPoints(graph, indices, options)
      const next = selectionRef.current.toConfig()
      setSelectionConfig(next)
      onSelectionChangeRef.current?.(next.highlightedPointIndices, next.highlightedLinkIndices)
    },
    clearSelection: () => {
      selectionRef.current.clear()
      setSelectionConfig({})
      onSelectionChangeRef.current?.(undefined, undefined)
    },
    getSelectedPointIndices: () => selectionRef.current.pointIndices,
    searchPoints: (query, limit = 20) => searchPoints(resolvedRef.current, query, limit),
  }), [])

  const panResponder = useTouchHandling(gesturesRef)
  const GLView = useMemo(() => getGLView(), [])

  const contextValue = useMemo((): CosmosGraphContextValue => ({
    graph: graphRef.current,
    resolved,
    isReady,
    selectedPointIndices: selectionConfig.highlightedPointIndices,
    selectPoints: (indices, options) => {
      const graph = graphRef.current
      if (!graph) return
      selectionRef.current.selectPoints(graph, indices, options)
      const next = selectionRef.current.toConfig()
      setSelectionConfig(next)
      onSelectionChangeRef.current?.(next.highlightedPointIndices, next.highlightedLinkIndices)
    },
    clearSelection: () => {
      selectionRef.current.clear()
      setSelectionConfig({})
      onSelectionChangeRef.current?.(undefined, undefined)
    },
    searchPoints: (query, limit = 20) => searchPoints(resolvedRef.current, query, limit),
  }), [resolved, isReady, selectionConfig.highlightedPointIndices])

  return (
    <View style={[styles.container, style]} onLayout={onLayout}>
      {/* Touch handlers live on the surface, not the container, so overlay
          children stay independently interactive — a tappable search result
          must not also pan the graph underneath it. */}
      <View style={StyleSheet.absoluteFill} {...panResponder.panHandlers}>
        <GLView style={StyleSheet.absoluteFill} msaaSamples={msaaSamples} onContextCreate={onContextCreate} />
      </View>
      {children ? (
        <CosmosGraphContext.Provider value={contextValue}>
          {children}
        </CosmosGraphContext.Provider>
      ) : null}
    </View>
  )
})

/**
 * Touch handling on `PanResponder`.
 *
 * Chosen over `react-native-gesture-handler` so the library has no gesture
 * dependency at all: the engine is JS-driven anyway — the render loop, the
 * transform, and picking all live on the JS thread — so a gesture library that
 * runs on the UI thread would have to hop back for every update and buys
 * nothing here. Consumers who want RNGH or Reanimated can drive the exported
 * `GestureController` themselves.
 */
function useTouchHandling (
  gesturesRef: React.MutableRefObject<GestureController | undefined>
): PanResponderInstance {
  const stateRef = useRef({
    isPinching: false,
    initialDistance: 0,
    startX: 0,
    startY: 0,
    longPressTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    didLongPress: false,
    didMove: false,
  })

  const clearLongPress = useCallback(() => {
    const timer = stateRef.current.longPressTimer
    if (timer !== undefined) clearTimeout(timer)
    stateRef.current.longPressTimer = undefined
  }, [])

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    // Claim the gesture even if a parent scroll view wants it: a graph fills
    // its area and pans in both axes, so handing off on a vertical drag would
    // make the view unusable inside a scroll container.
    onMoveShouldSetPanResponderCapture: () => true,

    onPanResponderGrant: (event: GestureResponderEvent) => {
      const gestures = gesturesRef.current
      if (!gestures) return
      const touches = event.nativeEvent.touches
      const state = stateRef.current
      state.didMove = false
      state.didLongPress = false

      if (touches.length >= 2) {
        state.isPinching = true
        state.initialDistance = touchDistance(touches)
        gestures.onPinchStart()
        return
      }

      const { locationX, locationY } = event.nativeEvent
      state.startX = locationX
      state.startY = locationY
      state.isPinching = false
      gestures.onPanStart(locationX, locationY)

      state.longPressTimer = setTimeout(() => {
        if (stateRef.current.didMove) return
        stateRef.current.didLongPress = true
        gestures.onLongPress(locationX, locationY)
      }, LONG_PRESS_DURATION)
    },

    onPanResponderMove: (event: GestureResponderEvent, gestureState: PanResponderGestureState) => {
      const gestures = gesturesRef.current
      if (!gestures) return
      const touches = event.nativeEvent.touches
      const state = stateRef.current

      if (Math.abs(gestureState.dx) > TAP_SLOP || Math.abs(gestureState.dy) > TAP_SLOP) {
        state.didMove = true
        clearLongPress()
      }

      // A second finger can arrive mid-pan; switch modes rather than ignoring it.
      if (touches.length >= 2) {
        if (!state.isPinching) {
          state.isPinching = true
          state.initialDistance = touchDistance(touches)
          gestures.onPanEnd(state.startX, state.startY)
          gestures.onPinchStart()
        }
        const distance = touchDistance(touches)
        if (state.initialDistance > 0) {
          const [focalX, focalY] = touchMidpoint(touches)
          gestures.onPinchUpdate(distance / state.initialDistance, focalX, focalY)
        }
        return
      }

      // Dropping to one finger ends the pinch and starts a fresh pan from
      // wherever that finger now is, so the view does not jump.
      if (state.isPinching) {
        state.isPinching = false
        gestures.onPinchEnd()
        gestures.onPanStart(event.nativeEvent.locationX, event.nativeEvent.locationY)
        state.startX = event.nativeEvent.locationX
        state.startY = event.nativeEvent.locationY
        return
      }

      gestures.onPanUpdate(
        event.nativeEvent.locationX,
        event.nativeEvent.locationY,
        gestureState.dx,
        gestureState.dy
      )
    },

    onPanResponderRelease: (event: GestureResponderEvent, gestureState: PanResponderGestureState) => {
      const gestures = gesturesRef.current
      const state = stateRef.current
      clearLongPress()
      if (!gestures) return

      if (state.isPinching) {
        state.isPinching = false
        gestures.onPinchEnd()
        return
      }

      gestures.onPanEnd(state.startX, state.startY)

      const isTap = !state.didLongPress &&
        Math.abs(gestureState.dx) <= TAP_SLOP &&
        Math.abs(gestureState.dy) <= TAP_SLOP
      if (isTap) gestures.onTap(state.startX, state.startY)
      void event
    },

    onPanResponderTerminate: () => {
      const gestures = gesturesRef.current
      const state = stateRef.current
      clearLongPress()
      if (!gestures) return
      if (state.isPinching) {
        state.isPinching = false
        gestures.onPinchEnd()
      } else {
        gestures.onPanEnd(state.startX, state.startY)
      }
    },
  }), [clearLongPress, gesturesRef])

  useEffect(() => clearLongPress, [clearLongPress])

  return responder
}

type Touch = { locationX: number; locationY: number }

function touchDistance (touches: readonly Touch[]): number {
  const a = touches[0]
  const b = touches[1]
  if (!a || !b) return 0
  const dx = a.locationX - b.locationX
  const dy = a.locationY - b.locationY
  return Math.sqrt(dx * dx + dy * dy)
}

function touchMidpoint (touches: readonly Touch[]): [number, number] {
  const a = touches[0]
  const b = touches[1]
  if (!a || !b) return [0, 0]
  return [(a.locationX + b.locationX) / 2, (a.locationY + b.locationY) / 2]
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
})

