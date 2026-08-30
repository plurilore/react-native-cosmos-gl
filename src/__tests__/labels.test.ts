import { describe, it, expect } from 'vitest'
import {
  LabelManager,
  collectCandidates,
  resolveCollisions,
  trackedPointIndices,
  prioritise,
  CLUSTER_PRIORITY_RANGE,
  LABEL_PRIORITY_BAND,
  type LabelBox,
  type LabelSource,
} from '../labels'

const LABELS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']

function source (overrides: Partial<LabelSource> = {}): LabelSource {
  return {
    text: (i) => LABELS[i],
    weight: (i) => 1 - i * 0.1,
    position: (i) => [i * 10, i * 10],
    rankedByWeight: [0, 1, 2, 3, 4],
    sampled: [3, 4],
    selected: [],
    clusters: [],
    ...overrides,
  }
}

const kinds = (candidates: { kind: string }[]): string[] =>
  [...new Set(candidates.map((candidate) => candidate.kind))].sort()

describe('the cluster/point state machine', () => {
  const clusters = [{ index: 0, name: 'Realm', count: 9, position: [5, 5] as [number, number] }]

  it('shows only cluster labels while nothing is selected', () => {
    // From far out the regions are what orients the reader; naming individual
    // dots as well would bury them.
    const candidates = collectCandidates(
      source({ clusters }),
      { showClusterLabels: true, showTopLabels: true, showDynamicLabels: true },
      false
    )
    expect(kinds(candidates)).toEqual(['cluster'])
  })

  it('swaps to point labels the moment something is selected', () => {
    // `topLabelsLimit` leaves indices 3 and 4 for the sampled set; without a
    // limit the top class claims every point and dynamic has nothing left,
    // which is correct but shows nothing.
    const candidates = collectCandidates(
      source({ clusters, selected: [1] }),
      {
        showClusterLabels: true, showTopLabels: true, topLabelsLimit: 2,
        showDynamicLabels: true, showSelectedLabels: true,
      },
      true
    )
    expect(kinds(candidates)).toEqual(['dynamic', 'selected', 'top'])
    expect(candidates.some((candidate) => candidate.kind === 'cluster')).toBe(false)
  })

  it('keeps forced and custom labels through cluster mode', () => {
    // A host that named a label explicitly meant it, whatever mode the map is
    // in. This is the exception the state machine must not hard-code away.
    const candidates = collectCandidates(
      source({
        clusters,
        custom: [{ id: 'custom-1', kind: 'custom', index: -1, text: 'note', position: [1, 1] }],
      }),
      { showClusterLabels: true, showTopLabels: true, showLabelsFor: [2] },
      false
    )
    expect(kinds(candidates)).toEqual(['cluster', 'custom', 'forced'])
  })

  it('shows point labels with no clusters configured', () => {
    const candidates = collectCandidates(
      source(),
      { showTopLabels: true, topLabelsLimit: 2, showDynamicLabels: true },
      false
    )
    expect(kinds(candidates)).toEqual(['dynamic', 'top'])
  })

  it('gives a point already labelled by a stronger class no second label', () => {
    // Cosmograph reaches the same place by letting later writes overwrite
    // earlier ones; claiming in priority order is the same outcome stated
    // directly, and the band a point lands in is what actually matters.
    const candidates = collectCandidates(
      source({ sampled: [0] }),
      { showTopLabels: true, topLabelsLimit: 1, showDynamicLabels: true },
      false
    )
    expect(candidates.filter((candidate) => candidate.index === 0)).toHaveLength(1)
    expect(candidates.find((candidate) => candidate.index === 0)?.kind).toBe('top')
  })

  it('never labels one point twice', () => {
    const candidates = collectCandidates(
      source({ selected: [0], focused: 0, sampled: [0] }),
      { showTopLabels: true, showDynamicLabels: true, showSelectedLabels: true, showLabelsFor: [0] },
      true
    )
    const zero = candidates.filter((candidate) => candidate.index === 0)
    expect(zero).toHaveLength(1)
    // Claimed by the strongest class that wanted it.
    expect(zero[0]?.kind).toBe('forced')
  })

  it('skips points with no text or no known position', () => {
    const candidates = collectCandidates(
      source({ text: (i) => (i === 1 ? undefined : LABELS[i]), position: (i) => (i === 2 ? undefined : [i, i]) }),
      { showTopLabels: true },
      false
    )
    expect(candidates.map((candidate) => candidate.index)).not.toContain(1)
    expect(candidates.map((candidate) => candidate.index)).not.toContain(2)
  })
})

