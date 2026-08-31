import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PixelRatio } from 'react-native'
import { useFont, type SkFont } from '@shopify/react-native-skia'
import { getRgbaColor } from '../core/color'
import type { LabelDrawData } from '../core/labels'
import { currentTime } from '../core/transition'
import type { ViewProjection } from '../core/view-projection'
import { useCosmosGraph } from '../react/CosmosGraph'
import {
  LabelAtlasCache,
  labelAtlasCacheKey,
  LabelManager,
  LabelRefreshScheduler,
  createLabelLayoutBuffers,
  labelAtlasMetrics,
  layoutLabels,
  type LabelAtlasSlot,
  type LabelPolicy,
  type MeasuredLabel,
} from '../labels'
import {
  configureFont,
  mergeAdjacentLabelPatches,
  rasterizeLabelPatches,
  type LabelRasterRequest,
} from './rasterize'

export type LabelPerformanceSample = {
  reason: 'initial' | 'frame' | 'view' | 'data'
  gatherMs: number
  sampleMs: number
  selectMs: number
  rasterMs: number
  uploadMs: number
  totalMs: number
  count: number
  visibleCount: number
  cacheHits: number
  cacheMisses: number
  atlasGeneration: number
  atlasOverflowCount: number
  atlasBytes: number
  readbackCount: number
  readbackBytes: number
  uploadCount: number
  uploadBytes: number
}

export type CosmosInlineSkiaLabelsProps = LabelPolicy & {
  font: Parameters<typeof useFont>[0] | SkFont
  fontSize?: number
  color?: string
  chipColor?: string
  margin?: number
  padding?: readonly [number, number, number, number]
  updateIntervalMs?: number
  clusters?: readonly { index: number; name: string; count: number; position: [number, number] }[]
  onMeasure?: (durationMs: number, count: number) => void
  onPerformanceSample?: (sample: LabelPerformanceSample) => void
}

const DEFAULT_FONT_SIZE = 12
const DEFAULT_MARGIN = 7
const DEFAULT_PADDING = [5, 3, 5, 3] as const
const DEFAULT_INTERVAL = 100
const DEFAULT_ATLAS_SIZE = 2048

