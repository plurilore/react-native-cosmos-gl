import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PixelRatio, StyleSheet } from 'react-native'
import {
  Atlas,
  Canvas,
  useFont,
  usePictureAsTexture,
  useRSXformBuffer,
  type SkFont,
} from '@shopify/react-native-skia'
import { useSharedValue } from 'react-native-reanimated'
import { useCosmosGraph } from '../react/CosmosGraph'
import {
  LabelManager,
  LabelRefreshScheduler,
  createLabelLayoutBuffers,
  fillBuffers,
  layoutLabels,
  labelAtlasMetrics,
  labelSpriteTransform,
  toLabelPlacement,
  EMPTY_LABEL_PLACEMENT,
  type LabelPlacement,
  type LabelPolicy,
} from '../labels'
import { MAX_LABELS, bakeAtlas, configureFont, type BakedAtlas } from './bake'
import { projectViewPoint, type ViewProjection } from '../core/view-projection'
import {
  CosmosInlineSkiaLabels,
  type LabelPerformanceSample,
} from './CosmosInlineSkiaLabels'

export type { LabelPerformanceSample } from './CosmosInlineSkiaLabels'

export type CosmosSkiaLabelsProps = LabelPolicy & {
  /** A font file, as `require('./Inter.ttf')`, or a loaded `SkFont`. */
  font: Parameters<typeof useFont>[0] | SkFont
  fontSize?: number
  color?: string
  /** Chip drawn behind the text. Omit for none. */
  chipColor?: string
  /** Gap between a label and the point it names, in pixels. */
  margin?: number
  /** `[left, top, right, bottom]` inside the chip. */
  padding?: readonly [number, number, number, number]
  /**
   * How often to refresh anchor positions from the GPU, in milliseconds.
   *
   * The *simulation* clock, not the camera clock. It only matters while points
   * are still moving; panning and zooming are handled without it.
   */
  updateIntervalMs?: number
  /** Cluster centroids to label, in simulation space. */
  clusters?: readonly { index: number; name: string; count: number; position: [number, number] }[]
  /** Reports how long a selection pass took, and how many labels it produced. */
  onMeasure?: (durationMs: number, count: number) => void
  /** Inline draws in the graph framebuffer; overlay retains the legacy Skia Canvas for A/B checks. */
  renderMode?: 'inline' | 'overlay'
  /** Detailed timing and cache counters for profiler HUDs. */
  onPerformanceSample?: (sample: LabelPerformanceSample) => void
}

/** Where a legacy overlay's parked slot goes. */
const PARKED = -100_000

const DEFAULT_FONT_SIZE = 12
const DEFAULT_MARGIN = 7
const DEFAULT_PADDING = [5, 3, 5, 3] as const
const DEFAULT_INTERVAL = 90

/**
 * Graph labels backed by persistent text assets.
 *
 * Inline mode is the production path: Skia rasterizes cache misses offscreen,
 * then one instanced GL draw projects live point anchors from the position
 * texture. The legacy transparent Canvas remains selectable for compatibility
 * and A/B traces. Both policy clocks are event-driven and park at idle.
 */
export function CosmosSkiaLabels (props: CosmosSkiaLabelsProps): React.ReactElement | null {
  const { renderMode = 'inline', ...labels } = props
  if (renderMode === 'inline') return <CosmosInlineSkiaLabels {...labels} />
  return <LegacyCosmosSkiaLabels {...labels} />
}

type LegacyCosmosSkiaLabelsProps = Omit<CosmosSkiaLabelsProps, 'renderMode'>

