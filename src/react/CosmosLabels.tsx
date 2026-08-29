import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, StyleSheet, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { useCosmosGraph } from './CosmosGraph'
import { isSamePlacement, type PlacedLabel } from './label-placement'

export type CosmosLabelsProps = {
  /**
   * How many labels to show at once.
   *
   * A cap rather than a preference: labels are the only part of a graph drawn
   * on the CPU, and past a hundred or so they both cost real frame time and
   * stop being readable — a screen of overlapping text conveys less than a
   * screen of none.
   */
  limit?: number
  /**
   * Label every selected point, up to `selectedLimit`, regardless of weight.
   *
   * Selecting something is an explicit request to know what it is, which
   * outranks the weight ordering that decides labels the rest of the time.
   */
  labelSelected?: boolean
  /** Cap on selected-point labels. */
  selectedLimit?: number
  /**
   * Keep labelling unselected points while a selection is active.
   *
   * Off by default: during a selection the surrounding labels are usually
   * noise, and dropping them is what makes the selected subgraph legible.
   */
  labelUnselected?: boolean
  /** Fires when a label is tapped. Requires `selectOnPress` or this to be set. */
  onLabelPress?: (index: number, id: string | undefined) => void
  /**
   * How often to reposition labels, in milliseconds.
   *
   * Labels do not need to update at frame rate. Each update reads point
   * positions back from the GPU, which is a pipeline stall, so this trades a
   * little lag behind a moving simulation for a lot of frame budget. During a
   * pan or zoom the graph moves under the labels between updates; at ~12 Hz
   * that is not perceptible, and it stops mattering entirely once the layout
   * settles.
   */
  updateIntervalMs?: number
  /**
   * Only label these points. Defaults to the highest-weighted ones.
   *
   * Supplying this takes over candidate selection entirely, so `labelSelected`,
   * `labelUnselected` and `selectedLimit` no longer apply — the caller has
   * already decided, including about the selection.
   */
  pointIndices?: number[]
  /** Hide labels below this zoom level, where they would crowd. */
  minZoom?: number
  textStyle?: StyleProp<TextStyle>
  containerStyle?: StyleProp<ViewStyle>
  /** Tapping a label selects its point. */
  selectOnPress?: boolean
}

const DEFAULT_LIMIT = 60
const DEFAULT_SELECTED_LIMIT = 120
const DEFAULT_INTERVAL = 80

/**
 * Text labels that follow their points.
 *
 * Positions come from the engine's tracking pipeline rather than a full
 * position read: only the labelled points are gathered into a small texture,
 * so the cost is set by the number of labels rather than by the size of the
 * graph. That is what makes labelling a 100k-point graph affordable.
 */
