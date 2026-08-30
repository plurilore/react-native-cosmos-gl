import type { LabelCandidate, LabelPolicy } from './types'

/** What the manager needs to know about the graph to pick candidates. */
export type LabelSource = {
  /** Text per point index. `undefined` means the point has no label. */
  text: (index: number) => string | undefined
  /** Weight column value per point index. */
  weight: (index: number) => number | undefined
  /** Simulation-space position per point index, if known this frame. */
  position: (index: number) => [number, number] | undefined
  /** Point indices ordered by weight, highest first. */
  rankedByWeight: readonly number[]
  /** Point indices sampled from the viewport grid. */
  sampled: readonly number[]
  /** Currently selected point indices. */
  selected: readonly number[]
  focused?: number
  clusters?: readonly { index: number; name: string; count: number; position: [number, number] }[]
  custom?: readonly LabelCandidate[]
}

const DEFAULTS = {
  topLabelsLimit: 120,
  dynamicLabelsLimit: 120,
  selectedLabelsLimit: 140,
  clusterLabelsLimit: 120,
}

/**
 * Which labels exist this frame.
 *
 * The rule that shapes everything else: **cluster labels and point labels are
 * alternatives, not layers.** With nothing selected the clusters name the
 * regions; the moment anything is selected they give way to the points, because
 * the reader has stopped asking "what is this map" and started asking "what is
 * this node". Hovering counts as selecting, which is why the two swap under the
 * finger.
 *
 * Forced and custom labels are the exception and survive both modes — a host
 * that asked for a specific label by name meant it.
 */
export function collectCandidates (
  source: LabelSource,
  policy: LabelPolicy,
  hasSelection: boolean
): LabelCandidate[] {
  const candidates: LabelCandidate[] = []
  const taken = new Set<number>()
  const forced = new Set(policy.showLabelsFor ?? [])
  const clusterMode = Boolean(policy.showClusterLabels) && !hasSelection

  const pointCandidate = (
    index: number,
    kind: LabelCandidate['kind']
  ): LabelCandidate | undefined => {
    if (taken.has(index)) return undefined
    const text = source.text(index)
    const position = source.position(index)
    if (text === undefined || text === '' || !position) return undefined
    taken.add(index)
    return { id: `point-${index}`, kind, index, text, position, weight: source.weight(index) }
  }

  // Forced labels first, so they claim their index before any other class can.
  for (const index of forced) {
    const candidate = pointCandidate(index, 'forced')
    if (candidate) candidates.push(candidate)
  }

  if (policy.showFocusedLabel !== false && source.focused !== undefined) {
    const candidate = pointCandidate(source.focused, 'focused')
    if (candidate) candidates.push(candidate)
  }

  if (!clusterMode) {
    if (policy.showSelectedLabels !== false && hasSelection) {
      const limit = policy.selectedLabelsLimit ?? DEFAULTS.selectedLabelsLimit
      for (const index of source.selected.slice(0, limit)) {
        const candidate = pointCandidate(index, 'selected')
        if (candidate) candidates.push(candidate)
      }
    }

    if (policy.showTopLabels !== false) {
      const limit = policy.topLabelsLimit ?? DEFAULTS.topLabelsLimit
      let used = 0
      for (const index of source.rankedByWeight) {
        if (used >= limit) break
        const candidate = pointCandidate(index, 'top')
        if (candidate) {
          candidates.push(candidate)
          used++
        }
      }
    }

    if (policy.showDynamicLabels !== false) {
      const limit = policy.dynamicLabelsLimit ?? DEFAULTS.dynamicLabelsLimit
      let used = 0
      for (const index of source.sampled) {
        if (used >= limit) break
        const candidate = pointCandidate(index, 'dynamic')
        if (candidate) {
          candidates.push(candidate)
          used++
        }
      }
    }
  }

  if (policy.showClusterLabels && !hasSelection) {
    const limit = policy.clusterLabelsLimit ?? DEFAULTS.clusterLabelsLimit
    for (const cluster of (source.clusters ?? []).slice(0, limit)) {
      candidates.push({
        id: `cluster-${cluster.index}`,
        kind: 'cluster',
        index: cluster.index,
        text: cluster.name,
        position: cluster.position,
        count: cluster.count,
      })
    }
  }

  // Custom labels are the host's own and belong to neither mode.
  for (const candidate of source.custom ?? []) candidates.push(candidate)

  return candidates
}

/**
 * The point indices whose positions must be read back from the GPU.
 *
 * A union, not simply the top-N: selecting a point outside the global ranking
 * still has to place its label, and a label with no position cannot be drawn.
 * Dynamic labels are absent on purpose — the sampling pass already returns
 * their positions, so tracking them again would be a second readback for
 * numbers already in hand.
 */
export function trackedPointIndices (
  source: Pick<LabelSource, 'rankedByWeight' | 'selected' | 'focused'>,
  policy: LabelPolicy
): number[] {
  const indices = new Set<number>()
  if (policy.showTopLabels !== false) {
    const limit = policy.topLabelsLimit ?? DEFAULTS.topLabelsLimit
    for (const index of source.rankedByWeight.slice(0, limit)) indices.add(index)
  }
  if (policy.showSelectedLabels !== false) {
    const limit = policy.selectedLabelsLimit ?? DEFAULTS.selectedLabelsLimit
    for (const index of source.selected.slice(0, limit)) indices.add(index)
  }
  for (const index of policy.showLabelsFor ?? []) indices.add(index)
  if (source.focused !== undefined) indices.add(source.focused)
  return [...indices]
}
