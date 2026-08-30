import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import {
  Atlas,
  Canvas,
  Skia,
  createPicture,
  useFont,
  usePictureAsTexture,
  useRSXformBuffer,
  type SkFont,
  type SkPicture,
  type SkRect,
} from '@shopify/react-native-skia'
import { useSharedValue } from 'react-native-reanimated'
import { useCosmosGraph } from '../react/CosmosGraph'
import {
  LabelManager,
  createLabelLayoutBuffers,
  layoutLabels,
  type LabelLayoutBuffers,
  type LabelPolicy,
  type MeasuredLabel,
} from '../labels'
import type { ViewProjection } from '../core/view-projection'

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
}

/**
 * The most labels drawn at once.
 *
 * Fixed, because the atlas requires its sprite and transform arrays to be the
 * same length, and the transform buffer allocates once for a stable size.
 * Unused slots are parked off-screen rather than removed.
 */
const MAX_LABELS = 160

/** Where a parked slot goes. Far enough that no viewport can contain it. */
const PARKED = -100_000

const DEFAULT_FONT_SIZE = 12
const DEFAULT_MARGIN = 7
const DEFAULT_PADDING = [5, 3, 5, 3] as const
const DEFAULT_INTERVAL = 90
/** Atlas texture width; rows wrap within it. */
const ATLAS_WIDTH = 1024

type BakedAtlas = {
  picture: SkPicture
  size: { width: number; height: number }
  sprites: SkRect[]
}

/**
 * Graph labels drawn as one atlas.
 *
 * The design follows from what a pan actually changes. Labels move on every
 * frame of a gesture, but almost nothing about them *changes*: the text is the
 * same, so its measured width is the same, and so is which labels were chosen
 * and what they outrank. Only the projection depends on the camera.
 *
 * So the work is split by what it depends on:
 *
 * - **The data clock** — a timer, plus set changes — selects labels, measures
 *   them once, and bakes them into a single texture. This is the only part
 *   that touches React.
 * - **The camera clock** — every frame, on the render thread — projects the
 *   anchors and resolves overlaps into a transform buffer. It allocates
 *   nothing, crosses no thread boundary, and draws through one call.
 *
 * The camera path therefore performs **no React render and no JS-thread work**
 * beyond a single assignment. That is the whole point, and it is directly
 * checkable: if a pan causes a React commit, this is not working.
 *
 * Text is baked at a fixed size and never scaled by the camera; only the
 * anchor moves. Labels are screen-space furniture, not part of the scene.
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
  onMeasure,
  ...policy
}: CosmosSkiaLabelsProps): React.ReactElement | null {
  const { graph, resolved, isReady, selectedPointIndices } = useCosmosGraph()

  // A caller may hand over a loaded font or the file to load. Hooks cannot be
  // called conditionally, so `useFont` always runs and gets null when there is
  // nothing for it to do.
  const isLoadedFont = isSkFont(fontSource)
  const loadedFont = useFont(isLoadedFont ? null : (fontSource as Parameters<typeof useFont>[0]), fontSize)
  const font = isLoadedFont ? (fontSource as SkFont) : loadedFont

  const [manager] = useState(() => new LabelManager())
  const buffers = useMemo(() => createLabelLayoutBuffers(MAX_LABELS), [])
  const [atlas, setAtlas] = useState<BakedAtlas | null>(null)

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
  /** Bumped when the layout inputs change, so the transform buffer re-runs. */
  const layoutVersion = useSharedValue(0)

  const measure = useCallback((label: { text: string }) => {
    if (!font) return { width: label.text.length * fontSize * 0.55, height: fontSize }
    const bounds = font.measureText(label.text)
    return {
      width: bounds.width + padding[0] + padding[2],
      height: fontSize + padding[1] + padding[3],
    }
  }, [font, fontSize, padding])

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

    fillBuffers(buffers, selected, anchors, sampled, clusters, margin)
    setAtlas(bakeAtlas(selected, font, fontSize, color, chipColor, padding))
    layoutVersion.value += 1
    onMeasure?.(Date.now() - startedAt, selected.length)
    // `policy` is spread from props and rebuilt every render; `policyKey` is
    // its content, which is what decides the outcome.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    graph, isReady, font, fontSize, color, chipColor, padding, margin, measure,
    manager, buffers, resolved, selectedKey, policyKey, clusters, layoutVersion, onMeasure,
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

  // The data clock.
  useEffect(() => {
    if (!graph || !isReady) return

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

    refresh()
    const timer = setInterval(refresh, updateIntervalMs)
    return () => {
      clearInterval(timer)
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
    // Read so the buffer also re-runs when the selection changes, not only
    // when the camera moves.
    const version = layoutVersion.value
    if (version < 0) return

    if (index === 0) layoutLabels(buffers, projection)

    if (index >= buffers.count || buffers.visible[index] !== 1) {
      xform.set(1, 0, PARKED, PARKED)
      return
    }
    const width = buffers.sizes[index * 2] as number
    const height = buffers.sizes[index * 2 + 1] as number
    // The sprite draws from its top-left and the anchor names the point, so
    // the label sits centred above it. `height` already carries the margin.
    xform.set(
      1,
      0,
      (buffers.screen[index * 2] as number) - width / 2,
      (buffers.screen[index * 2 + 1] as number) - height
    )
  })

  const texture = usePictureAsTexture(atlas?.picture ?? null, atlas?.size ?? UNIT_SIZE)
  const sprites = atlas?.sprites ?? EMPTY_SPRITES

  if (!font || !atlas) return null

  return (
    <Canvas style={styles.canvas} pointerEvents="none">
      <Atlas image={texture} sprites={sprites} transforms={transforms} />
    </Canvas>
  )
}

