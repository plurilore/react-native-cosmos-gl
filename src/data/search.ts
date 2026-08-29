import type { ResolvedGraphData } from './resolve'

/** A search hit. */
export type SearchResult = {
  index: number
  id: string | undefined
  label: string
}

/**
 * Ranked substring search over the resolved label column.
 *
 * Ranking matters more than it looks. A query like "a" matches most of a real
 * dataset, and returning the first N in row order would surface arbitrary
 * points — the feature would appear to work while being useless. So matches are
 * tiered by *where* they hit (a prefix is a stronger signal than a substring
 * buried mid-word), and within a tier the label weight — degree by default —
 * breaks the tie, so the most connected match wins. Shorter labels break
 * remaining ties, since a query is a larger fraction of a short label.
 */
export function searchPoints (
  resolved: ResolvedGraphData | undefined,
  query: string,
  limit = 20
): SearchResult[] {
  const labels = resolved?.pointLabels
  if (!resolved || !labels) return []
  const needle = query.trim().toLowerCase()
  if (needle === '') return []

  const weights = resolved.pointLabelWeights
  const scored: { index: number; label: string; tier: number; weight: number }[] = []

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]
    if (label === undefined) continue
    const haystack = label.toLowerCase()
    const at = haystack.indexOf(needle)
    if (at < 0) continue
    const isPrefix = at === 0
    const isWordStart = at > 0 && /[\s\-_/,.]/.test(haystack.charAt(at - 1))
    scored.push({
      index: i,
      label,
      tier: isPrefix ? 0 : isWordStart ? 1 : 2,
      weight: weights[i] ?? 0,
    })
  }

  scored.sort((a, b) => (a.tier - b.tier) || (b.weight - a.weight) || (a.label.length - b.label.length))

  return scored.slice(0, limit).map((hit) => ({
    index: hit.index,
    id: resolved.pointIds?.[hit.index],
    label: hit.label,
  }))
}