/** Configures the graph's single-surface GL label layer and renders no view. */
export function CosmosInlineSkiaLabels ({
  font: fontSource,
  fontSize = DEFAULT_FONT_SIZE,
  color = '#f8fafc',
  chipColor = 'transparent',
  margin = DEFAULT_MARGIN,
  padding = DEFAULT_PADDING,
  updateIntervalMs = DEFAULT_INTERVAL,
  clusters,
  onMeasure,
  onPerformanceSample,
  ...policy
}: CosmosInlineSkiaLabelsProps): React.ReactElement | null {
  const { graph, resolved, isReady, selectedPointIndices } = useCosmosGraph()
  const pixelRatio = Math.min(PixelRatio.get(), 2)
  const metrics = useMemo(
    () => labelAtlasMetrics({ fontSize, padding, margin, pixelRatio }),
    [fontSize, padding, margin, pixelRatio]
  )

  const isLoadedFont = isSkFont(fontSource)
  const loadedFont = useFont(
    isLoadedFont ? null : (fontSource as Parameters<typeof useFont>[0]),
    metrics.fontSize
  )
  const font = isLoadedFont ? (fontSource as SkFont) : loadedFont

  const [manager] = useState(() => new LabelManager())
  const cacheRef = useRef<LabelAtlasCache | undefined>(undefined)
  const rankedRef = useRef<number[]>([])
  const lastDrawHashRef = useRef('')
  const lastLayoutHashRef = useRef('')
  const overflowMembershipRef = useRef<string | undefined>(undefined)
  const selectionCacheRef = useRef<{ key: string; labels: MeasuredLabel[] } | undefined>(undefined)
  const dataGenerationRef = useRef(0)
  const hasScheduledInitialRef = useRef(false)

  const policyKey = JSON.stringify(policy)
  const selectedKey = (selectedPointIndices ?? []).join(',')
  const clusterKey = JSON.stringify(clusters ?? [])
  const labelCapacity = useMemo(
    () => inlineLabelCapacity(policy, clusters?.length ?? 0),
    // `policy` is a rebuilt rest object; its serialized content is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [policyKey, clusterKey]
  )
  const buffers = useMemo(() => createLabelLayoutBuffers(labelCapacity), [labelCapacity])

  useEffect(() => {
    dataGenerationRef.current += 1
    selectionCacheRef.current = undefined
    lastLayoutHashRef.current = ''
    overflowMembershipRef.current = undefined
    const weights = resolved?.pointLabelWeights
    if (!weights) {
      rankedRef.current = []
      return
    }
    const indices = Array.from({ length: weights.length }, (_, index) => index)
    indices.sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0))
    rankedRef.current = indices
  }, [resolved])

  useEffect(() => {
    if (!graph || !isReady || !font) return
    configureFont(font)
    manager.reset()
    lastDrawHashRef.current = ''
    lastLayoutHashRef.current = ''
    selectionCacheRef.current = undefined
    overflowMembershipRef.current = undefined
    const size = Math.min(DEFAULT_ATLAS_SIZE, graph.device.features.maxTextureSize)
    cacheRef.current = new LabelAtlasCache(size, size)
    graph.setLabelAtlas({ width: size, height: size, format: 'r8unorm' })
    return () => {
      graph.clearLabels()
      graph.trackPointsByIndices(undefined)
    }
  }, [graph, isReady, font, metrics, manager])

  const measure = useCallback((label: { text: string }) => {
    if (!font) {
      return { width: label.text.length * metrics.fontSize * 0.55, height: metrics.lineHeight }
    }
    const bounds = font.measureText(label.text)
    return {
      width: Math.ceil(bounds.width) + metrics.padding[0] + metrics.padding[2],
      height: metrics.lineHeight,
    }
  }, [font, metrics])

  useEffect(() => {
    if (!graph || !onPerformanceSample) return
    return graph.device.enablePerformanceCounters()
  }, [graph, onPerformanceSample])

  const refresh = useCallback((reason: LabelPerformanceSample['reason']) => {
    if (!graph || !isReady || !font) return
    const cache = cacheRef.current
    if (!cache) return

    const startedAt = currentTime()
    const deviceBefore = onPerformanceSample
      ? graph.device.getPerformanceCounters()
      : undefined
    const labelRendererBefore = onPerformanceSample
      ? graph.getLabelRendererStats()
      : undefined
    const tracked = manager.tracked(
      { rankedByWeight: rankedRef.current, selected: selectedPointIndices ?? [] },
      policy
    )

    const gatherStarted = currentTime()
    const anchors = graph.getPointPositionsByIndices(tracked)
    const gatherMs = currentTime() - gatherStarted

    const sampleStarted = currentTime()
    const sampled = policy.showDynamicLabels === false
      ? new Map<number, [number, number]>()
      : graph.sampleVisiblePointIndices()
    const sampleMs = currentTime() - sampleStarted
    const deviceAfterReadbacks = onPerformanceSample
      ? graph.device.getPerformanceCounters()
      : undefined
    const readbackCount = deviceBefore && deviceAfterReadbacks
      ? deviceAfterReadbacks.readbacks - deviceBefore.readbacks
      : 0
    const readbackBytes = deviceBefore && deviceAfterReadbacks
      ? deviceAfterReadbacks.readbackBytes - deviceBefore.readbackBytes
      : 0

    const selectStarted = currentTime()
    const sampledIndices = [...sampled.keys()]
    const selectionKey = `${dataGenerationRef.current}|${policyKey}|${selectedKey}|${clusterKey}|${sampledIndices.join(',')}`
    let labels = selectionCacheRef.current?.key === selectionKey
      ? selectionCacheRef.current.labels
      : undefined
    if (!labels) {
      labels = manager.select({
        source: {
          text: (index) => resolved?.pointLabels?.[index],
          weight: (index) => resolved?.pointLabelWeights?.[index],
          position: (index) => anchors.get(index) ?? sampled.get(index),
          rankedByWeight: rankedRef.current,
          sampled: sampledIndices,
          selected: selectedPointIndices ?? [],
          clusters,
        },
        policy,
        hasSelection: (selectedPointIndices?.length ?? 0) > 0,
        measure,
      }).slice(0, labelCapacity)
      selectionCacheRef.current = { key: selectionKey, labels }
    }

    const beforeHits = cache.hits
    const beforeMisses = cache.misses
    const membershipKey = hashLabelMembership(labels)
    let allocated = overflowMembershipRef.current === membershipKey
      ? allocateExisting(labels, cache, metrics)
      : allocate(labels, cache, metrics)
    if (allocated.overflowed) {
      cache.reset()
      allocated = allocate([...labels].sort((a, b) => b.priority - a.priority), cache, metrics)
    }
    overflowMembershipRef.current = allocated.dropped ? membershipKey : undefined
    const slotById = new Map(allocated.values.map((value) => [value.label.id, value.slot]))
    const active = labels.flatMap((label) => {
      const slot = slotById.get(label.id)
      return slot ? [{ label, slot }] : []
    })
    const selectMs = currentTime() - selectStarted

    const rasterStarted = currentTime()
    let patches: ReturnType<typeof rasterizeLabelPatches> = []
    let rasterizedSpriteCount = 0
    if (allocated.missing.length > 0) {
      try {
        patches = rasterizeLabelPatches(allocated.missing, metrics, font, cache.width)
        rasterizedSpriteCount = patches.length
        patches = mergeAdjacentLabelPatches(patches)
      } catch {
        // A missing/older Skia native runtime should hide labels, not take the
        // graph down with it. The next policy refresh can retry.
        patches = []
      }
    }
    const rasterMs = currentTime() - rasterStarted

    const uploadStarted = currentTime()
    if (rasterizedSpriteCount !== allocated.missing.length) {
      // A cache slot is not valid until its pixels reach GL. Keeping a failed
      // slot would turn the next acquire into a false cache hit and could show
      // stale glyphs after a repack, so abandon this generation atomically.
      cache.reset()
      graph.clearLabels()
      lastDrawHashRef.current = ''
      lastLayoutHashRef.current = ''
      overflowMembershipRef.current = undefined
      const totalMs = currentTime() - startedAt
      onMeasure?.(totalMs, 0)
      onPerformanceSample?.({
        reason,
        gatherMs,
        sampleMs,
        selectMs,
        rasterMs,
        uploadMs: currentTime() - uploadStarted,
        totalMs,
        count: 0,
        visibleCount: 0,
        cacheHits: cache.hits - beforeHits,
        cacheMisses: cache.misses - beforeMisses,
        atlasGeneration: cache.generation,
        atlasOverflowCount: cache.overflows,
        atlasBytes: cache.width * cache.height,
        readbackCount,
        readbackBytes,
        uploadCount: 0,
        uploadBytes: 0,
      })
      return
    }
    if (patches.length > 0) graph.updateLabelAtlas(patches)

    fillLayout(
      buffers,
      active.map((value) => value.label),
      anchors,
      sampled,
      clusters,
      metrics.pixelRatio,
      margin,
      graph,
      resolved?.pointSizes
    )
    const view = graph.getViewProjection()
    const layoutHash = hashLayoutData(active, buffers, view)
    if (layoutHash !== lastLayoutHashRef.current) {
      layoutLabels(buffers, view)
      lastLayoutHashRef.current = layoutHash
    }
    const drawData = buildDrawData(active, buffers, cache, color, chipColor, margin, metrics, resolved, graph)
    const drawHash = hashDrawData(active, buffers, color, chipColor, margin, cache.generation)
    if (drawHash !== lastDrawHashRef.current) {
      lastDrawHashRef.current = drawHash
      graph.setLabels(drawData)
    }
    const uploadMs = currentTime() - uploadStarted

    const totalMs = currentTime() - startedAt
    const visibleCount = countVisible(buffers.visible, buffers.count)
    const labelRendererAfter = onPerformanceSample
      ? graph.getLabelRendererStats()
      : undefined
    onMeasure?.(totalMs, active.length)
    onPerformanceSample?.({
      reason,
      gatherMs,
      sampleMs,
      selectMs,
      rasterMs,
      uploadMs,
      totalMs,
      count: active.length,
      visibleCount,
      cacheHits: cache.hits - beforeHits,
      cacheMisses: cache.misses - beforeMisses,
      atlasGeneration: cache.generation,
      atlasOverflowCount: cache.overflows,
      atlasBytes: labelRendererAfter?.atlasBytes ?? cache.width * cache.height,
      readbackCount,
      readbackBytes,
      uploadCount: labelRendererBefore && labelRendererAfter
        ? (
            labelRendererAfter.atlasUploads - labelRendererBefore.atlasUploads +
            labelRendererAfter.instanceUploads - labelRendererBefore.instanceUploads
          )
        : 0,
      uploadBytes: labelRendererBefore && labelRendererAfter
        ? (
            labelRendererAfter.atlasUploadBytes - labelRendererBefore.atlasUploadBytes +
            labelRendererAfter.instanceUploadBytes - labelRendererBefore.instanceUploadBytes
          )
        : 0,
    })
  // Props are represented by stable content keys below rather than their
  // container identities, which callers commonly recreate each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    graph, isReady, font, resolved, manager, buffers, measure, metrics,
    color, chipColor, margin, selectedKey, policyKey, clusterKey,
    labelCapacity, onMeasure, onPerformanceSample,
  ])

  useEffect(() => {
    if (!graph || !isReady || !font) return
    let wasRunning = graph.isSimulationRunning
    const scheduler = new LabelRefreshScheduler(refresh, updateIntervalMs, currentTime)

    const initialReason = hasScheduledInitialRef.current ? 'data' : 'initial'
    hasScheduledInitialRef.current = true
    scheduler.request(initialReason, true)
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
    }
  }, [graph, isReady, font, refresh, updateIntervalMs])

  return null
}

