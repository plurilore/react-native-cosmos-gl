import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  PanResponder,
  StyleSheet,
  type GestureResponderEvent,
  type PanResponderGestureState,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { useCosmosGraph } from './CosmosGraph'

export type CosmosHistogramProps = {
  /** Numeric column to bin. */
  column: string
  /** Number of bins. */
  bins?: number
  title?: string
  /** Formats an axis value. Defaults to a compact number. */
  formatValue?: (value: number) => string
  /** Selecting a range selects the points inside it. */
  filterOnBrush?: boolean
  /** Fires when the brushed range changes; `undefined` when cleared. */
  onRangeChange?: (range: [number, number] | undefined) => void
  /** Bar height in points. */
  height?: number
  style?: StyleProp<ViewStyle>
}

const DEFAULT_BINS = 28
const DEFAULT_HEIGHT = 64
/** Gap between bars, so adjacent bars read as separate marks. */
const BAR_GAP = 2
/** Minimum drag before a touch counts as a brush rather than a tap. */
const BRUSH_SLOP = 6

/**
 * A distribution of one column, with drag-to-filter.
 *
 * The brush is the point of it. A histogram alone tells you the shape of a
 * column; dragging across it answers "which points are those?" — which is the
 * question a graph is there to make answerable.
 */
export function CosmosHistogram ({
  column,
  bins = DEFAULT_BINS,
  title,
  formatValue = formatCompact,
  filterOnBrush = true,
  onRangeChange,
  height = DEFAULT_HEIGHT,
  style,
}: CosmosHistogramProps): React.ReactElement | null {
  const { resolved, selectPoints, clearSelection } = useCosmosGraph()
  const [width, setWidth] = useState(0)
  const [range, setRange] = useState<[number, number] | undefined>(undefined)

  const histogram = useMemo(
    () => resolved?.pointFrame.histogram(column, bins),
    [resolved, column, bins]
  )

  const maxCount = useMemo(() => {
    if (!histogram) return 0
    let max = 0
    for (const count of histogram.counts) if (count > max) max = count
    return max
  }, [histogram])

  /** Applies a brushed range as a point selection. */
  const applyRange = useCallback((next: [number, number] | undefined) => {
    setRange(next)
    onRangeChange?.(next)
    if (!filterOnBrush || !resolved) return

    if (!next) {
      clearSelection()
      return
    }
    const values = resolved.pointFrame.numeric(column)
    const indices: number[] = []
    for (let i = 0; i < values.length; i++) {
      const value = values[i] as number
      if (!Number.isFinite(value)) continue
      if (value >= next[0] && value <= next[1]) indices.push(i)
    }
    // Links between selected points stay highlighted, so a range brush shows
    // the subgraph the filter induces rather than a scatter of isolated points.
    selectPoints(indices)
  }, [filterOnBrush, resolved, column, onRangeChange, selectPoints, clearSelection])

  const dragRef = useRef<{ startX: number; moved: boolean }>({ startX: 0, moved: false })

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event: GestureResponderEvent) => {
      dragRef.current = { startX: event.nativeEvent.locationX, moved: false }
    },
    onPanResponderMove: (event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      if (!histogram || width === 0) return
      if (Math.abs(gesture.dx) < BRUSH_SLOP) return
      dragRef.current.moved = true
      const from = dragRef.current.startX
      const to = event.nativeEvent.locationX
      applyRange(toValueRange(histogram.edges, width, Math.min(from, to), Math.max(from, to)))
    },
    onPanResponderRelease: () => {
      // A tap without a drag clears, which is the obvious way back out of a
      // filter you did not mean to make.
      if (!dragRef.current.moved) applyRange(undefined)
    },
  }), [histogram, width, applyRange])

  useEffect(() => {
    // A column change invalidates the range: the same numbers mean something
    // different, and silently keeping the filter would hide points for reasons
    // nothing on screen explains.
    setRange(undefined)
  }, [column])

  if (!resolved || !histogram || maxCount === 0) return null

  const [domainMin, domainMax] = [histogram.edges[0] as number, histogram.edges[histogram.edges.length - 1] as number]
  const barWidth = width > 0 ? Math.max(1, width / histogram.counts.length - BAR_GAP) : 0

  return (
    <View style={[styles.container, style]}>
      <View style={styles.header}>
        {title ? <Text style={styles.title}>{title}</Text> : <Text style={styles.title}>{column}</Text>}
        {range ? (
          <Pressable onPress={() => applyRange(undefined)} hitSlop={8}>
            <Text style={styles.rangeLabel}>
              {`${formatValue(range[0])} – ${formatValue(range[1])}  ✕`}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View
        style={[styles.plot, { height }]}
        onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
        {...panResponder.panHandlers}
      >
        {width > 0 && Array.from(histogram.counts).map((count, index) => {
          const low = histogram.edges[index] as number
          const high = histogram.edges[index + 1] as number
          const isInRange = !range || (high >= range[0] && low <= range[1])
          // Bars are anchored to the baseline and read as magnitude, so the
          // height is proportional to the count with no floor — an empty bin
          // must look empty rather than like a small one.
          const barHeight = (count / maxCount) * height
          return (
            <View
              key={index}
              style={[
                styles.bar,
                {
                  width: barWidth,
                  height: barHeight,
                  marginRight: BAR_GAP,
                  opacity: isInRange ? 1 : 0.28,
                },
              ]}
            />
          )
        })}
      </View>

      <View style={styles.axis}>
        <Text style={styles.axisLabel}>{formatValue(domainMin)}</Text>
        <Text style={styles.axisLabel}>{formatValue(domainMax)}</Text>
      </View>
    </View>
  )
}

/** Maps a pixel span on the plot back to a value range. */
function toValueRange (
  edges: Float64Array,
  width: number,
  fromX: number,
  toX: number
): [number, number] {
  const min = edges[0] as number
  const max = edges[edges.length - 1] as number
  const clamp = (x: number): number => Math.min(Math.max(x / width, 0), 1)
  return [min + (max - min) * clamp(fromX), min + (max - min) * clamp(toX)]
}

function formatCompact (value: number): string {
  if (!Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(1)
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 16,
    padding: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(20, 22, 28, 0.9)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  title: { color: '#c7d0dc', fontSize: 11, fontWeight: '600', letterSpacing: 0.3 },
  rangeLabel: { color: '#66c2f5', fontSize: 11, fontVariant: ['tabular-nums'] },
  plot: { flexDirection: 'row', alignItems: 'flex-end' },
  bar: {
    backgroundColor: '#3987e5',
    // Rounded only at the data end, with the baseline left square, so the bar
    // reads as growing from the axis rather than floating.
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  axisLabel: { color: '#71798a', fontSize: 10, fontVariant: ['tabular-nums'] },
})
