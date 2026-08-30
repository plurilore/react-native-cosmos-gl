import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import {
  Canvas,
  Group,
  RoundedRect,
  Text as SkiaText,
  useFont,
  type SkFont,
} from '@shopify/react-native-skia'
import { useCosmosGraph } from '../react/CosmosGraph'
import { LabelManager, type LabelPolicy, type ResolvedLabel } from '../labels'

export type CosmosSkiaLabelsProps = LabelPolicy & {
  /** A font file, as `require('./Inter.ttf')` or a loaded `SkFont`. */
  font: Parameters<typeof useFont>[0] | SkFont
  fontSize?: number
  color?: string
  /** Chip drawn behind the text. Omit for none. */
  chipColor?: string
  /** Gap between a label and the point it names, in pixels. */
  margin?: number
  /** `[left, top, right, bottom]` inside the chip. */
  padding?: [number, number, number, number]
  /**
   * How often to refresh anchor positions from the GPU, in milliseconds.
   *
   * This is the *simulation* rate, not the camera rate: it only matters while
   * points are still moving. Panning and zooming are handled without it.
   */
  updateIntervalMs?: number
  /** Cluster centroids to label, in simulation space. */
  clusters?: readonly { index: number; name: string; count: number; position: [number, number] }[]
}

const DEFAULT_FONT_SIZE = 12
const DEFAULT_MARGIN = 7
const DEFAULT_PADDING: [number, number, number, number] = [5, 3, 5, 3]
const DEFAULT_INTERVAL = 90

/**
 * Graph labels drawn on a single Skia canvas.
 *
 * One native view for every label, rather than one per label. That is the whole
 * point: a React Native `<Text>` per label is composited over the GL surface on
 * every frame, and measured on device, fifty of them cost roughly three
 * quarters of the frame budget on their own — the graph runs at 90fps without
 * them and 40 with. Drawing them as geometry on one canvas removes that cost
 * rather than reducing it.
 *
 * Two clocks, deliberately separated:
 *
 * - **Anchors** come from a GPU readback and only change when the simulation
 *   moves points. Refreshed on a timer, and not at all once the layout settles.
 * - **The camera** changes on every frame of a pan or a pinch, and moves every
 *   label — but moves *only* the anchors. Font size, padding and the collision
 *   boxes are screen-space and do not scale, which is why this projects anchor
 *   coordinates rather than wrapping the text in a transform.
 *
 * Neither clock re-renders React. Anchor updates and camera updates both write
 * into a ref and repaint the canvas directly.
 */
