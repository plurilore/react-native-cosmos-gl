import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PixelRatio, StyleSheet } from 'react-native'
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
  packLabels,
  labelAtlasMetrics,
  labelSpriteTransform,
  toLabelPlacement,
  EMPTY_LABEL_PLACEMENT,
  type LabelPlacement,
  type LabelAtlasMetrics,
  type LabelLayoutBuffers,
  type LabelPolicy,
  type MeasuredLabel,
} from '../labels'
import { projectViewPoint, type ViewProjection } from '../core/view-projection'

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

/**
 * Atlas texture width in physical pixels; rows wrap within it.
 *
 * Scaled with the device so a dense screen does not simply stack three times
 * as many rows, and capped at 2048 — half the smallest texture limit any GPU
 * likely to run this reports, which leaves the height budget the same room.
 */
function atlasWidth (pixelRatio: number): number {
  return Math.max(1024, Math.min(2048, Math.round(1024 * pixelRatio)))
}

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
    setAtlas(bakeAtlas(selected, font, metrics, color, chipColor))
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

/**
 * Draws every label once into a single picture, recording where each landed.
 *
 * One texture rather than one per label: the atlas draws them all in a single
 * call, and a call per label would put the cost back where it came from.
 */
export function bakeAtlas (
  labels: readonly MeasuredLabel[],
  font: SkFont,
  metrics: LabelAtlasMetrics,
  color: string,
  chipColor: string | undefined
): BakedAtlas {
  // Padded to the pool size, not to the label count. The native atlas requires
  // the sprite and transform arrays to be the same length and throws if they
  // are not — on every commit, which React then repeats.
  const packed = packLabels(labels, MAX_LABELS, atlasWidth(metrics.pixelRatio))
  const sprites: SkRect[] = packed.sprites.map((sprite) =>
    Skia.XYWHRect(sprite.x, sprite.y, sprite.width, sprite.height)
  )

  const size = { width: packed.width, height: packed.height }
  const textPaint = Skia.Paint()
  textPaint.setColor(Skia.Color(color))
  textPaint.setAntiAlias(true)
  const chipPaint = Skia.Paint()
  chipPaint.setAntiAlias(true)
  if (chipColor) chipPaint.setColor(Skia.Color(chipColor))

  // Baked large and drawn back down, so advances must stay linear or the
  // measured widths stop matching the glyphs that were rasterized.
  font.setSubpixel(true)
  font.setLinearMetrics(true)

  const picture = createPicture((canvas) => {
    // Only what the packer placed; anything past its budget has no slot.
    labels.slice(0, packed.placed).forEach((label, index) => {
      const sprite = sprites[index]
      if (!sprite) return
      if (chipColor) {
        canvas.drawRRect(
          Skia.RRectXY(
            Skia.XYWHRect(sprite.x, sprite.y, sprite.width, sprite.height),
            metrics.radius,
            metrics.radius
          ),
          chipPaint
        )
      }
      canvas.drawText(
        label.text,
        sprite.x + metrics.padding[0],
        sprite.y + metrics.baseline,
        textPaint,
        font
      )
    })
  }, Skia.XYWHRect(0, 0, size.width, size.height))

  return { picture, size, sprites }
}

/**
 * Copies the selected labels into the flat buffers the layout pass reads.
 *
 * The measured sizes arrive in physical pixels, because the atlas is baked in
 * them, and are divided back down here: collision and projection both work in
 * the logical screen space `ViewProjection` reports, and mixing the two would
 * inflate every collision box by the device ratio.
 */
export function fillBuffers (
  buffers: LabelLayoutBuffers,
  labels: readonly MeasuredLabel[],
  anchors: Map<number, [number, number]>,
  sampled: Map<number, [number, number]>,
  clusters: CosmosSkiaLabelsProps['clusters'],
  metrics: LabelAtlasMetrics
): void {
  const { pixelRatio } = metrics
  const margin = metrics.margin / pixelRatio
  buffers.count = labels.length
  labels.forEach((label, index) => {
    const position =
      label.kind === 'cluster'
        ? clusters?.find((cluster) => cluster.index === label.index)?.position ?? label.position
        : anchors.get(label.index) ?? sampled.get(label.index) ?? label.position
    buffers.anchors[index * 2] = position[0]
    buffers.anchors[index * 2 + 1] = position[1]
    buffers.sizes[index * 2] = label.width / pixelRatio
    // The margin lifts the label clear of the point it names; folding it into
    // the height keeps the collision box and the drawn position agreeing.
    buffers.sizes[index * 2 + 1] = label.height / pixelRatio + margin
    buffers.priorities[index] = label.priority
    buffers.forced[index] = label.forceShow ? 1 : 0
  })
  for (let i = labels.length; i < buffers.visible.length; i++) buffers.visible[i] = 0
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
