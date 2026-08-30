/**
 * Where each label sits inside the baked atlas texture.
 *
 * Separated from the drawing so the rule can be tested without a GPU — and
 * because one of its outputs is a hard requirement of the native atlas API
 * rather than a preference: the sprite and transform arrays must be the same
 * length, or `drawAtlas` throws. Getting that wrong throws on every commit,
 * and React keeps committing, so it loops.
 */

/** A packed slot, in atlas pixels. */
export type PackedSprite = { x: number; y: number; width: number; height: number }

export type PackedAtlas = {
  /** Always exactly `capacity` long. Slots past the label count are empty. */
  sprites: PackedSprite[]
  width: number
  height: number
  /** How many labels actually got a slot; the rest exceeded the budget. */
  placed: number
}

/**
 * Lays labels out in rows within `width`, padding to `capacity`.
 *
 * The padding is the point. The transform buffer is a fixed pool — it has to
 * be, because it is allocated once for a stable size — so the sprite list must
 * match it whatever the label count happens to be this frame. Unused slots get
 * a zero-size rect, which draws nothing, and their transforms are parked
 * off-screen anyway.
 */
export function packLabels (
  labels: readonly { width: number; height: number }[],
  capacity: number,
  width: number,
  maxHeight = DEFAULT_MAX_HEIGHT
): PackedAtlas {
  const sprites: PackedSprite[] = []
  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0
  let placed = 0

  for (const label of labels.slice(0, capacity)) {
    // Integers throughout: a sprite whose origin lands on a half pixel is
    // resampled even when the atlas is drawn at exactly 1:1, which is the
    // whole point of the physical-pixel layout.
    const labelWidth = Math.ceil(label.width)
    const labelHeight = Math.ceil(label.height)

    // A label wider than the whole atlas still gets a slot rather than looping
    // forever looking for room; `cursorX > 0` is what stops that.
    if (cursorX + labelWidth > width && cursorX > 0) {
      cursorX = 0
      cursorY += rowHeight
      rowHeight = 0
    }

    // Past the budget, drop the rest. The texture is a real GPU allocation and
    // the library asserts it is non-null, so an atlas that outgrows the
    // device's limit is a crash rather than a missing label.
    if (cursorY + labelHeight > maxHeight) break

    sprites.push({ x: cursorX, y: cursorY, width: labelWidth, height: labelHeight })
    cursorX += labelWidth
    rowHeight = Math.max(rowHeight, labelHeight)
    placed++
  }

  const height = Math.max(1, Math.min(maxHeight, cursorY + rowHeight))
  while (sprites.length < capacity) sprites.push(EMPTY_SPRITE)
  return { sprites, width, height, placed }
}

/**
 * How tall the atlas may grow, in physical pixels.
 *
 * Paired with a width of the same order this stays well inside the 4096 limit
 * of the oldest GPUs likely to run this, with room for a 3× device.
 */
export const DEFAULT_MAX_HEIGHT = 2048

const EMPTY_SPRITE: PackedSprite = { x: 0, y: 0, width: 0, height: 0 }