export function CosmosSkiaLabels ({
  font: fontSource,
  fontSize = DEFAULT_FONT_SIZE,
  color = '#f8fafc',
  chipColor,
  margin = DEFAULT_MARGIN,
  padding = DEFAULT_PADDING,
  updateIntervalMs = DEFAULT_INTERVAL,
  clusters,
  ...policy
}: CosmosSkiaLabelsProps): React.ReactElement | null {
  const { graph, resolved, isReady, selectedPointIndices } = useCosmosGraph()
  // A caller may hand over an already-loaded font or the file to load. Hooks
  // cannot be called conditionally, so `useFont` always runs and is given null
  // when there is nothing for it to do.
  const isLoadedFont = isSkFont(fontSource)
  const loadedFont = useFont(isLoadedFont ? null : (fontSource as Parameters<typeof useFont>[0]), fontSize)
  const font = isLoadedFont ? (fontSource as SkFont) : loadedFont

  const [manager] = useState(() => new LabelManager())
  const [labels, setLabels] = useState<ResolvedLabel[]>([])

  // Anchor positions in simulation space, refreshed on the slow clock.
  const anchorsRef = useRef(new Map<number, [number, number]>())
  const sampledRef = useRef(new Map<number, [number, number]>())

  const measure = useCallback((label: { text: string }) => {
    if (!font) return { width: label.text.length * fontSize * 0.55, height: fontSize }
    const width = font.measureText(label.text).width
    return {
      width: width + padding[0] + padding[2],
      height: fontSize + padding[1] + padding[3],
    }
  }, [font, fontSize, padding])

  const policyKey = JSON.stringify(policy)
  const selectedKey = (selectedPointIndices ?? []).join(',')
  const clusterKey = (clusters ?? []).map((cluster) => `${cluster.index}:${cluster.count}`).join(',')

  /** Re-resolves the whole label set. Cheap enough for a tick, not a frame. */
  const recompute = useCallback(() => {
    if (!graph || !isReady) return
    const [width, height] = graph.store.screenSize
    if (!width || !height) return

    const selected = selectedPointIndices ?? []
    const labelTexts = resolved?.pointLabels
    const weights = resolved?.pointLabelWeights
    const ranked = resolved?.pointLabelWeights
      ? rankByWeight(resolved.pointLabelWeights)
      : []

    const next = manager.resolve({
      source: {
        text: (index) => labelTexts?.[index],
        weight: (index) => weights?.[index],
        position: (index) => anchorsRef.current.get(index) ?? sampledRef.current.get(index),
        rankedByWeight: ranked,
        sampled: [...sampledRef.current.keys()],
        selected,
        clusters,
      },
      policy,
      hasSelection: selected.length > 0,
      viewport: { width, height },
      project: (position) => graph.spaceToScreenPosition(position),
      measure,
    })
    setLabels(next)
    // `policy` is spread from props and rebuilt every render; `policyKey` is
    // its content, which is what actually decides the outcome.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, isReady, manager, measure, resolved, selectedKey, policyKey, clusterKey])

  // Slow clock: anchors and viewport samples from the GPU.
  useEffect(() => {
    if (!graph || !isReady) return

    const refresh = (): void => {
      const tracked = manager.tracked(
        {
          rankedByWeight: resolved?.pointLabelWeights ? rankByWeight(resolved.pointLabelWeights) : [],
          selected: selectedPointIndices ?? [],
        },
        policy
      )
      graph.trackPointsByIndices(tracked.length > 0 ? tracked : undefined)
      anchorsRef.current = graph.getTrackedPointPositionsMap()
      if (policy.showDynamicLabels !== false) {
        sampledRef.current = graph.sampleVisiblePointIndices()
      }
      recompute()
    }

    refresh()
    const timer = setInterval(refresh, updateIntervalMs)
    return () => {
      clearInterval(timer)
      graph.trackPointsByIndices(undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, isReady, recompute, updateIntervalMs, selectedKey, policyKey])

  // Fast clock: the camera. Re-projects existing anchors, and never asks the
  // GPU for anything — panning does not move points.
  useEffect(() => {
    if (!graph || !isReady) return
    return graph.onViewTransform(() => recompute())
  }, [graph, isReady, recompute])

  const style = useMemo(() => [StyleSheet.absoluteFill, styles.canvas], [])
  if (!font || labels.length === 0) return null

  return (
    <Canvas style={style} pointerEvents="none">
      {labels.map((label) => {
        const left = label.screenX - label.width / 2
        const top = label.screenY - label.height - margin
        return (
          <Group key={label.id}>
            {chipColor ? (
              <RoundedRect
                x={left}
                y={top}
                width={label.width}
                height={label.height}
                r={4}
                color={chipColor}
              />
            ) : null}
            <SkiaText
              x={left + padding[0]}
              y={top + padding[1] + fontSize * 0.85}
              text={label.text}
              font={font}
              color={color}
            />
          </Group>
        )
      })}
    </Canvas>
  )
}

/** Whether the caller handed over a loaded font rather than a file to load. */
function isSkFont (value: unknown): value is SkFont {
  return typeof value === 'object' && value !== null && 'measureText' in value
}

/** Point indices ordered by label weight, heaviest first. */
function rankByWeight (weights: ArrayLike<number>): number[] {
  const indices: number[] = []
  for (let i = 0; i < weights.length; i++) indices.push(i)
  return indices.sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0))
}

const styles = StyleSheet.create({
  canvas: { pointerEvents: 'none' },
})
