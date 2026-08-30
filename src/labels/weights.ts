import type { LabelCandidate, LabelClass, PrioritisedLabel } from './types'

/**
 * What a label's class is worth in an overlap.
 *
 * Bands rather than a single scale, because the classes are not comparable on
 * one axis: a selected point's name matters more than any unselected point's,
 * however heavy that point's weight column happens to be. Within a band the
 * column decides.
 */
export const LABEL_PRIORITY_BAND: Record<Exclude<LabelClass, 'cluster'>, number> = {
  dynamic: 0,
  top: 500,
  selected: 1000,
  custom: 10_000,
  forced: 100_000,
  focused: 100_000,
}

/** How far the weight column can lift a label inside its band. */
export const COLUMN_WEIGHT_SPAN = 200

/**
 * Cluster labels scale with membership, and sit above every point label.
 *
 * A cluster names a region rather than a dot, so losing it to one of the dots
 * inside it would be backwards — it is the only thing telling the reader what
 * they are looking at from far out.
 */
export const CLUSTER_PRIORITY_RANGE: [number, number] = [1100, 10_000]

/**
 * Maps a raw column value into `0…COLUMN_WEIGHT_SPAN`.
 *
 * Normalised against the column's own range rather than assumed to be `0..1`,
 * so a weight column in any units ranks the same way.
 */
export function normaliseColumnWeight (
  value: number | undefined,
  summary: { min: number; max: number } | undefined
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  if (summary && Number.isFinite(summary.min) && Number.isFinite(summary.max)) {
    const span = summary.max - summary.min
    if (span > 0) {
      const t = (value - summary.min) / span
      return Math.max(0, Math.min(COLUMN_WEIGHT_SPAN, t * COLUMN_WEIGHT_SPAN))
    }
  }
  // No usable summary: treat a 0..1 value as a fraction of the span, and
  // anything else as already being in it.
  if (value >= 0 && value <= 1) return COLUMN_WEIGHT_SPAN * value
  return Math.max(0, Math.min(COLUMN_WEIGHT_SPAN, value))
}

/** Linear interpolation of a count into the cluster band. */
export function clusterPriority (
  count: number | undefined,
  countExtent: [number, number] | undefined
): number {
  const [low, high] = CLUSTER_PRIORITY_RANGE
  if (count === undefined || !countExtent) return low
  const [min, max] = countExtent
  if (!(max > min)) return low
  const t = Math.max(0, Math.min(1, (count - min) / (max - min)))
  return low + (high - low) * t
}

/** Assigns each candidate its priority and whether collision may drop it. */
export function prioritise (
  candidates: readonly LabelCandidate[],
  options: {
    weightSummary?: { min: number; max: number }
    clusterCountExtent?: [number, number]
  } = {}
): PrioritisedLabel[] {
  return candidates.map((candidate) => {
    if (candidate.kind === 'cluster') {
      return {
        ...candidate,
        priority: clusterPriority(candidate.count, options.clusterCountExtent),
        forceShow: false,
      }
    }
    const band = LABEL_PRIORITY_BAND[candidate.kind]
    const forceShow = candidate.kind === 'focused' || candidate.kind === 'forced'
    return {
      ...candidate,
      priority: band + normaliseColumnWeight(candidate.weight, options.weightSummary),
      forceShow,
    }
  })
}

/** The `[min, max]` of a set of counts, or `undefined` if there are none. */
export function countExtent (counts: readonly number[]): [number, number] | undefined {
  let min = Infinity
  let max = -Infinity
  for (const count of counts) {
    if (!Number.isFinite(count)) continue
    if (count < min) min = count
    if (count > max) max = count
  }
  return Number.isFinite(min) ? [min, max] : undefined
}
