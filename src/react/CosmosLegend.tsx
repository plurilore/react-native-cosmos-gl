import React, { useMemo } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import { useCosmosGraph } from './CosmosGraph'
import { CATEGORICAL_ALL_PAIRS_SAFE_LIMIT } from '../data/palettes'

export type CosmosLegendProps = {
  /** Which encoding to describe. Defaults to point color. */
  channel?: 'pointColor' | 'linkColor'
  title?: string
  /** Tapping an entry selects every point in that category. */
  selectOnPress?: boolean
  /** Categories to list before collapsing the rest into an overflow row. */
  maxEntries?: number
  style?: StyleProp<ViewStyle>
}

const DEFAULT_MAX_ENTRIES = 8

/**
 * Describes what the colors mean.
 *
 * Not decoration: with two or more categories on screen, a legend is what keeps
 * identity from being carried by color alone. It matters more here than in a
 * chart, because a graph has no axis to fall back on — an unlabelled color is
 * simply unreadable.
 */
export function CosmosLegend ({
  channel = 'pointColor',
  title,
  selectOnPress = true,
  maxEntries = DEFAULT_MAX_ENTRIES,
  style,
}: CosmosLegendProps): React.ReactElement | null {
  const { resolved, selectPoints } = useCosmosGraph()
  const encoding = channel === 'pointColor' ? resolved?.colorEncoding : resolved?.linkColorEncoding

  /** Point indices per category, so a tap can select the whole group. */
  const membersByCategory = useMemo(() => {
    const members = new Map<string, number[]>()
    if (channel !== 'pointColor' || !encoding?.categories || !resolved) return members
    // Reverse-engineering the column from the encoding would be fragile, so the
    // legend re-reads the frame it was built from.
    const column = findCategoricalColumn(resolved, encoding.categories.map((c) => c.value))
    if (!column) return members
    const values = resolved.pointFrame.strings(column)
    for (let i = 0; i < values.length; i++) {
      const value = values[i]
      if (value === undefined) continue
      const list = members.get(value)
      if (list) list.push(i)
      else members.set(value, [i])
    }
    return members
  }, [channel, encoding, resolved])

  if (!encoding) return null

  if (encoding.categories && encoding.categories.length > 0) {
    const entries = encoding.categories.slice(0, maxEntries)
    const overflow = encoding.categories.length - entries.length
    // Past the all-pairs safe limit, colors stop being reliably distinguishable
    // from each other. Saying so beats letting someone trust a distinction the
    // palette cannot actually make.
    const isBeyondSafeLimit = encoding.categories.length > CATEGORICAL_ALL_PAIRS_SAFE_LIMIT

    return (
      <View style={[styles.container, style]}>
        {title ? <Text style={styles.title}>{title}</Text> : null}
        <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
          {entries.map((entry) => {
            const members = membersByCategory.get(entry.value)
            const isPressable = selectOnPress && members !== undefined && members.length > 0
            return (
              <Pressable
                key={entry.value}
                disabled={!isPressable}
                onPress={isPressable ? () => selectPoints(members) : undefined}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <View style={[styles.swatch, { backgroundColor: entry.color }]} />
                <Text numberOfLines={1} style={styles.label}>{entry.value}</Text>
                {members ? <Text style={styles.count}>{members.length}</Text> : null}
              </Pressable>
            )
          })}
          {overflow > 0 ? (
            <View style={styles.row}>
              <View style={[styles.swatch, styles.swatchOther]} />
              <Text style={styles.label}>{`+${overflow} more`}</Text>
            </View>
          ) : null}
        </ScrollView>
        {isBeyondSafeLimit ? (
          <Text style={styles.note}>Set pointShapeBy to tell these apart reliably</Text>
        ) : null}
      </View>
    )
  }

  if (encoding.domain && encoding.palette) {
    const [min, max] = encoding.domain
    return (
      <View style={[styles.container, style]}>
        {title ? <Text style={styles.title}>{title}</Text> : null}
        <View style={styles.ramp}>
          {encoding.palette.map((color, index) => (
            <View key={index} style={[styles.rampStep, { backgroundColor: color }]} />
          ))}
        </View>
        <View style={styles.rampLabels}>
          <Text style={styles.rampLabel}>{formatNumber(min)}</Text>
          <Text style={styles.rampLabel}>{formatNumber(max)}</Text>
        </View>
      </View>
    )
  }

  return null
}

/**
 * Finds the column whose distinct values match the encoded categories.
 *
 * The encoding records the categories but not which column produced them, and
 * threading the column name through every layer to serve one component is worse
 * than matching it back here — where a miss simply means the legend is not
 * tappable.
 */
function findCategoricalColumn (
  resolved: { pointFrame: { columns: readonly string[]; categories: (c: string) => string[] } },
  values: string[]
): string | undefined {
  const wanted = new Set(values)
  for (const column of resolved.pointFrame.columns) {
    const categories = resolved.pointFrame.categories(column)
    if (categories.length !== wanted.size) continue
    if (categories.every((value) => wanted.has(value))) return column
  }
  return undefined
}

function formatNumber (value: number): string {
  if (!Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 16,
    right: 16,
    maxWidth: 190,
    padding: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(20, 22, 28, 0.86)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  title: { color: '#c7d0dc', fontSize: 11, fontWeight: '600', marginBottom: 6, letterSpacing: 0.3 },
  list: { maxHeight: 200 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3, gap: 8 },
  rowPressed: { opacity: 0.55 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  swatchOther: { backgroundColor: 'rgba(140, 145, 155, 0.55)' },
  // Text stays in an ink color rather than taking the series color: the swatch
  // beside it already carries the identity, and colored text reads as emphasis.
  label: { color: '#e3e8ef', fontSize: 12, flexShrink: 1 },
  count: { color: '#8b95a5', fontSize: 11, marginLeft: 'auto', fontVariant: ['tabular-nums'] },
  note: { color: '#8b95a5', fontSize: 10, marginTop: 6, lineHeight: 13 },
  ramp: { flexDirection: 'row', height: 10, borderRadius: 3, overflow: 'hidden' },
  rampStep: { flex: 1 },
  rampLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  rampLabel: { color: '#8b95a5', fontSize: 10, fontVariant: ['tabular-nums'] },
})