describe('tracked anchors', () => {
  it('is the union of top, selected, forced and focused', () => {
    // Selecting a node outside the global top-N still has to place its label,
    // and a label with no tracked position cannot be drawn at all.
    const tracked = trackedPointIndices(
      { rankedByWeight: [0, 1], selected: [7], focused: 9 },
      { topLabelsLimit: 2, showLabelsFor: [5] }
    )
    expect(tracked.sort((a, b) => a - b)).toEqual([0, 1, 5, 7, 9])
  })

  it('honours the per-class limits', () => {
    const tracked = trackedPointIndices(
      { rankedByWeight: [0, 1, 2, 3], selected: [8, 9] },
      { topLabelsLimit: 2, selectedLabelsLimit: 1 }
    )
    expect(tracked.sort((a, b) => a - b)).toEqual([0, 1, 8])
  })
})

describe('priority bands', () => {
  it('orders the classes the way attention does', () => {
    const [dynamic, top, selected, focused] = prioritise([
      { id: 'a', kind: 'dynamic', index: 0, text: 'a', position: [0, 0], weight: 1 },
      { id: 'b', kind: 'top', index: 1, text: 'b', position: [0, 0], weight: 0 },
      { id: 'c', kind: 'selected', index: 2, text: 'c', position: [0, 0], weight: 0 },
      { id: 'd', kind: 'focused', index: 3, text: 'd', position: [0, 0], weight: 0 },
    ])
    expect(dynamic!.priority).toBeLessThan(top!.priority)
    expect(top!.priority).toBeLessThan(selected!.priority)
    expect(selected!.priority).toBeLessThan(focused!.priority)
  })

  it('lets the weight column rank labels inside a band, not across bands', () => {
    const [heavyDynamic, lightTop] = prioritise([
      { id: 'a', kind: 'dynamic', index: 0, text: 'a', position: [0, 0], weight: 1 },
      { id: 'b', kind: 'top', index: 1, text: 'b', position: [0, 0], weight: 0 },
    ], { weightSummary: { min: 0, max: 1 } })
    expect(heavyDynamic!.priority).toBeGreaterThan(LABEL_PRIORITY_BAND.dynamic)
    expect(heavyDynamic!.priority).toBeLessThan(lightTop!.priority)
  })

  it('scales a cluster with its membership, above every point label', () => {
    const [small, large] = prioritise([
      { id: 'cluster-0', kind: 'cluster', index: 0, text: 'a', position: [0, 0], count: 1 },
      { id: 'cluster-1', kind: 'cluster', index: 1, text: 'b', position: [0, 0], count: 100 },
    ], { clusterCountExtent: [1, 100] })
    expect(small!.priority).toBe(CLUSTER_PRIORITY_RANGE[0])
    expect(large!.priority).toBe(CLUSTER_PRIORITY_RANGE[1])
    expect(small!.priority).toBeGreaterThan(LABEL_PRIORITY_BAND.selected)
  })

  it('marks focused and forced labels as surviving a loss', () => {
    const labels = prioritise([
      { id: 'a', kind: 'focused', index: 0, text: 'a', position: [0, 0] },
      { id: 'b', kind: 'forced', index: 1, text: 'b', position: [0, 0] },
      { id: 'c', kind: 'top', index: 2, text: 'c', position: [0, 0] },
    ])
    expect(labels.map((label) => label.forceShow)).toEqual([true, true, false])
  })
})

