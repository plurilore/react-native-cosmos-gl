import { collectCandidates, trackedPointIndices, type LabelSource } from './candidates'
import { resolveCollisions } from './collision'
import { countExtent, prioritise } from './weights'
import type { LabelBox, LabelCandidate, LabelPolicy, PrioritisedLabel } from './types'

/** How a renderer measures its own text. Screen pixels. */
export type MeasureLabel = (label: PrioritisedLabel) => { width: number; height: number }

/** A label the renderer should draw, already positioned in screen pixels. */
export type ResolvedLabel = PrioritisedLabel & {
  /** Horizontal centre, screen pixels. */
  screenX: number
  /** Bottom edge, screen pixels. */
  screenY: number
  width: number
  height: number
}

/**
 * Decides which labels exist, what they outrank, and which survive overlapping.
 *
 * Holds exactly one piece of state — what was visible last frame — because the
 * collision tie-break needs it to stop labels flickering as a layout settles.
 * Everything else is a function of its inputs.
 *
 * Renderer-independent by construction: it works in simulation space and screen
 * pixels and never touches a drawing API, so the same policy serves a Skia
 * canvas, a React overlay, or a test.
 */
export class LabelManager {
  private previouslyVisible = new Set<string>()
  /** Measured size per label string. Text metrics do not depend on the camera. */
  private readonly measurements = new Map<string, { width: number; height: number }>()

  /** Point indices whose positions the caller should keep tracked. */
  public tracked (
    source: Pick<LabelSource, 'rankedByWeight' | 'selected' | 'focused'>,
    policy: LabelPolicy
  ): number[] {
    return trackedPointIndices(source, policy)
  }

  /**
   * The labels to draw, in draw order.
   *
   * `project` maps simulation space to screen pixels — supplied by the caller
   * so the camera stays the graph's business, and so a label's *anchor* moves
   * with the view while its text does not.
   */
  public resolve (options: {
    source: LabelSource
    policy: LabelPolicy
    hasSelection: boolean
    viewport: { width: number; height: number }
    project: (position: [number, number]) => [number, number]
    measure: MeasureLabel
    weightSummary?: { min: number; max: number }
  }): ResolvedLabel[] {
    const candidates = collectCandidates(options.source, options.policy, options.hasSelection)
    const clusterCounts = candidates
      .filter((candidate) => candidate.kind === 'cluster')
      .map((candidate) => candidate.count ?? 0)

    const prioritised = prioritise(candidates, {
      weightSummary: options.weightSummary ?? summariseWeights(candidates),
      clusterCountExtent: countExtent(clusterCounts),
    })

    const placed: ResolvedLabel[] = []
    const boxes: LabelBox[] = []
    for (const label of prioritised) {
      const [screenX, screenY] = options.project(label.position)
      if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) continue
      const { width, height } = options.measure(label)
      placed.push({ ...label, screenX, screenY, width, height })
      boxes.push({
        id: label.id,
        x: screenX,
        y: screenY,
        width,
        height,
        priority: label.priority,
        forceShow: label.forceShow,
        previouslyVisible: this.previouslyVisible.has(label.id),
      })
    }

    const visible = resolveCollisions(boxes, options.viewport)
    this.previouslyVisible = visible

    // Ascending priority, so a renderer drawing in order puts the most
    // important label on top when two are close enough to touch.
    return placed
      .filter((label) => visible.has(label.id))
      .sort((a, b) => a.priority - b.priority)
  }

  /**
   * The labels to draw, with their sizes, but not yet placed.
   *
   * The slow half of the work: choosing candidates, ranking them, and
   * measuring their text. None of it depends on the camera — a label's width
   * cannot change because the view panned — so it belongs on the clock that
   * tracks the *data*, leaving only projection and collision for the frame.
   *
   * Measurements are cached per string. Measuring text is a synchronous call
   * into the text engine, and doing it per label per frame was most of what
   * made the previous design expensive.
   */
  public select (options: {
    source: LabelSource
    policy: LabelPolicy
    hasSelection: boolean
    measure: MeasureLabel
    weightSummary?: { min: number; max: number }
  }): MeasuredLabel[] {
    const candidates = collectCandidates(options.source, options.policy, options.hasSelection)
    const clusterCounts = candidates
      .filter((candidate) => candidate.kind === 'cluster')
      .map((candidate) => candidate.count ?? 0)

    const prioritised = prioritise(candidates, {
      weightSummary: options.weightSummary ?? summariseWeights(candidates),
      clusterCountExtent: countExtent(clusterCounts),
    })

    const measured = prioritised.map((label) => {
      const cached = this.measurements.get(label.text)
      const size = cached ?? options.measure(label)
      if (!cached) this.measurements.set(label.text, size)
      return { ...label, width: size.width, height: size.height }
    })

    // Bounded so a long session cannot grow it without limit; label text
    // repeats heavily, so even a small cache hits almost always.
    if (this.measurements.size > MEASUREMENT_CACHE_LIMIT) this.measurements.clear()
    return measured
  }

  /** Forgets the hysteresis state and cached measurements. */
  public reset (): void {
    this.previouslyVisible = new Set()
    this.measurements.clear()
  }
}

/** A selected label with its measured screen size, before placement. */
export type MeasuredLabel = PrioritisedLabel & { width: number; height: number }

const MEASUREMENT_CACHE_LIMIT = 2_000

/**
 * The weight column's range across the candidates in hand.
 *
 * A fallback for callers that have not summarised the whole column. Computed
 * from candidates rather than every point because it only has to rank the
 * labels that exist this frame against each other.
 */
function summariseWeights (
  candidates: readonly LabelCandidate[]
): { min: number; max: number } | undefined {
  let min = Infinity
  let max = -Infinity
  for (const candidate of candidates) {
    const weight = candidate.weight
    if (typeof weight !== 'number' || !Number.isFinite(weight)) continue
    if (weight < min) min = weight
    if (weight > max) max = weight
  }
  return Number.isFinite(min) ? { min, max } : undefined
}