function allocate (
  labels: readonly MeasuredLabel[],
  cache: LabelAtlasCache,
  metrics: ReturnType<typeof labelAtlasMetrics>
): {
  values: { label: MeasuredLabel; slot: LabelAtlasSlot }[]
  missing: LabelRasterRequest[]
  overflowed: boolean
  dropped: boolean
} {
  const values: { label: MeasuredLabel; slot: LabelAtlasSlot }[] = []
  const missing: LabelRasterRequest[] = []
  let overflowed = false
  let dropped = false
  for (const label of labels) {
    const key = labelAtlasCacheKey(label.text, cache.generation, metrics.fontSize, metrics.pixelRatio)
    if (label.width > cache.width || label.height > cache.height) {
      cache.acquire(key, label.width, label.height)
      dropped = true
      continue
    }
    const result = cache.acquire(key, label.width, label.height)
    if (!result) {
      overflowed = true
      dropped = true
      continue
    }
    values.push({ label, slot: result.slot })
    if (!result.hit) missing.push({ text: label.text, slot: result.slot })
  }
  return { values, missing, overflowed, dropped }
}

function allocateExisting (
  labels: readonly MeasuredLabel[],
  cache: LabelAtlasCache,
  metrics: ReturnType<typeof labelAtlasMetrics>
): ReturnType<typeof allocate> {
  const values: { label: MeasuredLabel; slot: LabelAtlasSlot }[] = []
  let dropped = false
  for (const label of labels) {
    const key = labelAtlasCacheKey(label.text, cache.generation, metrics.fontSize, metrics.pixelRatio)
    if (!cache.get(key)) {
      dropped = true
      continue
    }
    const result = cache.acquire(key, label.width, label.height)
    if (result) values.push({ label, slot: result.slot })
    else dropped = true
  }
  return { values, missing: [], overflowed: false, dropped }
}

