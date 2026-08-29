import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, StyleSheet, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { useCosmosGraph } from './CosmosGraph'

export type CosmosClusterLabelsProps = {
  /**
   * Grow a cluster's label with its membership.
   *
   * On by default: a cluster label names a region rather than a point, and
   * sizing it by how much of the graph it covers is what lets the eye read the
   * structure at a glance instead of treating every group as equally important.
   */
  scaleBySize?: boolean
  /** Font size for the smallest cluster. */
  fontSize?: number
  /** Font size for the largest, when `scaleBySize` is on. */
  maxFontSize?: number
  /** Don't label clusters smaller than this. */
  minClusterSize?: number
  /** Cap on how many clusters get labelled, largest first. */
  limit?: number
  /**
   * Take each label's colour from the cluster's point colour.
   *
   * Off by default: a cluster label is text, and text carrying a series colour
   * competes with the points it describes. Worth turning on when clusters are
   * the primary encoding.
   */
  useClusterColor?: boolean
  /** Hide labels below this zoom level. */
  minZoom?: number
  /** How often to reposition, in milliseconds. */
  updateIntervalMs?: number
  /** Tapping a label selects every point in that cluster. */
  selectOnPress?: boolean
  textStyle?: StyleProp<TextStyle>
  containerStyle?: StyleProp<ViewStyle>
}

type PlacedClusterLabel = {
  key: string
  text: string
  x: number
  y: number
  fontSize: number
  color: string | undefined
  members: number[]
}

const DEFAULT_FONT_SIZE = 13
const DEFAULT_MAX_FONT_SIZE = 22
const DEFAULT_LIMIT = 24
/**
 * Slower than point labels: a cluster centroid is an average over many points,
 * so it moves far less than any individual one and re-reading it often buys
 * nothing.
 */
const DEFAULT_INTERVAL = 200

/**
 * Names each cluster at its centroid.
 *
 * Positions come from `getClusterPositions()`, which the engine computes on the
 * GPU as it runs — the centroid is already being summed for the cluster force,
 * so reading it costs one small readback rather than averaging every point's
 * position on the CPU.
 */
export function CosmosClusterLabels ({
  scaleBySize = true,
  fontSize = DEFAULT_FONT_SIZE,
  maxFontSize = DEFAULT_MAX_FONT_SIZE,
  minClusterSize = 1,
  limit = DEFAULT_LIMIT,
  useClusterColor = false,
  minZoom,
  updateIntervalMs = DEFAULT_INTERVAL,
  selectOnPress = true,
  textStyle,
  containerStyle,
}: CosmosClusterLabelsProps): React.ReactElement | null {
  const { graph, resolved, isReady, selectPoints } = useCosmosGraph()
  const [labels, setLabels] = useState<PlacedClusterLabel[]>([])

  /** Members and colour per cluster, keyed by cluster index. */
  const clusters = useMemo(() => {
    const values = resolved?.clusterValues
    const assignment = resolved?.pointClusters
    if (!values || !assignment) return []

    const members: number[][] = values.map(() => [])
    for (let i = 0; i < assignment.length; i++) {
      const cluster = assignment[i]
      if (cluster === undefined) continue
      members[cluster]?.push(i)
    }

    return values
      .map((value, index) => ({
        index,
        value,
        members: members[index] ?? [],
        // The cluster's colour is whatever its first member was painted, which
        // matches only when colour and cluster share a column — the case where
        // colouring the label is worth doing at all.
        color: resolved?.colorEncoding?.categories?.find((c) => c.value === value)?.color,
      }))
      .filter((cluster) => cluster.members.length >= minClusterSize)
      .sort((a, b) => b.members.length - a.members.length)
      .slice(0, limit)
  }, [resolved, minClusterSize, limit])

  useEffect(() => {
    if (!graph || !isReady || clusters.length === 0) {
      setLabels([])
      return
    }

    const largest = clusters[0]?.members.length ?? 1
    let cancelled = false

    const update = (): void => {
      if (cancelled) return
      if (minZoom !== undefined && graph.getZoomLevel() < minZoom) {
        setLabels((current) => (current.length === 0 ? current : []))
        return
      }

      const centroids = graph.getClusterPositions()
      if (centroids.length === 0) {
        setLabels((current) => (current.length === 0 ? current : []))
        return
      }

      const [width, height] = graph.store.screenSize
      const placed: PlacedClusterLabel[] = []

      for (const cluster of clusters) {
        const cx = centroids[cluster.index * 2]
        const cy = centroids[cluster.index * 2 + 1]
        // An empty cluster has no centroid and reads back as the origin, which
        // would park its label in the corner of the space.
        if (cx === undefined || cy === undefined || !Number.isFinite(cx) || !Number.isFinite(cy)) continue
        if (cx === 0 && cy === 0) continue

        const [x, y] = graph.spaceToScreenPosition([cx, cy])
        if (x < -100 || y < -40 || x > width + 100 || y > height + 40) continue

        // Square-root scaling, so a cluster ten times larger reads as roughly
        // three times more prominent rather than ten — the same reason point
        // sizes map by area.
        const share = Math.sqrt(cluster.members.length / largest)
        placed.push({
          key: cluster.value,
          text: cluster.value,
          x,
          y,
          fontSize: scaleBySize ? fontSize + (maxFontSize - fontSize) * share : fontSize,
          color: useClusterColor ? cluster.color : undefined,
          members: cluster.members,
        })
      }

      setLabels(placed)
    }

    update()
    const timer = setInterval(update, updateIntervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [graph, isReady, clusters, minZoom, updateIntervalMs, scaleBySize, fontSize, maxFontSize, useClusterColor])

  if (labels.length === 0) return null

  return (
    <View
      pointerEvents={selectOnPress ? 'box-none' : 'none'}
      style={[StyleSheet.absoluteFill, containerStyle]}
    >
      {labels.map((label) => (
        <Text
          key={label.key}
          onPress={selectOnPress ? () => selectPoints(label.members) : undefined}
          numberOfLines={1}
          style={[
            styles.label,
            { transform: [{ translateX: label.x }, { translateY: label.y }], fontSize: label.fontSize },
            label.color ? { color: label.color } : null,
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
    left: -90,
    top: -12,
    width: 180,
    textAlign: 'center',
    color: '#f2f5f9',
    fontWeight: '700',
    // Wider tracking than point labels: a cluster label names a region, and
    // the extra spacing reads as a heading rather than as another point's name.
    letterSpacing: 0.6,
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
})
