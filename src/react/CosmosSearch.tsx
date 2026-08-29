import React, { useCallback, useMemo, useState } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  StyleSheet,
  Keyboard,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { useCosmosGraph, type CosmosSearchResult } from './CosmosGraph'

export type CosmosSearchProps = {
  placeholder?: string
  /** Maximum results to list. */
  limit?: number
  /** Selecting a result also selects its neighbours. */
  selectNeighbors?: boolean
  /** Zoom to the chosen point. */
  zoomToResult?: boolean
  /** Fires when a result is chosen, before selection and zoom are applied. */
  onSelect?: (result: CosmosSearchResult) => void
  style?: StyleProp<ViewStyle>
}

const DEFAULT_LIMIT = 12

/**
 * Find-a-point search over the label column.
 *
 * The single most useful control on a touch device: a large graph has no
 * addressable structure — you cannot scroll to a node — so without search the
 * only way to reach a known point is to pan and squint.
 */
export function CosmosSearch ({
  placeholder = 'Search points',
  limit = DEFAULT_LIMIT,
  selectNeighbors = true,
  zoomToResult = true,
  onSelect,
  style,
}: CosmosSearchProps): React.ReactElement | null {
  const { graph, resolved, searchPoints, selectPoints, clearSelection } = useCosmosGraph()
  const [query, setQuery] = useState('')

  const results = useMemo(
    () => (query.trim() === '' ? [] : searchPoints(query, limit)),
    [query, limit, searchPoints]
  )

  const choose = useCallback((result: CosmosSearchResult) => {
    onSelect?.(result)
    selectPoints([result.index], { includeNeighbors: selectNeighbors })
    if (zoomToResult && graph) {
      // Fitting to the point and its neighbours rather than the point alone:
      // zooming to a single point fills the screen with its surroundings at an
      // arbitrary scale, and the useful view is the one that shows what it
      // connects to.
      const indices = selectNeighbors
        ? [result.index, ...graph.getNeighboringPointIndices(result.index)]
        : [result.index]
      graph.fitViewByPointIndices(indices, 400, 0.35)
    }
    Keyboard.dismiss()
  }, [onSelect, selectPoints, selectNeighbors, zoomToResult, graph])

  const reset = useCallback(() => {
    setQuery('')
    clearSelection()
  }, [clearSelection])

  // Nothing to search without a label column, and an input that can never
  // return a result is worse than no input.
  if (!resolved?.pointLabels) return null

  return (
    <View style={[styles.container, style]}>
      <View style={styles.inputRow}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={placeholder}
          placeholderTextColor="#71798a"
          style={styles.input}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          onSubmitEditing={() => {
            const first = results[0]
            if (first) choose(first)
          }}
        />
        {query.length > 0 ? (
          <Pressable onPress={reset} hitSlop={10} style={styles.clear}>
            <Text style={styles.clearText}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      {results.length > 0 ? (
        <FlatList
          data={results}
          keyExtractor={(item) => String(item.index)}
          style={styles.results}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Pressable
              onPress={() => choose(item)}
              style={({ pressed }) => [styles.result, pressed && styles.resultPressed]}
            >
              <Text numberOfLines={1} style={styles.resultLabel}>{item.label}</Text>
              {item.id !== undefined && item.id !== item.label ? (
                <Text numberOfLines={1} style={styles.resultId}>{item.id}</Text>
              ) : null}
            </Pressable>
          )}
        />
      ) : query.trim() !== '' ? (
        <Text style={styles.empty}>No matches</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 16,
    left: 16,
    width: 240,
    borderRadius: 10,
    backgroundColor: 'rgba(20, 22, 28, 0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    overflow: 'hidden',
  },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  input: {
    flex: 1,
    color: '#f2f5f9',
    fontSize: 14,
    paddingHorizontal: 12,
    // A comfortable tap target: the input is the primary control and a cramped
    // one is hard to hit while holding the device one-handed.
    paddingVertical: 11,
  },
  clear: { paddingHorizontal: 12 },
  clearText: { color: '#8b95a5', fontSize: 13 },
  results: { maxHeight: 220 },
  result: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
  },
  resultPressed: { backgroundColor: 'rgba(255, 255, 255, 0.07)' },
  resultLabel: { color: '#e3e8ef', fontSize: 13 },
  resultId: { color: '#71798a', fontSize: 11, marginTop: 1 },
  empty: { color: '#71798a', fontSize: 12, paddingHorizontal: 12, paddingVertical: 10 },
})