function fillLayout (
  buffers: ReturnType<typeof createLabelLayoutBuffers>,
  labels: readonly MeasuredLabel[],
  anchors: Map<number, [number, number]>,
  sampled: Map<number, [number, number]>,
  clusters: CosmosInlineSkiaLabelsProps['clusters'],
  pixelRatio: number,
  margin: number,
  graph: NonNullable<ReturnType<typeof useCosmosGraph>['graph']>,
  pointSizes?: Float32Array
): void {
  buffers.count = labels.length
  labels.forEach((label, index) => {
    const position = label.kind === 'cluster'
      ? clusters?.find((cluster) => cluster.index === label.index)?.position ?? label.position
      : anchors.get(label.index) ?? sampled.get(label.index) ?? label.position
    buffers.anchors[index * 2] = position[0]
    buffers.anchors[index * 2 + 1] = position[1]
    buffers.sizes[index * 2] = label.width / pixelRatio
    buffers.sizes[index * 2 + 1] = label.height / pixelRatio + margin + pointRadius(label, graph, pointSizes)
    buffers.priorities[index] = label.priority
    buffers.forced[index] = label.forceShow ? 1 : 0
  })
  for (let i = labels.length; i < buffers.visible.length; i++) buffers.visible[i] = 0
}

function buildDrawData (
  active: readonly { label: MeasuredLabel; slot: LabelAtlasSlot }[],
  buffers: ReturnType<typeof createLabelLayoutBuffers>,
  cache: LabelAtlasCache,
  color: string,
  chipColor: string,
  margin: number,
  metrics: ReturnType<typeof labelAtlasMetrics>,
  resolved: ReturnType<typeof useCosmosGraph>['resolved'],
  graph: NonNullable<ReturnType<typeof useCosmosGraph>['graph']>
): LabelDrawData {
  const count = active.length
  const pointIndices = new Float32Array(count)
  const anchors = new Float32Array(count * 2)
  const sizes = new Float32Array(count * 2)
  const uvRects = new Float32Array(count * 4)
  const visible = new Float32Array(count)
  const textColors = new Float32Array(count * 4)
  const chipColors = new Float32Array(count * 4)
  const pointRadii = new Float32Array(count)
  const margins = new Float32Array(count)
  const cornerRadii = new Float32Array(count)
  const textRgba = getRgbaColor(color)
  const chipRgba = getRgbaColor(chipColor)

  active.forEach(({ label, slot }, index) => {
    pointIndices[index] = label.kind === 'cluster' ? -1 : label.index
    anchors[index * 2] = buffers.anchors[index * 2] as number
    anchors[index * 2 + 1] = buffers.anchors[index * 2 + 1] as number
    sizes[index * 2] = label.width / metrics.pixelRatio
    sizes[index * 2 + 1] = label.height / metrics.pixelRatio
    // Sample texel centres, not the boundaries between this sprite and its
    // one-pixel shelf gap. That keeps linear filtering from bleeding a nearby
    // glyph into long labels or accented ascenders.
    uvRects[index * 4] = (slot.x + 0.5) / cache.width
    uvRects[index * 4 + 1] = (slot.y + 0.5) / cache.height
    uvRects[index * 4 + 2] = (slot.x + slot.width - 0.5) / cache.width
    uvRects[index * 4 + 3] = (slot.y + slot.height - 0.5) / cache.height
    visible[index] = buffers.visible[index] as number
    textColors.set(textRgba, index * 4)
    chipColors.set(chipRgba, index * 4)
    pointRadii[index] = label.kind === 'cluster' ? 0 : pointRadius(label, graph, resolved?.pointSizes)
    margins[index] = margin
    cornerRadii[index] = metrics.radius / metrics.pixelRatio
  })

  return {
    count,
    pointIndices,
    anchors,
    sizes,
    uvRects,
    visible,
    textColors,
    chipColors,
    pointRadii,
    margins,
    cornerRadii,
  }
}