/**
 * Draws every label once into a single picture, recording where each landed.
 *
 * One texture rather than one per label: the atlas draws them all in a single
 * call, and a call per label would put the cost back where it came from.
 */
export function bakeAtlas (
  labels: readonly MeasuredLabel[],
  font: SkFont,
  fontSize: number,
  color: string,
  chipColor: string | undefined,
  padding: readonly [number, number, number, number]
): BakedAtlas {
  const sprites: SkRect[] = []
  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0

  for (const label of labels) {
    if (cursorX + label.width > ATLAS_WIDTH && cursorX > 0) {
      cursorX = 0
      cursorY += rowHeight
      rowHeight = 0
    }
    sprites.push(Skia.XYWHRect(cursorX, cursorY, label.width, label.height))
    cursorX += label.width
    rowHeight = Math.max(rowHeight, label.height)
  }

  const size = { width: ATLAS_WIDTH, height: Math.max(1, cursorY + rowHeight) }
  const textPaint = Skia.Paint()
  textPaint.setColor(Skia.Color(color))
  const chipPaint = Skia.Paint()
  if (chipColor) chipPaint.setColor(Skia.Color(chipColor))

  const picture = createPicture((canvas) => {
    labels.forEach((label, index) => {
      const sprite = sprites[index]
      if (!sprite) return
      if (chipColor) {
        canvas.drawRRect(
          Skia.RRectXY(Skia.XYWHRect(sprite.x, sprite.y, label.width, label.height), 4, 4),
          chipPaint
        )
      }
      canvas.drawText(
        label.text,
        sprite.x + padding[0],
        // Baseline: the top padding plus most of the em box.
        sprite.y + padding[1] + fontSize * 0.82,
        textPaint,
        font
      )
    })
  }, Skia.XYWHRect(0, 0, size.width, size.height))

  return { picture, size, sprites }
}

/** Copies the selected labels into the flat buffers the layout pass reads. */
export function fillBuffers (
  buffers: LabelLayoutBuffers,
  labels: readonly MeasuredLabel[],
  anchors: Map<number, [number, number]>,
  sampled: Map<number, [number, number]>,
  clusters: CosmosSkiaLabelsProps['clusters'],
  margin: number
): void {
  buffers.count = labels.length
  labels.forEach((label, index) => {
    const position =
      label.kind === 'cluster'
        ? clusters?.find((cluster) => cluster.index === label.index)?.position ?? label.position
        : anchors.get(label.index) ?? sampled.get(label.index) ?? label.position
    buffers.anchors[index * 2] = position[0]
    buffers.anchors[index * 2 + 1] = position[1]
    buffers.sizes[index * 2] = label.width
    // The margin lifts the label clear of the point it names; folding it into
    // the height keeps the collision box and the drawn position agreeing.
    buffers.sizes[index * 2 + 1] = label.height + margin
    buffers.priorities[index] = label.priority
    buffers.forced[index] = label.forceShow ? 1 : 0
  })
  for (let i = labels.length; i < buffers.visible.length; i++) buffers.visible[i] = 0
}

/** Whether the caller handed over a loaded font rather than a file to load. */
function isSkFont (value: unknown): value is SkFont {
  return typeof value === 'object' && value !== null && 'measureText' in value
}

const EMPTY_SPRITES: SkRect[] = []
const UNIT_SIZE = { width: 1, height: 1 }
const EMPTY_VIEW: ViewProjection = {
  k: 1, x: 0, y: 0, offsetX: 0, offsetY: 0, spaceSize: 0, screenWidth: 0, screenHeight: 0,
}

const styles = StyleSheet.create({
  canvas: { ...StyleSheet.absoluteFillObject, pointerEvents: 'none' },
})
