/**
 * Label geometry in physical pixels.
 *
 * The atlas is rasterized offscreen, and an offscreen Skia surface has an
 * identity transform — unlike a `<Canvas>`, whose playback is scaled by the
 * device pixel ratio before anything is drawn. So glyphs baked at a logical
 * font size come out at a *third* of the resolution they are displayed at on a
 * 3× screen, and the atlas draws a blurry upscale of them.
 *
 * Everything that goes into the picture therefore has to be expressed in
 * physical pixels — the font size, the padding, the baseline, the packing — and
 * the sprite is scaled back down by the same ratio when it is drawn. Net scale
 * is one, and a texel lands on a device pixel.
 *
 * Kept apart from the renderer so the arithmetic is testable: the renderer
 * itself cannot be imported without React Native.
 */

export type LabelAtlasMetrics = {
  /** Font size to rasterize at. */
  fontSize: number
  /** `[left, top, right, bottom]`, physical pixels. */
  padding: [number, number, number, number]
  /** Baseline offset from the top of the chip, physical pixels. */
  baseline: number
  /** Chip height for a single line, physical pixels. */
  lineHeight: number
  /** Gap between a label and its point, physical pixels. */
  margin: number
  /** Corner radius of the chip, physical pixels. */
  radius: number
  /** The ratio these were derived with. */
  pixelRatio: number
}

/** Where the baseline sits within the em box, as a fraction. */
const BASELINE_RATIO = 0.82
const CHIP_RADIUS = 4

/**
 * Scales the caller's logical typography into the physical pixels the atlas is
 * baked in. Rounded, because a fractional origin resamples.
 */
export function labelAtlasMetrics (options: {
  fontSize: number
  padding: readonly [number, number, number, number]
  margin: number
  pixelRatio: number
}): LabelAtlasMetrics {
  const ratio = options.pixelRatio > 0 ? options.pixelRatio : 1
  const fontSize = options.fontSize * ratio
  const padding: [number, number, number, number] = [
    Math.round(options.padding[0] * ratio),
    Math.round(options.padding[1] * ratio),
    Math.round(options.padding[2] * ratio),
    Math.round(options.padding[3] * ratio),
  ]
  return {
    fontSize,
    padding,
    baseline: Math.round(padding[1] + fontSize * BASELINE_RATIO),
    lineHeight: Math.ceil(fontSize + padding[1] + padding[3]),
    margin: Math.round(options.margin * ratio),
    radius: Math.round(CHIP_RADIUS * ratio),
    pixelRatio: ratio,
  }
}

/**
 * Snaps a logical coordinate to a whole physical pixel.
 *
 * A sprite drawn at exactly 1:1 still resamples if its destination lands
 * between device pixels, so the translation is rounded in physical space and
 * expressed back in logical space. The atlas transform's translation is in
 * destination units and is *not* multiplied by the scale, so this must not
 * divide twice.
 */
export function snapToPixel (logical: number, pixelRatio: number): number {
  'worklet'
  const ratio = pixelRatio > 0 ? pixelRatio : 1
  return Math.round(logical * ratio) / ratio
}

/**
 * Where and how large one baked sprite is drawn.
 *
 * The whole crispness argument in one function, so a test can check it rather
 * than restate it. `scale` undoes the physical size the sprite was baked at;
 * the canvas scales playback back up by the same ratio, so the net is one and
 * a texel covers exactly one device pixel.
 *
 * `tx`/`ty` are in destination units and are **not** multiplied by `scale`
 * (`SkRSXform`), so they are snapped to the physical grid rather than divided
 * a second time. A sprite whose destination lands between device pixels is
 * resampled even at a scale of one, which is the blur this exists to avoid.
 *
 * The anchor names the point, and the label sits centred above it; `height`
 * carries the margin that lifts it clear.
 */
export type LabelSpriteTransform = { scale: number; tx: number; ty: number }

export function labelSpriteTransform (
  screenX: number,
  screenY: number,
  width: number,
  height: number,
  pixelRatio: number
): LabelSpriteTransform {
  'worklet'
  const ratio = pixelRatio > 0 ? pixelRatio : 1
  return {
    scale: 1 / ratio,
    tx: snapToPixel(screenX - width / 2, ratio),
    ty: snapToPixel(screenY - height, ratio),
  }
}
