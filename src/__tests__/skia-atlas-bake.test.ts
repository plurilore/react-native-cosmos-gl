import { describe, it, expect, vi, beforeEach } from 'vitest'
import { assertNativeCall, NativeContractError } from './skia-native-contract'

/**
 * Executes the atlas bake against a Skia that behaves like the native one.
 *
 * The renderer itself cannot be imported outside React Native, which is why
 * every Skia call in this package used to be checked by nothing but the
 * compiler — and the compiler is the wrong tool here, because the shipped
 * declarations disagree with the shipped bindings. Three device-only crashes
 * came out of that file in a row: a sprite/transform length mismatch, buffers
 * that do not survive the worklet boundary, and `setSubpixel(true)`.
 *
 * So `bakeAtlas` lives in a plain module and this runs it. The mock is not a
 * convenience stub: each method checks its arguments against
 * `SKIA_NATIVE_CONTRACT`, so a call that satisfies TypeScript and would throw
 * on a phone throws here instead.
 */

/** Records every call, and rejects the ones JSI would. */
const calls: string[] = []

function host<T extends Record<string, unknown>> (cls: string, methods: T): T {
  const wrapped: Record<string, unknown> = { ...methods }
  for (const [name, value] of Object.entries(methods)) {
    if (typeof value !== 'function') continue
    wrapped[name] = (...args: unknown[]) => {
      assertNativeCall(`${cls}.${name}`, args)
      calls.push(`${cls}.${name}`)
      return (value as (...a: unknown[]) => unknown)(...args)
    }
  }
  return wrapped as T
}

const drawn: { text: string; x: number; y: number }[] = []
const chips: { x: number; y: number; width: number; height: number }[] = []

vi.mock('@shopify/react-native-skia', () => {
  const rect = (x: number, y: number, width: number, height: number) =>
    ({ x, y, width, height })
  return {
    Skia: {
      XYWHRect: rect,
      RRectXY: (r: ReturnType<typeof rect>, rx: number, ry: number) => ({ rect: r, rx, ry }),
      Color: (value: string) => new Float32Array([0, 0, 0, 1, value.length]),
      Paint: () =>
        host('Paint', {
          setColor: (_: unknown) => undefined,
          setAntiAlias: (_: unknown) => undefined,
        }),
    },
    createPicture: (
      draw: (canvas: unknown) => void,
      bounds: { width: number; height: number }
    ) => {
      const canvas = host('Canvas', {
        drawRRect: (rrect: { rect: { x: number; y: number; width: number; height: number } }) => {
          chips.push(rrect.rect)
        },
        drawText: (text: string, x: number, y: number) => {
          drawn.push({ text, x, y })
        },
      })
      draw(canvas)
      return { bounds }
    },
  }
})

const { bakeAtlas, configureFont, atlasWidth, MAX_LABELS } = await import('../skia/bake')
const { labelAtlasMetrics } = await import('../labels')

/** A font with the JSI argument types, not the declared ones. */
const makeFont = () =>
  host('Font', {
    setLinearMetrics: (_: unknown) => undefined,
    setSubpixel: (_: unknown) => undefined,
    setEmbolden: (_: unknown) => undefined,
    measureText: (text: string) => ({ width: text.length * 7 }),
  })

const METRICS = labelAtlasMetrics({
  fontSize: 12, padding: [5, 3, 5, 3], margin: 7, pixelRatio: 3,
})

const label = (text: string, width = text.length * 7) => ({
  id: text, index: 0, kind: 'top' as const, text,
  position: [0, 0] as [number, number], priority: 1, forceShow: false,
  width, height: METRICS.lineHeight,
})

beforeEach(() => {
  calls.length = 0
  drawn.length = 0
  chips.length = 0
})