export function CosmosLabels ({
  limit = DEFAULT_LIMIT,
  labelSelected = true,
  selectedLimit = DEFAULT_SELECTED_LIMIT,
  labelUnselected = false,
  onLabelPress,
  updateIntervalMs = DEFAULT_INTERVAL,
  pointIndices,
  minZoom,
  textStyle,
  containerStyle,
  selectOnPress = false,
}: CosmosLabelsProps): React.ReactElement | null {
  const { graph, resolved, isReady, selectPoints, selectedPointIndices } = useCosmosGraph()
  const [labels, setLabels] = useState<PlacedLabel[]>([])
  const trackedRef = useRef<number[]>([])
  const candidatesRef = useRef<number[]>([])
  // Read at press time so the handler can stay stable across ticks.
  const resolvedRef = useRef(resolved)
  resolvedRef.current = resolved
  const selectPointsRef = useRef(selectPoints)
  selectPointsRef.current = selectPoints

  /**
   * Which points get labels: the caller's list, or the highest-weighted ones.
   *
   * Weight defaults to degree, so on an unconfigured graph the labelled points
   * are the hubs — the ones whose identity actually explains the structure.
   */
  const candidates = useMemo(() => {
    const labels = resolved?.pointLabels
    if (!resolved || !labels) return []
    if (pointIndices) return pointIndices.slice(0, limit)

    const weights = resolved.pointLabelWeights
    const byWeight = (a: number, b: number): number => (weights[b] ?? 0) - (weights[a] ?? 0)
    const hasLabel = (i: number): boolean => labels[i] !== undefined

    // A selection reframes what is worth naming: the points asked about come
    // first, and everything else is optional context.
    if (labelSelected && selectedPointIndices && selectedPointIndices.length > 0) {
      const selected = selectedPointIndices.filter(hasLabel).sort(byWeight).slice(0, selectedLimit)
      if (!labelUnselected) return selected

      const chosen = new Set(selected)
      const rest: number[] = []
      for (let i = 0; i < labels.length; i++) if (hasLabel(i) && !chosen.has(i)) rest.push(i)
      rest.sort(byWeight)
      return [...selected, ...rest.slice(0, Math.max(0, limit - selected.length))]
    }

    const ranked: number[] = []
    for (let i = 0; i < labels.length; i++) if (hasLabel(i)) ranked.push(i)
    ranked.sort(byWeight)
    return ranked.slice(0, limit)
  }, [resolved, pointIndices, limit, labelSelected, selectedLimit, labelUnselected, selectedPointIndices])

  candidatesRef.current = candidates

  // Registering the tracked set is what makes the readback small, so it is done
  // when the set changes rather than on every update tick.
  //
  // Keyed on the *contents* rather than the array: a caller that recomputes an
  // equal `pointIndices` on every selection change would otherwise re-register
  // each time, and the cleanup below destroys the tracked framebuffer and both
  // its textures — rebuilt, for the same set of points, on every tap.
  const candidatesKey = candidates.join(',')
  useEffect(() => {
    if (!graph || !isReady) return
    trackedRef.current = candidatesRef.current
    const indices = candidatesRef.current
    graph.trackPointsByIndices(indices.length > 0 ? indices : undefined)
    return () => graph.trackPointsByIndices(undefined)
  }, [graph, isReady, candidatesKey])

  // Keyed on `candidatesKey` and not on `candidates`, for the same reason as the
  // effect above: a caller recomputing an equal array must not tear down and
  // restart the placement timer on every render.
  useEffect(() => {
    if (!graph || !isReady || candidatesRef.current.length === 0) {
      setLabels([])
      return
    }

    let cancelled = false
    const update = (): void => {
      if (cancelled) return
      const zoom = graph.getZoomLevel()
      if (minZoom !== undefined && zoom < minZoom) {
        setLabels((current) => (current.length === 0 ? current : []))
        return
      }

      const positions = graph.getTrackedPointPositionsMap()
      const [width, height] = graph.store.screenSize
      const placed: PlacedLabel[] = []

      for (const index of trackedRef.current) {
        const position = positions.get(index)
        const text = resolvedRef.current?.pointLabels?.[index]
        if (!position || text === undefined) continue
        const [x, y] = graph.spaceToScreenPosition(position)
        // Off-screen labels are dropped rather than clamped to the edge, where
        // they would pile into an unreadable stack along the border and claim
        // to describe points nobody can see.
        if (x < -80 || y < -40 || x > width + 80 || y > height + 40) continue
        placed.push({ index, text, x, y })
      }

      // A settled graph places every label where it already is. Re-rendering
      // then costs a full reconciliation of up to `limit` text nodes for no
      // visible change — and it lands on the same JS thread that drives the
      // frame loop, so it is paid in frames.
      setLabels((current) => (isSamePlacement(current, placed) ? current : placed))
    }

    update()
    const timer = setInterval(update, updateIntervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [graph, isReady, candidatesKey, updateIntervalMs, minZoom])

  // Stable across ticks, so a memoised row is not invalidated by its handler.
  const handlePress = useCallback((index: number) => {
    onLabelPress?.(index, resolvedRef.current?.pointIds?.[index])
    if (selectOnPress) selectPointsRef.current([index], { includeNeighbors: true })
  }, [onLabelPress, selectOnPress])

  if (labels.length === 0) return null

  const isInteractive = selectOnPress || onLabelPress !== undefined

  return (
    <View pointerEvents={isInteractive ? 'box-none' : 'none'} style={[StyleSheet.absoluteFill, containerStyle]}>
      {labels.map((label) => (
        <LabelText
          key={label.index}
          label={label}
          isInteractive={isInteractive}
          onPress={handlePress}
          textStyle={textStyle}
        />
      ))}
    </View>
  )
}

type LabelTextProps = {
  label: PlacedLabel
  isInteractive: boolean
  onPress: (index: number) => void
  textStyle: StyleProp<TextStyle> | undefined
}

/**
 * One label.
 *
 * Memoised, and given a stable press handler, so a tick that moves three labels
 * re-renders three of them rather than all sixty.
 */
const LabelText = React.memo(function LabelText (
  { label, isInteractive, onPress, textStyle }: LabelTextProps
): React.ReactElement {
  const press = useCallback(() => onPress(label.index), [onPress, label.index])
  return (
    <Text
      onPress={isInteractive ? press : undefined}
      numberOfLines={1}
      style={[
        styles.label,
        // Translated rather than positioned by `left`/`top` so the label is
        // centred horizontally on its point and sits just above it, clear
        // of the mark itself.
        { transform: [{ translateX: label.x }, { translateY: label.y }] },
        textStyle,
      ]}
    >
      {label.text}
    </Text>
  )
})

const styles = StyleSheet.create({
  label: {
    position: 'absolute',
    left: -60,
    top: -22,
    width: 120,
    textAlign: 'center',
    color: '#f2f5f9',
    fontSize: 11,
    fontWeight: '500',
    // A dark halo rather than a filled background: a box behind every label
    // would occlude the points the labels are meant to explain.
    textShadowColor: 'rgba(0, 0, 0, 0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
})