function pointRadius (
  label: MeasuredLabel,
  graph: NonNullable<ReturnType<typeof useCosmosGraph>['graph']>,
  sizes?: Float32Array
): number {
  const raw = sizes?.[label.index]
  const size = raw !== undefined && Number.isFinite(raw) ? raw : graph.config.pointDefaultSize
  const zoom = graph.zoomTransform.k
  const zoomScale = graph.config.scalePointsOnZoom ? zoom : Math.min(5, Math.max(1, zoom * 0.01))
  return Math.min(size * graph.config.pointSizeScale * zoomScale, graph.store.maxPointSize) / 2
}

function hashDrawData (
  active: readonly { label: MeasuredLabel; slot: LabelAtlasSlot }[],
  buffers: ReturnType<typeof createLabelLayoutBuffers>,
  color: string,
  chipColor: string,
  margin: number,
  generation: number
): string {
  let value = `${generation}|${color}|${chipColor}|${margin}`
  for (let i = 0; i < active.length; i++) {
    const item = active[i]
    value += `|${item?.label.id}:${item?.slot.x}:${item?.slot.y}:${buffers.visible[i] ?? 0}`
    value += `:${buffers.sizes[i * 2] ?? 0}:${buffers.sizes[i * 2 + 1] ?? 0}`
    if (item?.label.kind === 'cluster') {
      value += `:${buffers.anchors[i * 2] ?? 0}:${buffers.anchors[i * 2 + 1] ?? 0}`
    }
  }
  return value
}

