import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, StyleSheet, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { useCosmosGraph } from './CosmosGraph'

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
  /** Only label these points. Defaults to the highest-weighted ones. */
  pointIndices?: number[]
  /** Hide labels below this zoom level, where they would crowd. */
  minZoom?: number
  textStyle?: StyleProp<TextStyle>
  containerStyle?: StyleProp<ViewStyle>
  /** Tapping a label selects its point. */
  selectOnPress?: boolean
}

type PlacedLabel = {
  index: number
  text: string
  x: number
  y: number
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

  // Registering the tracked set is what makes the readback small, so it is done
  // when the set changes rather than on every update tick.
  useEffect(() => {
    if (!graph || !isReady) return
    trackedRef.current = candidates
    graph.trackPointsByIndices(candidates.length > 0 ? candidates : undefined)
    return () => graph.trackPointsByIndices(undefined)
  }, [graph, isReady, candidates])

  useEffect(() => {
    if (!graph || !isReady || candidates.length === 0) {
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
        const text = resolved?.pointLabels?.[index]
        if (!position || text === undefined) continue
        const [x, y] = graph.spaceToScreenPosition(position)
        // Off-screen labels are dropped rather than clamped to the edge, where
        // they would pile into an unreadable stack along the border and claim
        // to describe points nobody can see.
        if (x < -80 || y < -40 || x > width + 80 || y > height + 40) continue
        placed.push({ index, text, x, y })
      }

      setLabels(placed)
    }

    update()
    const timer = setInterval(update, updateIntervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [graph, isReady, candidates, resolved, updateIntervalMs, minZoom])

  if (labels.length === 0) return null

  const isInteractive = selectOnPress || onLabelPress !== undefined

  return (
    <View pointerEvents={isInteractive ? 'box-none' : 'none'} style={[StyleSheet.absoluteFill, containerStyle]}>
      {labels.map((label) => (
        <Text
          key={label.index}
          onPress={isInteractive
            ? () => {
              onLabelPress?.(label.index, resolved?.pointIds?.[label.index])
              if (selectOnPress) selectPoints([label.index], { includeNeighbors: true })
            }
            : undefined}
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
      ))}
    </View>
  )
}

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
