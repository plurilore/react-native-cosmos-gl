import React, { useCallback, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
} from 'react-native'
import { CosmosGraph, type CosmosGraphRef } from 'react-native-cosmos-gl'

import { DATASETS, type GraphDataset } from './data'

const BACKGROUND = '#111318'

export default function TypedArraysScreen (): React.ReactElement {
  const graphRef = useRef<CosmosGraphRef>(null)
  const [datasetIndex, setDatasetIndex] = useState(0)
  const [selected, setSelected] = useState<number | undefined>(undefined)
  const [isSettling, setIsSettling] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)

  // Datasets are built lazily and memoized on the index: the 50k-point cloud
  // takes a moment to generate, and regenerating it on every render would make
  // the UI feel broken.
  const dataset: GraphDataset = useMemo(() => (DATASETS[datasetIndex] ?? DATASETS[0]!)(), [datasetIndex])

  const onPointClick = useCallback((index: number) => {
    setSelected((current) => (current === index ? undefined : index))
  }, [])

  const onBackgroundClick = useCallback(() => setSelected(undefined), [])

  const onSimulationEnd = useCallback(() => setIsSettling(false), [])
  const onSimulationStart = useCallback(() => setIsSettling(true), [])

  // Selecting a point highlights it and its neighbours, greying out the rest —
  // the interaction that makes a dense graph readable on a small screen.
  const highlightedPointIndices = useMemo(() => {
    if (selected === undefined) return undefined
    const graph = graphRef.current?.getGraph()
    if (!graph) return [selected]
    return [selected, ...graph.getNeighboringPointIndices(selected)]
  }, [selected])

  if (error) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.errorBox}>
          <Text style={styles.errorTitle}>Could not start the graph</Text>
          <Text style={styles.errorBody}>{error}</Text>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <View style={styles.root}>
      <CosmosGraph
        ref={graphRef}
        style={styles.graph}
        pointPositions={dataset.pointPositions}
        links={dataset.links.length > 0 ? dataset.links : undefined}
        pointColors={dataset.pointColors}
        pointSizes={dataset.pointSizes}
        highlightedPointIndices={highlightedPointIndices}
        backgroundColor={BACKGROUND}
        simulationRepulsion={1.2}
        simulationGravity={0.15}
        simulationLinkDistance={12}
        simulationFriction={0.85}
        linkWidthScale={0.6}
        linkOpacity={0.55}
        curvedLinks
        enableDrag
        fitViewOnInit
        fitViewPadding={0.15}
        onPointClick={onPointClick}
        onBackgroundClick={onBackgroundClick}
        onSimulationStart={onSimulationStart}
        onSimulationEnd={onSimulationEnd}
        onError={(e) => setError(e.message)}
      />

      <SafeAreaView pointerEvents="box-none" style={styles.overlay}>
        <View style={styles.header} pointerEvents="none">
          <Text style={styles.title}>{dataset.name}</Text>
          <Text style={styles.subtitle}>{dataset.description}</Text>
          {selected !== undefined && (
            <Text style={styles.selection}>
              Point {selected} · {highlightedPointIndices ? highlightedPointIndices.length - 1 : 0} neighbours
            </Text>
          )}
        </View>

        <View style={styles.footer}>
          {isSettling && (
            <View style={styles.settling} pointerEvents="none">
              <ActivityIndicator size="small" color="#9aa4b2" />
              <Text style={styles.settlingText}>settling</Text>
            </View>
          )}

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {DATASETS.map((factory, index) => (
              <Chip
                key={index}
                label={index === datasetIndex ? dataset.name : labelFor(index)}
                isActive={index === datasetIndex}
                onPress={() => {
                  setSelected(undefined)
                  setDatasetIndex(index)
                }}
              />
            ))}
          </ScrollView>

          <View style={styles.actions}>
            <Chip label="Fit" onPress={() => graphRef.current?.fitView()} />
            <Chip label="Restart" onPress={() => graphRef.current?.start(1)} />
            <Chip label="Pause" onPress={() => graphRef.current?.pause()} />
          </View>
        </View>
      </SafeAreaView>
    </View>
  )
}

function labelFor (index: number): string {
  return ['Small', 'Large', 'Mesh', 'Cloud'][index] ?? `Set ${index + 1}`
}

function Chip ({
  label,
  isActive,
  onPress,
}: {
  label: string
  isActive?: boolean
  onPress: () => void
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        isActive && styles.chipActive,
        pressed && styles.chipPressed,
      ]}
    >
      <Text style={[styles.chipText, isActive && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BACKGROUND },
  graph: StyleSheet.absoluteFill,
  overlay: { flex: 1, justifyContent: 'space-between' },
  header: { paddingHorizontal: 20, paddingTop: 52 },
  title: { color: '#f2f5f9', fontSize: 22, fontWeight: '600', letterSpacing: -0.3 },
  subtitle: { color: '#8b95a5', fontSize: 13, marginTop: 2 },
  selection: { color: '#66c2f5', fontSize: 13, marginTop: 6, fontVariant: ['tabular-nums'] },
  footer: { paddingBottom: 16, gap: 10 },
  settling: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20 },
  settlingText: { color: '#9aa4b2', fontSize: 12 },
  chips: { paddingHorizontal: 20, gap: 8 },
  actions: { flexDirection: 'row', paddingHorizontal: 20, gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  chipActive: { backgroundColor: 'rgba(102,194,245,0.18)', borderColor: 'rgba(102,194,245,0.5)' },
  chipPressed: { opacity: 0.6 },
  chipText: { color: '#c7d0dc', fontSize: 13, fontWeight: '500' },
  chipTextActive: { color: '#9ad8fb' },
  errorBox: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, gap: 8 },
  errorTitle: { color: '#f2f5f9', fontSize: 18, fontWeight: '600' },
  errorBody: { color: '#8b95a5', fontSize: 14, lineHeight: 20 },
})