function LegacyCosmosSkiaLabels ({
  font: fontSource,
  fontSize = DEFAULT_FONT_SIZE,
  color = '#f8fafc',
  chipColor,
  margin = DEFAULT_MARGIN,
  padding = DEFAULT_PADDING,
  updateIntervalMs = DEFAULT_INTERVAL,
  clusters,
  onMeasure,
  onPerformanceSample: _onPerformanceSample,
  ...policy
}: LegacyCosmosSkiaLabelsProps): React.ReactElement | null {
  const { graph, resolved, isReady, selectedPointIndices } = useCosmosGraph()

  /**
   * Everything inside the atlas is in physical pixels.
   *
   * An offscreen Skia surface draws under an identity transform, while a
   * `<Canvas>` scales by the device ratio first — so a font baked at a logical
   * size is rasterized at a fraction of the resolution it is displayed at, and
   * the atlas can only upscale it. Baking at `fontSize × ratio` and drawing the
   * sprite back down at `1 / ratio` puts a texel on a device pixel.
   */
  const pixelRatio = PixelRatio.get()
  const metrics = useMemo(
    () => labelAtlasMetrics({ fontSize, padding, margin, pixelRatio }),
    [fontSize, padding, margin, pixelRatio]
  )

  // A caller may hand over a loaded font or the file to load. Hooks cannot be
  // called conditionally, so `useFont` always runs and gets null when there is
  // nothing for it to do.
  const isLoadedFont = isSkFont(fontSource)
  const loadedFont = useFont(
    isLoadedFont ? null : (fontSource as Parameters<typeof useFont>[0]),
    metrics.fontSize
  )
  const font = isLoadedFont ? (fontSource as SkFont) : loadedFont

  const [manager] = useState(() => new LabelManager())

  /**
   * Configure the font, and forget anything measured with the old one.
   *
   * Both halves matter. The font is mutated, so it has to be set up before the
   * first pass measures with it — a font configured mid-flight would draw
   * glyphs at widths the layout had already collided against. And measurements
   * are cached per string with no note of the font that produced them, so a
   * size change (the device ratio is part of it) would otherwise keep serving
   * widths from the previous one.
   */
  useEffect(() => {
    if (!font) return
    configureFont(font)
    manager.reset()
    atlasKeyRef.current = ''
  }, [font, manager])
  const buffers = useMemo(() => createLabelLayoutBuffers(MAX_LABELS), [])
  const [atlas, setAtlas] = useState<BakedAtlas | null>(null)
  const atlasKeyRef = useRef('')

  // Anchors in simulation space, refreshed on the slow clock only.
  const anchorsRef = useRef(new Map<number, [number, number]>())
  const sampledRef = useRef(new Map<number, [number, number]>())
  const rankedRef = useRef<number[]>([])

  /**
   * The camera, as data the render thread can read.
   *
   * Written by `onViewTransform` and by nothing else. This one assignment per
   * frame is the entire cost the camera imposes on the JS thread.
   */
  const view = useSharedValue<ViewProjection>(EMPTY_VIEW)
  /**
   * What the render thread needs to place the labels, as plain arrays.
   *
   * Reassigned wholesale on every selection pass, never mutated. Worklets
   * *clone* what crosses the boundary — typed arrays included — so a buffer
   * mutated here would never be seen there, and mutating one already captured
   * is rejected outright. Assignment is the only thing that carries.
   */
  const placement = useSharedValue<LabelPlacement>(EMPTY_LABEL_PLACEMENT)

  // Physical pixels, because the font is. Cached per string by the manager, so
  // this runs once per new label rather than per frame.
  const measure = useCallback((label: { text: string }) => {
    if (!font) {
      return {
        width: label.text.length * metrics.fontSize * 0.55,
        height: metrics.lineHeight,
      }
    }
    const bounds = font.measureText(label.text)
    return {
      width: Math.ceil(bounds.width) + metrics.padding[0] + metrics.padding[2],
      height: metrics.lineHeight,
    }
  }, [font, metrics])

  const policyKey = JSON.stringify(policy)
  const selectedKey = (selectedPointIndices ?? []).join(',')

  /** Everything the camera does not affect. */
  const reselect = useCallback(() => {
    if (!graph || !isReady || !font) return
    const startedAt = Date.now()
    const anchors = anchorsRef.current
    const sampled = sampledRef.current
    const labelTexts = resolved?.pointLabels
    const weights = resolved?.pointLabelWeights

    const selected = manager.select({
      source: {
        text: (index) => labelTexts?.[index],
        weight: (index) => weights?.[index],
        position: (index) => anchors.get(index) ?? sampled.get(index),
        rankedByWeight: rankedRef.current,
        sampled: [...sampled.keys()],
        selected: selectedPointIndices ?? [],
        clusters,
      },
      policy,
      hasSelection: (selectedPointIndices ?? []).length > 0,
      measure,
    }).slice(0, MAX_LABELS)

    fillBuffers(buffers, selected, anchors, sampled, clusters, metrics)
    // Collide here, against the camera as it stands. A pan cannot change which
    // labels overlap — it moves them all equally — so this only goes stale
    // under zoom, and never for longer than one interval.
    layoutLabels(buffers, graph.getViewProjection())
    const atlasKey = `${color}|${chipColor ?? ''}|${metrics.fontSize}|${selected.map((label) => label.text).join('\u0000')}`
    if (atlasKey !== atlasKeyRef.current) {
      // React Compiler cannot prove this callback runs outside render.
      // eslint-disable-next-line react-hooks/immutability
      atlasKeyRef.current = atlasKey
      setAtlas(bakeAtlas(selected, metrics, font, color, chipColor))
    }
    placement.value = toLabelPlacement(buffers)
    onMeasure?.(Date.now() - startedAt, selected.length)
    // `policy` is spread from props and rebuilt every render; `policyKey` is
    // its content, which is what decides the outcome.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    graph, isReady, font, metrics, color, chipColor, measure,
    manager, buffers, resolved, selectedKey, policyKey, clusters, placement, onMeasure,
  ])

  // Ranking depends on the weight column, not on the camera or the selection.
  useEffect(() => {
    const weights = resolved?.pointLabelWeights
    if (!weights) {
      rankedRef.current = []
      return
    }
    const indices: number[] = []
    for (let i = 0; i < weights.length; i++) indices.push(i)
    indices.sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0))
    rankedRef.current = indices
  }, [resolved])

  // Event-driven data clock. A timeout exists only while the graph is moving;
  // there is no recurring idle timer.
  useEffect(() => {
    if (!graph || !isReady) return
    let wasRunning = graph.isSimulationRunning
    const refresh = (): void => {
      const tracked = manager.tracked(
        { rankedByWeight: rankedRef.current, selected: selectedPointIndices ?? [] },
        policy
      )
      graph.trackPointsByIndices(tracked.length > 0 ? tracked : undefined)
      anchorsRef.current = graph.getTrackedPointPositionsMap()
      if (policy.showDynamicLabels !== false) {
        sampledRef.current = graph.sampleVisiblePointIndices()
      }
      reselect()
    }

    const scheduler = new LabelRefreshScheduler(() => refresh(), updateIntervalMs, Date.now)

    scheduler.request('initial', true)
    const stopFrames = graph.onFrame(() => {
      if (graph.isSimulationRunning) {
        wasRunning = true
        scheduler.request('frame')
      } else if (wasRunning) {
        wasRunning = false
        scheduler.request('frame', true)
      }
    })
    const stopView = graph.onViewTransform(() => scheduler.request('view'))
    return () => {
      stopFrames()
      stopView()
      scheduler.cancel()
      graph.trackPointsByIndices(undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, isReady, reselect, updateIntervalMs, selectedKey, policyKey])

  /**
   * The camera clock: one assignment.
   *
   * Deliberately not `setState`, not a re-render, not a recompute — everything
   * downstream reads this shared value from the render thread.
   */
  useEffect(() => {
    if (!graph || !isReady) return
    view.value = graph.getViewProjection()
    return graph.onViewTransform((next) => {
      view.value = next
    })
  }, [graph, isReady, view])

  /**
   * Projection and collision, on the render thread.
   *
   * Re-runs whenever the camera or the layout version changes — both shared
   * values it closes over, which is how the buffer discovers its dependencies.
   * The layout itself runs once per pass, on the first slot.
   */
  const transforms = useRSXformBuffer(MAX_LABELS, (xform, index) => {
    'worklet'
    const projection = view.value
    const placed = placement.value
    const ratio = pixelRatio

    if (index >= placed.count || placed.visible[index] !== 1) {
      xform.set(1, 0, PARKED, PARKED)
      return
    }

    const [screenX, screenY] = projectViewPoint(
      projection,
      placed.anchors[index * 2] as number,
      placed.anchors[index * 2 + 1] as number
    )
    const width = placed.sizes[index * 2] as number
    const height = placed.sizes[index * 2 + 1] as number
    const sprite = labelSpriteTransform(screenX, screenY, width, height, ratio)
    xform.set(sprite.scale, 0, sprite.tx, sprite.ty)
  })

  // Reference-compared by the texture hook, so an inline object would discard
  // and reallocate a GPU surface on every render.
  const textureSize = useMemo(
    () => ({ width: atlas?.size.width ?? 1, height: atlas?.size.height ?? 1 }),
    [atlas?.size.width, atlas?.size.height]
  )
  const texture = usePictureAsTexture(atlas?.picture ?? null, textureSize)

  if (!font || !atlas) return null

  return (
    <Canvas style={styles.canvas} pointerEvents="none">
      {/* `atlas.sprites` is padded to the same length as `transforms`; the
          native atlas throws if they differ. */}
      <Atlas image={texture} sprites={atlas.sprites} transforms={transforms} />
    </Canvas>
  )
}

/** Whether the caller handed over a loaded font rather than a file to load. */
function isSkFont (value: unknown): value is SkFont {
  return typeof value === 'object' && value !== null && 'measureText' in value
}

const EMPTY_VIEW: ViewProjection = {
  k: 1, x: 0, y: 0, offsetX: 0, offsetY: 0, spaceSize: 0, screenWidth: 0, screenHeight: 0,
}

const styles = StyleSheet.create({
  canvas: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: 'none',
  },
})