function countVisible (visible: Uint8Array, count: number): number {
  let result = 0
  for (let i = 0; i < count; i++) result += visible[i] ?? 0
  return result
}

function hashLayoutData (
  active: readonly { label: MeasuredLabel }[],
  buffers: ReturnType<typeof createLabelLayoutBuffers>,
  view: ViewProjection
): string {
  let value = `${view.k}:${view.x}:${view.y}:${view.screenWidth}:${view.screenHeight}`
  for (let i = 0; i < active.length; i++) {
    value += `|${active[i]?.label.id}:${buffers.anchors[i * 2] ?? 0}:${buffers.anchors[i * 2 + 1] ?? 0}`
    value += `:${buffers.sizes[i * 2] ?? 0}:${buffers.sizes[i * 2 + 1] ?? 0}`
  }
  return value
}

function hashLabelMembership (labels: readonly MeasuredLabel[]): string {
  let value = ''
  for (const label of labels) {
    value += `|${label.id.length}:${label.id}${label.text.length}:${label.text}`
    value += `:${label.width}:${label.height}:${label.priority}`
  }
  return value
}

function isSkFont (value: unknown): value is SkFont {
  return typeof value === 'object' && value !== null && 'measureText' in value
}

function inlineLabelCapacity (policy: LabelPolicy, clusterCount: number): number {
  const forced = new Set(policy.showLabelsFor ?? []).size
  const top = policy.showTopLabels === false ? 0 : policyLimit(policy.topLabelsLimit, 120)
  const dynamic = policy.showDynamicLabels === false ? 0 : policyLimit(policy.dynamicLabelsLimit, 120)
  const selected = policy.showSelectedLabels === false ? 0 : policyLimit(policy.selectedLabelsLimit, 140)
  const clusters = policy.showClusterLabels
    ? Math.min(clusterCount, policyLimit(policy.clusterLabelsLimit, 120))
    : 0
  // Cluster and point modes are mutually exclusive, while forced labels can
  // coexist with either. Allocate for the larger path and upload only the live
  // count; no parked sprite pool is drawn.
  return Math.max(1, forced + Math.max(top + dynamic + selected, clusters))
}

function policyLimit (value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : fallback
}