describe('configureFont', () => {
  it('does not call a binding that rejects the boolean it declares', () => {
    // The crash this file exists for. `setSubpixel` is declared `(x: boolean)`
    // and reads `arguments[0].asNumber()`, so the call TypeScript asks for
    // throws inside a passive effect with a stack naming nothing useful.
    const font = makeFont()
    expect(() => configureFont(font as never)).not.toThrow()
    expect(calls).toEqual(['Font.setLinearMetrics'])
  })

  it('would have caught the crash that shipped', () => {
    // Proof the mock is load-bearing rather than decorative: the call the
    // declaration invites fails here exactly as it did on the device.
    const font = makeFont()
    expect(() => font.setSubpixel(true)).toThrow(NativeContractError)
    expect(() => font.setSubpixel(true)).toThrow(/expected a number/)
  })

  it('keeps advances linear, so measured widths match the glyphs drawn', () => {
    const font = makeFont()
    configureFont(font as never)
    expect(calls).toContain('Font.setLinearMetrics')
  })
})

describe('bakeAtlas', () => {
  it('draws every label the packer placed, and no more', () => {
    const labels = [label('alpha'), label('beta'), label('gamma')]
    const atlas = bakeAtlas(labels, METRICS, makeFont() as never, '#fff', undefined)
    expect(atlas.placed).toBe(3)
    expect(drawn.map((d) => d.text)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('pads the sprites to the transform pool', () => {
    // The invariant the native atlas enforces on every commit.
    const atlas = bakeAtlas([label('one')], METRICS, makeFont() as never, '#fff', undefined)
    expect(atlas.sprites).toHaveLength(MAX_LABELS)
  })

  it('never draws a label the packer had no room for', () => {
    // A sprite past the budget is a zero rect; drawing text into it would put
    // glyphs on top of another label's slot.
    const labels = Array.from({ length: 200 }, (_, i) => label(`label-${i}`))
    const atlas = bakeAtlas(labels, METRICS, makeFont() as never, '#fff', undefined)
    expect(drawn).toHaveLength(atlas.placed)
    expect(atlas.placed).toBeLessThanOrEqual(MAX_LABELS)
  })

  it('puts each glyph origin on a whole pixel', () => {
    // A fractional origin resamples even when the atlas is drawn at 1:1, which
    // is the blur the physical-pixel layout exists to remove.
    const labels = [label('alpha', 60.4), label('beta', 41.9)]
    bakeAtlas(labels, METRICS, makeFont() as never, '#fff', undefined)
    for (const { x, y } of drawn) {
      expect(Number.isInteger(x)).toBe(true)
      expect(Number.isInteger(y)).toBe(true)
    }
  })

  it('sits the baseline below the top padding, inside the chip', () => {
    bakeAtlas([label('alpha')], METRICS, makeFont() as never, '#fff', undefined)
    const first = drawn[0]
    expect(first?.y).toBe(METRICS.baseline)
    expect(first?.x).toBe(METRICS.padding[0])
  })

  it('sizes the texture in physical pixels', () => {
    const atlas = bakeAtlas([label('alpha')], METRICS, makeFont() as never, '#fff', undefined)
    expect(atlas.size.width).toBe(atlasWidth(3))
    expect(atlas.size.height).toBe(METRICS.lineHeight)
  })

  it('draws a chip only when one was asked for', () => {
    bakeAtlas([label('alpha')], METRICS, makeFont() as never, '#fff', undefined)
    expect(chips).toHaveLength(0)
    bakeAtlas([label('alpha')], METRICS, makeFont() as never, '#fff', '#000')
    expect(chips).toHaveLength(1)
  })

  it('fills the whole slot with the chip, leaving no seam', () => {
    const labels = [label('alpha', 60.4)]
    const atlas = bakeAtlas(labels, METRICS, makeFont() as never, '#fff', '#000')
    expect(chips[0]).toEqual({
      x: atlas.sprites[0]?.x, y: atlas.sprites[0]?.y,
      width: atlas.sprites[0]?.width, height: atlas.sprites[0]?.height,
    })
  })

  it('bakes nothing, and no picture bounds of zero, for an empty set', () => {
    const atlas = bakeAtlas([], METRICS, makeFont() as never, '#fff', undefined)
    expect(atlas.placed).toBe(0)
    expect(drawn).toHaveLength(0)
    expect(atlas.size.height).toBeGreaterThan(0)
  })
})

describe('atlasWidth', () => {
  it('grows with the device but stops well inside the texture limit', () => {
    expect(atlasWidth(1)).toBe(1024)
    expect(atlasWidth(2)).toBe(2048)
    expect(atlasWidth(3)).toBe(2048)
    expect(atlasWidth(0)).toBe(1024)
  })
})
