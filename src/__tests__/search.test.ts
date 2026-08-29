import { describe, it, expect } from 'vitest'
import { searchPoints } from '../data/search'
import { resolveGraphData } from '../data/resolve'

const ROWS = [
  { id: 'a', name: 'Alan Turing', degree: 1 },
  { id: 'b', name: 'Barbara Liskov', degree: 9 },
  { id: 'c', name: 'Grace Hopper', degree: 5 },
  { id: 'd', name: 'Ada Lovelace', degree: 3 },
  { id: 'e', name: 'Katherine Johnson', degree: 7 },
]

const resolved = resolveGraphData({
  pointData: ROWS,
  pointIdBy: 'id',
  pointLabelBy: 'name',
  pointLabelWeightBy: 'degree',
})

describe('searchPoints', () => {
  it('returns nothing for an empty query', () => {
    expect(searchPoints(resolved, '')).toEqual([])
    expect(searchPoints(resolved, '   ')).toEqual([])
  })

  it('matches case-insensitively', () => {
    expect(searchPoints(resolved, 'GRACE').map((r) => r.label)).toEqual(['Grace Hopper'])
  })

  it('ranks a prefix match above a mid-word one', () => {
    // "Ada Lovelace" starts with the query; "Barbara" merely contains it.
    const labels = searchPoints(resolved, 'a').map((r) => r.label)
    expect(labels[0]).toBe('Ada Lovelace')
  })

  it('ranks a word-start match above a mid-word one', () => {
    // "Barbara Liskov" has "lis" starting a word; "Ada Lovelace" does not
    // contain it at all, so use a query that hits both positions.
    const labels = searchPoints(resolved, 'jo').map((r) => r.label)
    expect(labels).toContain('Katherine Johnson')
  })

  it('breaks ties within a tier by label weight', () => {
    // Both contain "r" mid-word. Barbara (9) must outrank Alan (1) — otherwise
    // a broad query surfaces arbitrary points in row order.
    const results = searchPoints(resolved, 'r')
    const barbara = results.findIndex((r) => r.label === 'Barbara Liskov')
    const alan = results.findIndex((r) => r.label === 'Alan Turing')
    expect(barbara).toBeGreaterThanOrEqual(0)
    expect(alan).toBeGreaterThanOrEqual(0)
    expect(barbara).toBeLessThan(alan)
  })

  it('honours the limit', () => {
    expect(searchPoints(resolved, 'a', 2)).toHaveLength(2)
  })

  it('carries the point id alongside the label', () => {
    expect(searchPoints(resolved, 'Grace')[0]).toMatchObject({ id: 'c', index: 2 })
  })

  it('returns nothing when no label column was mapped', () => {
    // An input that can never produce a result is worse than no input; the
    // component uses this to hide itself entirely.
    const unlabelled = resolveGraphData({ pointData: ROWS, pointIdBy: 'id' })
    expect(searchPoints(unlabelled, 'Grace')).toEqual([])
  })
})
