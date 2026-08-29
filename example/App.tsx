import React, { useState } from 'react'
import { View, Text, Pressable, StyleSheet, SafeAreaView, StatusBar } from 'react-native'

import TypedArraysScreen from './src/TypedArraysScreen'
import OrgGraphScreen from './src/OrgGraphScreen'
import DeviceCheckScreen from './src/DeviceCheckScreen'

/**
 * Two ways to feed the same component.
 *
 * "Records" maps columns of plain objects onto the graph's channels; "Arrays"
 * hands the engine typed arrays directly. Both render through the same
 * `<CosmosGraph />` — the difference is only in what you give it.
 */
export default function App (): React.ReactElement {
  const [screen, setScreen] = useState<'records' | 'arrays' | 'device'>('records')

  return (
    <View style={styles.root}>
      {/* React Native's own StatusBar, so the example typechecks and runs
          without pulling in expo-status-bar. */}
      <StatusBar barStyle="light-content" />
      {screen === 'records' ? <OrgGraphScreen />
        : screen === 'arrays' ? <TypedArraysScreen />
          : <DeviceCheckScreen />}

      <SafeAreaView pointerEvents="box-none" style={styles.switcher}>
        <View style={styles.pill}>
          <Segment label="Records" isActive={screen === 'records'} onPress={() => setScreen('records')} />
          <Segment label="Arrays" isActive={screen === 'arrays'} onPress={() => setScreen('arrays')} />
          <Segment label="Device" isActive={screen === 'device'} onPress={() => setScreen('device')} />
        </View>
      </SafeAreaView>
    </View>
  )
}

function Segment ({
  label,
  isActive,
  onPress,
}: {
  label: string
  isActive: boolean
  onPress: () => void
}): React.ReactElement {
  return (
    <Pressable onPress={onPress} style={[styles.segment, isActive && styles.segmentActive]}>
      <Text style={[styles.segmentText, isActive && styles.segmentTextActive]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#1a1a19' },
  // Top-centre, clear of the search box on the left and the legend on the right.
  switcher: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center' },
  pill: {
    flexDirection: 'row',
    marginTop: 10,
    padding: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(20, 22, 28, 0.9)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  segment: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 999 },
  segmentActive: { backgroundColor: 'rgba(57,135,229,0.25)' },
  segmentText: { color: '#8b95a5', fontSize: 12, fontWeight: '600' },
  segmentTextActive: { color: '#9ad8fb' },
})
