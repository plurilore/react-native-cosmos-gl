import {
  AlphaType,
  ColorType,
  Skia,
  type SkFont,
} from '@shopify/react-native-skia'
import type { LabelAtlasMetrics, LabelAtlasSlot } from '../labels'
import type { LabelAtlasPatch } from '../core/labels'

export type LabelRasterRequest = {
  text: string
  slot: LabelAtlasSlot
}

/** Configures stable glyph advances before any label is measured. */
export function configureFont (font: SkFont): SkFont {
  font.setLinearMetrics(true)
  return font
}

/**
 * Rasterizes all cache misses into one CPU-backed Skia surface.
 *
 * The output remains one patch per destination slot, but Skia setup, drawing,
 * snapshotting and pixel readback happen once for the batch. Only alpha is
 * uploaded; text color and chips are applied by the GL shader.
 */
export function rasterizeLabelPatches (
  requests: readonly LabelRasterRequest[],
  metrics: LabelAtlasMetrics,
  font: SkFont,
  maxBatchWidth = 2048
): LabelAtlasPatch[] {
  if (requests.length === 0) return []

  const packed = packBatch(requests, maxBatchWidth)
  const surface = Skia.Surface.Make(packed.width, packed.height)
  if (!surface) throw new Error('Skia could not create a CPU label-raster surface')

  const canvas = surface.getCanvas()
  canvas.clear(Skia.Color('transparent'))
  const paint = Skia.Paint()
  paint.setAntiAlias(true)
  paint.setColor(Skia.Color('#ffffff'))

  for (const item of packed.items) {
    canvas.drawText(
      item.request.text,
      item.x + metrics.padding[0],
      item.y + metrics.baseline,
      paint,
      font
    )
  }

  surface.flush()
  const image = surface.makeImageSnapshot()
  let pixels: Uint8Array | null = null
  let channels = 1
  try {
    pixels = image.readPixels(0, 0, {
      width: packed.width,
      height: packed.height,
      colorType: ColorType.Alpha_8,
      alphaType: AlphaType.Unpremul,
    }) as Uint8Array | null
  } catch {
    // Older native Skia binaries expose Alpha_8 in TypeScript but reject it at
    // runtime. Fall through to the compatible RGBA path.
  }

  // Alpha_8 readback is available in current Skia builds. The RGBA fallback
  // keeps the graph usable on older native binaries without changing the GL
  // atlas format.
  if (!pixels || pixels.length !== packed.width * packed.height) {
    try {
      pixels = image.readPixels(0, 0, {
        width: packed.width,
        height: packed.height,
        colorType: ColorType.RGBA_8888,
        alphaType: AlphaType.Unpremul,
      }) as Uint8Array | null
    } catch {
      pixels = null
    }
    channels = 4
  }

  const patches = pixels
    ? packed.items.map((item) => ({
        x: item.request.slot.x,
        y: item.request.slot.y,
        width: item.request.slot.width,
        height: item.request.slot.height,
        pixels: copyAlpha(
          pixels,
          packed.width,
          item.x,
          item.y,
          item.request.slot.width,
          item.request.slot.height,
          channels
        ),
      }))
    : []

  image.dispose()
  surface.dispose()
  return patches
}

/** Combines adjacent shelf sprites so warm-up crosses the JS/GL boundary once per row. */
export function mergeAdjacentLabelPatches (
  patches: readonly LabelAtlasPatch[],
  maximumGap = 1
): LabelAtlasPatch[] {
  if (patches.length < 2) return [...patches]
  const sorted = [...patches].sort((a, b) => a.y - b.y || a.x - b.x)
  const groups: LabelAtlasPatch[][] = []
  for (const patch of sorted) {
    const group = groups[groups.length - 1]
    const previous = group?.[group.length - 1]
    if (
      group && previous &&
      patch.y === previous.y &&
      patch.height === previous.height &&
      patch.x <= previous.x + previous.width + maximumGap
    ) {
      group.push(patch)
    } else {
      groups.push([patch])
    }
  }

  return groups.map((group) => {
    const first = group[0] as LabelAtlasPatch
    if (group.length === 1) return first
    const right = group.reduce((max, patch) => Math.max(max, patch.x + patch.width), first.x)
    const width = right - first.x
    const pixels = new Uint8Array(width * first.height)
    for (const patch of group) {
      const offsetX = patch.x - first.x
      for (let row = 0; row < patch.height; row++) {
        const sourceStart = row * patch.width
        const targetStart = row * width + offsetX
        pixels.set(patch.pixels.subarray(sourceStart, sourceStart + patch.width), targetStart)
      }
    }
    return { x: first.x, y: first.y, width, height: first.height, pixels }
  })
}

type PackedBatchItem = { request: LabelRasterRequest; x: number; y: number }

function packBatch (requests: readonly LabelRasterRequest[], requestedWidth: number): {
  width: number
  height: number
  items: PackedBatchItem[]
} {
  const widest = requests.reduce((max, request) => Math.max(max, request.slot.width), 1)
  const combinedWidth = requests.reduce((sum, request) => sum + request.slot.width, 0)
  const width = Math.max(
    widest,
    Math.min(Math.max(1, Math.floor(requestedWidth)), 2048, combinedWidth)
  )
  const items: PackedBatchItem[] = []
  let x = 0
  let y = 0
  let rowHeight = 0

  for (const request of requests) {
    if (x > 0 && x + request.slot.width > width) {
      x = 0
      y += rowHeight
      rowHeight = 0
    }
    items.push({ request, x, y })
    x += request.slot.width
    rowHeight = Math.max(rowHeight, request.slot.height)
  }

  return { width, height: Math.max(1, y + rowHeight), items }
}

function copyAlpha (
  source: Uint8Array,
  sourceWidth: number,
  x: number,
  y: number,
  width: number,
  height: number,
  channels: number
): Uint8Array {
  const output = new Uint8Array(width * height)
  const alphaOffset = channels === 4 ? 3 : 0
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const sourceIndex = ((y + row) * sourceWidth + x + column) * channels + alphaOffset
      output[row * width + column] = source[sourceIndex] ?? 0
    }
  }
  return output
}
