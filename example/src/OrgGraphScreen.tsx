import React, { useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, StyleSheet, SafeAreaView } from 'react-native'
import {
  CosmosGraph,
  CosmosLabels,
  CosmosClusterLabels,
  CosmosLegend,
  CosmosSearch,
  CosmosHistogram,
  CosmosTimeline,
  type CosmosGraphRef,
} from 'react-native-cosmos-gl'

import { makeOrgGraph } from './records'

const BACKGROUND = '#1a1a19'

type Panel = 'none' | 'commits' | 'timeline'

/**
 * The column-mapping path: records in, with labels, legend, search and
 * filtering on top.
 *
 * Everything on screen is driven by column names — nothing here builds a typed
 * array by hand.
 */
export default function OrgGraphScreen (): React.ReactElement {
  const graphRef = useRef<CosmosGraphRef>(null)
  const [panel, setPanel] = useState<Panel>('commits')
  const [selectionCount, setSelectionCount] = useState(0)
  const [lastLink, setLastLink] = useState<number | undefined>(undefined)

  const { people, edges } = useMemo(() => makeOrgGraph(400), [])

  return (
    <View style={styles.root}>
      <CosmosGraph
        ref={graphRef}
        style={styles.graph}
        pointData={people}
        linkData={edges}
        pointIdBy="id"
        linkSourceBy="from"
        linkTargetBy="to"
        // Colour and shape on the same column: six teams is past the point
        // where colour alone stays reliably distinguishable, so shape carries
        // the identity colour cannot.
        pointColorBy="team"
        pointShapeBy="team"
        pointSizeBy="commits"
        pointSizeRange={[3, 14]}
        pointLabelBy="name"
        pointClusterBy="team"
        linkWidthBy="reviews"
        linkWidthRange={[0.4, 3]}
        linkColorBy="kind"
        backgroundColor={BACKGROUND}
        simulationRepulsion={0.9}
        simulationGravity={0.2}
        simulationCluster={0.35}
        simulationLinkDistance={14}
        linkOpacity={0.4}
        curvedLinks
        enableDrag
        fitViewOnInit
        selectPointOnClick
        selectNeighborsOnClick
        renderHoveredPointRing
        onSelectionChange={(indices) => setSelectionCount(indices?.length ?? 0)}
        onLinkClick={(linkIndex) => setLastLink(linkIndex)}
      >
        <CosmosSearch placeholder="Find a person" />
        <CosmosLegend title="Team" />
        <CosmosClusterLabels minClusterSize={8} />
        <CosmosLabels limit={40} minZoom={1.5} selectOnPress />

        {panel === 'commits' ? (
          <CosmosHistogram column="commits" title="Commits" bins={30} />
        ) : null}
        {panel === 'timeline' ? (
          <CosmosTimeline column="joined" title="Joined" />
        ) : null}
      </CosmosGraph>

      <SafeAreaView pointerEvents="box-none" style={styles.overlay}>
        <View style={styles.footer}>
          {selectionCount > 0 ? (
            <Text style={styles.selection}>{`${selectionCount} selected`}</Text>
          ) : null}
          {lastLink !== undefined ? (
            <Text style={styles.selection}>{`link ${lastLink} tapped`}</Text>
          ) : null}
          <View style={styles.tabs}>
            <Tab label="Commits" isActive={panel === 'commits'} onPress={() => setPanel('commits')} />
            <Tab label="Timeline" isActive={panel === 'timeline'} onPress={() => setPanel('timeline')} />
            <Tab label="None" isActive={panel === 'none'} onPress={() => setPanel('none')} />
            <Tab label="Fit" onPress={() => graphRef.current?.fitView()} />
          </View>
        </View>
      </SafeAreaView>
    </View>
  )
}

function Tab ({
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
      style={({ pressed }) => [styles.tab, isActive && styles.tabActive, pressed && styles.tabPressed]}
    >
      <Text style={[styles.tabText, isActive && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BACKGROUND },
  graph: { ...StyleSheet.absoluteFillObject },
  overlay: { flex: 1, justifyContent: 'flex-end' },
  // Sits above the histogram, which anchors itself to the bottom of the graph.
  footer: { paddingBottom: 8, gap: 8, marginBottom: 120 },
  selection: { color: '#66c2f5', fontSize: 12, paddingHorizontal: 20, fontVariant: ['tabular-nums'] },
  tabs: { flexDirection: 'row', paddingHorizontal: 20, gap: 8 },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  tabActive: { backgroundColor: 'rgba(57,135,229,0.2)', borderColor: 'rgba(57,135,229,0.5)' },
  tabPressed: { opacity: 0.6 },
  tabText: { color: '#c7d0dc', fontSize: 13, fontWeight: '500' },
  tabTextActive: { color: '#9ad8fb' },
})
