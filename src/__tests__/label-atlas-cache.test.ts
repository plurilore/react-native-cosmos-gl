import { describe, expect, it } from 'vitest'
import { LabelAtlasCache, labelAtlasCacheKey } from '../labels'

describe('LabelAtlasCache', () => {
  it('retains slots and reports cache hits', () => {
    const cache = new LabelAtlasCache(64, 64)
    const first = cache.acquire('alpha', 20, 10)
    const second = cache.acquire('alpha', 20, 10)

    expect(first?.hit).toBe(false)
    expect(second?.hit).toBe(true)
    expect(second?.slot).toBe(first?.slot)
    expect(cache.hits).toBe(1)
    expect(cache.misses).toBe(1)
  })

  it('wraps shelves and never overlaps the atlas bounds', () => {
    const cache = new LabelAtlasCache(32, 32, 1)
    const a = cache.acquire('a', 20, 10)?.slot
    const b = cache.acquire('b', 20, 10)?.slot
    expect(a).toMatchObject({ x: 0, y: 0, width: 20, height: 10 })
    expect(b).toMatchObject({ x: 0, y: 11, width: 20, height: 10 })
  })

  it('reports overflow and can repack a new live generation', () => {
    const cache = new LabelAtlasCache(16, 16)
    expect(cache.acquire('too-wide', 17, 4)).toBeUndefined()
    expect(cache.overflows).toBe(1)

    cache.acquire('old', 8, 8)
    cache.reset()
    expect(cache.generation).toBe(1)
    expect(cache.get('old')).toBeUndefined()
    expect(cache.acquire('new', 8, 8)?.slot).toMatchObject({ x: 0, y: 0 })
  })

  it('keys text by font generation, size and raster scale', () => {
    const first = labelAtlasCacheKey('béta', 1, 24, 2)
    expect(first).toBe(labelAtlasCacheKey('béta', 1, 24, 2))
    expect(first).not.toBe(labelAtlasCacheKey('béta', 2, 24, 2))
    expect(first).not.toBe(labelAtlasCacheKey('béta', 1, 25, 2))
    expect(first).not.toBe(labelAtlasCacheKey('béta', 1, 24, 3))
  })

  it('rejects a reused key with incompatible dimensions', () => {
    const cache = new LabelAtlasCache(64, 64)
    cache.acquire('same-generation', 20, 10)
    expect(() => cache.acquire('same-generation', 21, 10)).toThrow(/font generation/)
  })
})
