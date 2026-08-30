/**
 * Drawing the label atlas: the part that talks to Skia.
 *
 * Split out of the renderer so a test can execute it. `CosmosSkiaLabels.tsx`
 * cannot be imported outside React Native, which left every Skia call in this
 * package checked only by TypeScript — and TypeScript is exactly what does not
 * help here. `@shopify/react-native-skia` ships declarations that contradict
 * its own JSI bindings (`Font.setSubpixel` is declared `boolean` and reads
 * `arguments[0].asNumber()`), so a call that satisfies the compiler can still
 * throw `Value is true, expected a number` on the device.
 *
 * Everything here is therefore reachable from `skia-atlas-bake.test.ts`, which
 * runs it against a mock that enforces the *native* argument types rather than
 * the declared ones.
 */

import {
  Skia,
  createPicture,
  type SkFont,
  type SkPicture,
  type SkRect,
} from '@shopify/react-native-skia'
import { packLabels, type LabelAtlasMetrics, type MeasuredLabel } from '../labels'

/**
 * The most labels drawn at once.
 *
 * Fixed, because the atlas requires its sprite and transform arrays to be the
 * same length, and the transform buffer allocates once for a stable size.
 * Unused slots are parked off-screen rather than removed.
 */
export const MAX_LABELS = 160

export type BakedAtlas = {
  picture: SkPicture
  size: { width: number; height: number }
  sprites: SkRect[]
  /** How many labels got a slot; the rest exceeded the texture budget. */
  placed: number
}

/**
 * Atlas texture width in physical pixels; rows wrap within it.
 *
 * Scaled with the device so a dense screen does not simply stack three times
 * as many rows, and capped at 2048 — half the smallest texture limit any GPU
 * likely to run this reports, which leaves the height budget the same room.
 */
export function atlasWidth (pixelRatio: number): number {
  return Math.max(1024, Math.min(2048, Math.round(1024 * pixelRatio)))
}

/**
 * Prepares a font for use in the atlas. Call once per font, before measuring.
 *
 * Not per bake: this mutates the caller's `SkFont`, and measurements are cached
 * per string, so changing metrics after a pass has measured would draw glyphs
 * that no longer match the widths the layout collided against.
 *
 * Only `setLinearMetrics` is set. Advances are otherwise rounded to whole
 * pixels at the baked size, and the atlas is drawn back down by the device
 * ratio — so rounded advances would land the text at a slightly different
 * width than `measureText` reported. `setSubpixel` is deliberately *not* set:
 * every glyph origin here is an integer, so it would buy nothing, and its
 * binding rejects the boolean its own declaration asks for.
 */
export function configureFont (font: SkFont): SkFont {
  font.setLinearMetrics(true)
  return font
}

/**
 * Draws every label once into a single picture, recording where each landed.
 *
 * One texture rather than one per label: the atlas draws them all in a single
 * call, and a call per label would put the cost back where it came from.
 *
 * Sizes arrive in physical pixels — see `labelAtlasMetrics` for why — and the
 * sprite is scaled back down when it is drawn.
 */
export function bakeAtlas (
  labels: readonly MeasuredLabel[],
  metrics: LabelAtlasMetrics,
  font: SkFont,
  color: string,
  chipColor: string | undefined
): BakedAtlas {
  // Padded to the pool size, not to the label count. The native atlas requires
  // the sprite and transform arrays to be the same length and throws if they
  // are not — on every commit, which React then repeats.
  const packed = packLabels(labels, MAX_LABELS, atlasWidth(metrics.pixelRatio))
  const sprites: SkRect[] = packed.sprites.map((sprite) =>
    Skia.XYWHRect(sprite.x, sprite.y, sprite.width, sprite.height)
  )

  const size = { width: packed.width, height: packed.height }
  const textPaint = Skia.Paint()
  textPaint.setColor(Skia.Color(color))
  textPaint.setAntiAlias(true)
  const chipPaint = Skia.Paint()
  chipPaint.setAntiAlias(true)
  if (chipColor !== undefined) chipPaint.setColor(Skia.Color(chipColor))

  const picture = createPicture((canvas) => {
    // Only what the packer placed; anything past its budget has no slot.
    for (let index = 0; index < packed.placed; index++) {
      const label = labels[index]
      const sprite = sprites[index]
      if (!label || !sprite) continue
      if (chipColor !== undefined) {
        canvas.drawRRect(
          Skia.RRectXY(
            Skia.XYWHRect(sprite.x, sprite.y, sprite.width, sprite.height),
            metrics.radius,
            metrics.radius
          ),
          chipPaint
        )
      }
      canvas.drawText(
        label.text,
        sprite.x + metrics.padding[0],
        sprite.y + metrics.baseline,
        textPaint,
        font
      )
    }
  }, Skia.XYWHRect(0, 0, size.width, size.height))

  return { picture, size, sprites, placed: packed.placed }
}
