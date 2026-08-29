import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import { useCosmosGraph } from './CosmosGraph'
import { CosmosHistogram } from './CosmosHistogram'

export type CosmosTimelineProps = {
  /** Column holding a timestamp — a `Date`, epoch milliseconds, or a parseable string. */
  column: string
  /** Number of bins across the span. */
  bins?: number
  title?: string
  /** Show the play control that sweeps a window through time. */
  showPlayback?: boolean
  /**
   * Fraction of the total span the playing window covers.
   *
   * A window rather than a growing range: accumulating everything from the
   * start makes the last frame identical to no filter at all, which shows
   * change poorly. A fixed window moving through time shows what was happening
   * *then*.
   */
  windowFraction?: number
  /** Seconds for one full sweep. */
  playDurationSeconds?: number
  /** Fires when the visible range changes; `undefined` when cleared. */
  onRangeChange?: (range: [number, number] | undefined) => void
  height?: number
  style?: StyleProp<ViewStyle>
}

const DEFAULT_BINS = 40
const DEFAULT_WINDOW_FRACTION = 0.15
const DEFAULT_PLAY_SECONDS = 12
/** Playback advances at this rate — smooth enough to read, cheap enough to run. */
const PLAYBACK_FPS = 12

/**
 * A distribution over time, with a range brush and optional playback.
 *
 * Structurally a histogram over a temporal column — the difference is entirely
 * in presentation and in what the axis means, so it composes the histogram
 * rather than duplicating its binning and brushing.
 */
export function CosmosTimeline ({
  column,
  bins = DEFAULT_BINS,
  title,
  showPlayback = true,
  windowFraction = DEFAULT_WINDOW_FRACTION,
  playDurationSeconds = DEFAULT_PLAY_SECONDS,
  onRangeChange,
  height,
  style,
}: CosmosTimelineProps): React.ReactElement | null {
  const { resolved, selectPoints, clearSelection } = useCosmosGraph()
  const [isPlaying, setIsPlaying] = useState(false)
  const [playRange, setPlayRange] = useState<[number, number] | undefined>(undefined)
  const progressRef = useRef(0)

  const extent = useMemo(() => resolved?.pointFrame.extent(column), [resolved, column])

  /** Formats a timestamp at a resolution the span actually warrants. */
  const formatValue = useMemo(() => {
    if (!extent) return (value: number): string => String(value)
    const spanMs = extent[1] - extent[0]
    const day = 86_400_000
    return (value: number): string => {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      // Showing a time of day across a decade, or a year across an hour, is
      // noise; the span decides which fields are informative.
      if (spanMs > day * 365 * 2) return String(date.getUTCFullYear())
      if (spanMs > day * 60) return date.toISOString().slice(0, 7)
      if (spanMs > day * 2) return date.toISOString().slice(0, 10)
      return date.toISOString().slice(11, 16)
    }
  }, [extent])

  const applyPlayRange = useCallback((range: [number, number] | undefined) => {
    setPlayRange(range)
    onRangeChange?.(range)
    if (!resolved) return
    if (!range) {
      clearSelection()
      return
    }
    const values = resolved.pointFrame.numeric(column)
    const indices: number[] = []
    for (let i = 0; i < values.length; i++) {
      const value = values[i] as number
      if (!Number.isFinite(value)) continue
      if (value >= range[0] && value <= range[1]) indices.push(i)
    }
    selectPoints(indices)
  }, [resolved, column, onRangeChange, selectPoints, clearSelection])

  useEffect(() => {
    if (!isPlaying || !extent) return
    const [min, max] = extent
    const span = max - min
    const windowSpan = Math.max(span * windowFraction, 1)
    const stepsPerSweep = Math.max(1, playDurationSeconds * PLAYBACK_FPS)

    const timer = setInterval(() => {
      progressRef.current += 1 / stepsPerSweep
      // Looping rather than stopping at the end: a timeline is usually watched
      // more than once, and having to reset it before each replay is friction
      // for no benefit.
      if (progressRef.current > 1) progressRef.current = 0
      const start = min + (span - windowSpan) * progressRef.current
      applyPlayRange([start, start + windowSpan])
    }, 1000 / PLAYBACK_FPS)

    return () => clearInterval(timer)
  }, [isPlaying, extent, windowFraction, playDurationSeconds, applyPlayRange])

  const togglePlayback = useCallback(() => {
    setIsPlaying((playing) => {
      if (playing) {
        // Stopping leaves the window where it is rather than clearing, so you
        // can pause on something interesting and then inspect it.
        return false
      }
      progressRef.current = 0
      return true
    })
  }, [])

  const reset = useCallback(() => {
    setIsPlaying(false)
    progressRef.current = 0
    applyPlayRange(undefined)
  }, [applyPlayRange])

  if (!resolved || !extent) return null

  return (
    <View style={[styles.container, style]}>
      <View style={styles.controls} pointerEvents="box-none">
        <Text style={styles.title}>{title ?? column}</Text>
        {showPlayback ? (
          <View style={styles.buttons}>
            {playRange ? (
              <Pressable onPress={reset} hitSlop={8} style={styles.button}>
                <Text style={styles.buttonText}>Reset</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={togglePlayback} hitSlop={8} style={[styles.button, styles.buttonPrimary]}>
              <Text style={styles.buttonText}>{isPlaying ? 'Pause' : 'Play'}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {/* Playback and the brush drive the same selection, so the histogram is
          told not to filter while playing — otherwise the two would fight over
          it and the last writer would win at random. */}
      <CosmosHistogram
        column={column}
        bins={bins}
        formatValue={formatValue}
        filterOnBrush={!isPlaying}
        height={height}
        onRangeChange={isPlaying ? undefined : onRangeChange}
        style={styles.histogram}
      />

      {playRange ? (
        <Text style={styles.window}>
          {`${formatValue(playRange[0])} – ${formatValue(playRange[1])}`}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  controls: {
    position: 'absolute',
    bottom: 104,
    left: 28,
    right: 28,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 2,
  },
  title: { color: '#c7d0dc', fontSize: 11, fontWeight: '600', letterSpacing: 0.3 },
  buttons: { flexDirection: 'row', gap: 8 },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.14)',
  },
  buttonPrimary: { backgroundColor: 'rgba(57, 135, 229, 0.22)', borderColor: 'rgba(57, 135, 229, 0.5)' },
  buttonText: { color: '#e3e8ef', fontSize: 12, fontWeight: '500' },
  histogram: { position: 'relative', left: 16, right: 16, bottom: 16 },
  window: {
    position: 'absolute',
    bottom: 4,
    alignSelf: 'center',
    color: '#66c2f5',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
})
