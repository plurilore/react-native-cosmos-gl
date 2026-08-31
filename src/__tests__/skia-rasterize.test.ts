import { beforeEach, describe, expect, it, vi } from 'vitest'

let surfaces = 0
let snapshots = 0
const drawn: string[] = []
const surfaceSizes: Array<[number, number]> = []
let rejectAlpha = false

vi.mock('@shopify/react-native-skia', () => ({
  AlphaType: { Unpremul: 3 },
  ColorType: { Alpha_8: 1, RGBA_8888: 4 },
  Skia: {
    Color: (value: string) => value,
    Paint: () => ({
      setAntiAlias: () => undefined,
      setColor: () => undefined,
    }),
    Surface: {
      Make: (width: number, height: number) => {
        surfaces += 1
        surfaceSizes.push([width, height])
        return {
          getCanvas: () => ({
            clear: () => undefined,
            drawText: (text: string) => drawn.push(text),
          }),
          flush: () => undefined,
          makeImageSnapshot: () => {
            snapshots += 1
            return {
              readPixels: (_x: number, _y: number, info: { colorType: number }) => {
                if (info.colorType === 1 && rejectAlpha) throw new Error('Alpha_8 unavailable')
                if (info.colorType === 1) return new Uint8Array(width * height).fill(211)
                const rgba = new Uint8Array(width * height * 4)
                for (let index = 3; index < rgba.length; index += 4) rgba[index] = 199
                return rgba
              },
              dispose: () => undefined,
            }
          },
          dispose: () => undefined,
        }
      },
    },
  },
}))

const { mergeAdjacentLabelPatches, rasterizeLabelPatches } = await import('../skia/rasterize')
const { labelAtlasMetrics } = await import('../labels')

beforeEach(() => {
  surfaces = 0
  snapshots = 0
  drawn.length = 0
  surfaceSizes.length = 0
  rejectAlpha = false
})

describe('CPU Skia label rasterizer', () => {
  it('batches cache misses into one surface and returns R8 patches', () => {
    const metrics = labelAtlasMetrics({
      fontSize: 12,
      padding: [5, 3, 5, 3],
      margin: 7,
      pixelRatio: 2,
    })
    const patches = rasterizeLabelPatches([
      { text: 'alpha', slot: { key: 'alpha', x: 10, y: 20, width: 80, height: 30 } },
      { text: 'béta', slot: { key: 'béta', x: 100, y: 20, width: 70, height: 30 } },
    ], metrics, {} as never)

    expect(surfaces).toBe(1)
    expect(snapshots).toBe(1)
    expect(drawn).toEqual(['alpha', 'béta'])
    expect(patches).toHaveLength(2)
    expect(patches[0]).toMatchObject({ x: 10, y: 20, width: 80, height: 30 })
    expect(patches[0]?.pixels).toHaveLength(80 * 30)
    expect(patches[0]?.pixels[0]).toBe(211)
  })

  it('falls back to RGBA alpha when the native Alpha_8 read throws', () => {
    rejectAlpha = true
    const metrics = labelAtlasMetrics({
      fontSize: 12,
      padding: [5, 3, 5, 3],
      margin: 7,
      pixelRatio: 2,
    })
    const patches = rasterizeLabelPatches([
      { text: 'fallback', slot: { key: 'fallback', x: 0, y: 0, width: 40, height: 20 } },
    ], metrics, {} as never)

    expect(surfaces).toBe(1)
    expect(snapshots).toBe(1)
    expect(patches[0]?.pixels[0]).toBe(199)
    expect(surfaceSizes[0]?.[0]).toBe(40)
  })

  it('merges adjacent cache misses into one upload per shelf row', () => {
    const patches = mergeAdjacentLabelPatches([
      { x: 0, y: 4, width: 2, height: 2, pixels: new Uint8Array([1, 2, 3, 4]) },
      { x: 3, y: 4, width: 2, height: 2, pixels: new Uint8Array([5, 6, 7, 8]) },
      { x: 0, y: 7, width: 2, height: 2, pixels: new Uint8Array(4).fill(9) },
    ])

    expect(patches).toHaveLength(2)
    expect(patches[0]).toMatchObject({ x: 0, y: 4, width: 5, height: 2 })
    expect([...patches[0]!.pixels]).toEqual([1, 2, 0, 5, 6, 3, 4, 0, 7, 8])
  })
})