describe('collision', () => {
  const box = (over: Partial<LabelBox>): LabelBox => ({
    id: 'x', x: 100, y: 100, width: 80, height: 16,
    priority: 0, forceShow: false, previouslyVisible: false, ...over,
  })
  const viewport = { width: 800, height: 600 }

  it('drops the lower-priority label of an overlapping pair', () => {
    const visible = resolveCollisions(
      [box({ id: 'low', priority: 1 }), box({ id: 'high', x: 110, priority: 2 })],
      viewport
    )
    expect([...visible]).toEqual(['high'])
  })

  it('keeps labels that do not overlap', () => {
    const visible = resolveCollisions(
      [box({ id: 'a', x: 100 }), box({ id: 'b', x: 400 })],
      viewport
    )
    expect(visible.size).toBe(2)
  })

  it('prefers the label that was visible last frame on a tie', () => {
    // The anti-flicker rule: without it, two equal labels trade places every
    // tick while the layout settles.
    const visible = resolveCollisions(
      [
        box({ id: 'newcomer', priority: 5 }),
        box({ id: 'incumbent', x: 110, priority: 5, previouslyVisible: true }),
      ],
      viewport
    )
    expect([...visible]).toEqual(['incumbent'])
  })

  it('keeps a forced label that loses to an ordinary one', () => {
    const visible = resolveCollisions(
      [box({ id: 'forced', priority: 0, forceShow: true }), box({ id: 'big', x: 110, priority: 900 })],
      viewport
    )
    expect(visible.has('forced')).toBe(true)
    expect(visible.has('big')).toBe(true)
  })

  it('drops a forced label only when the winner is forced too', () => {
    const visible = resolveCollisions(
      [
        box({ id: 'forced', priority: 0, forceShow: true }),
        box({ id: 'focused', x: 110, priority: 1e5, forceShow: true }),
      ],
      viewport
    )
    expect(visible.has('focused')).toBe(true)
    expect(visible.has('forced')).toBe(false)
  })

  it('drops labels outside the viewport', () => {
    const visible = resolveCollisions(
      [box({ id: 'off', x: -50 }), box({ id: 'below', y: 900 }), box({ id: 'on' })],
      viewport
    )
    expect([...visible]).toEqual(['on'])
  })
})

describe('LabelManager', () => {
  const measure = () => ({ width: 60, height: 16 })
  const project = (position: [number, number]): [number, number] => position

  it('projects, collides, and returns least-important-first', () => {
    const manager = new LabelManager()
    const labels = manager.resolve({
      source: source({ position: (i) => [100 + i * 200, 100] }),
      policy: { showTopLabels: true, showDynamicLabels: false },
      hasSelection: false,
      viewport: { width: 800, height: 600 },
      project,
      measure,
    })
    expect(labels.length).toBeGreaterThan(0)
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i]!.priority).toBeGreaterThanOrEqual(labels[i - 1]!.priority)
    }
    expect(labels[0]).toMatchObject({ width: 60, height: 16 })
  })

  it('remembers what was visible, so a tie resolves the same way twice', () => {
    const manager = new LabelManager()
    const crowded = source({ position: () => [100, 100], weight: () => 1 })
    const policy = { showTopLabels: true, showDynamicLabels: false }
    const args = {
      source: crowded, policy, hasSelection: false,
      viewport: { width: 800, height: 600 }, project, measure,
    }
    const first = manager.resolve(args).map((label) => label.id)
    const second = manager.resolve(args).map((label) => label.id)
    expect(second).toEqual(first)
  })

  it('forgets that state on reset', () => {
    const manager = new LabelManager()
    const args = {
      source: source(), policy: { showTopLabels: true }, hasSelection: false,
      viewport: { width: 800, height: 600 }, project, measure,
    }
    manager.resolve(args)
    manager.reset()
    expect(() => manager.resolve(args)).not.toThrow()
  })

  it('skips a label the camera projects to nowhere', () => {
    const manager = new LabelManager()
    const labels = manager.resolve({
      source: source(),
      policy: { showTopLabels: true },
      hasSelection: false,
      viewport: { width: 800, height: 600 },
      project: () => [Number.NaN, Number.NaN],
      measure,
    })
    expect(labels).toEqual([])
  })
})
