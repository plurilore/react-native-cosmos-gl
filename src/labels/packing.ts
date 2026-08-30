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
  width: number
): PackedAtlas {
  const sprites: PackedSprite[] = []
  let cursorX = 0
  let cursorY = 0
  let rowHeight = 0

  for (const label of labels.slice(0, capacity)) {
    // A label wider than the whole atlas still gets a slot rather than looping
    // forever looking for room; `cursorX > 0` is what stops that.
    if (cursorX + label.width > width && cursorX > 0) {
      cursorX = 0
      cursorY += rowHeight
      rowHeight = 0
    }
    sprites.push({ x: cursorX, y: cursorY, width: label.width, height: label.height })
    cursorX += label.width
    rowHeight = Math.max(rowHeight, label.height)
  }

  const height = Math.max(1, cursorY + rowHeight)
  while (sprites.length < capacity) sprites.push(EMPTY_SPRITE)
  return { sprites, width, height }
}

const EMPTY_SPRITE: PackedSprite = { x: 0, y: 0, width: 0, height: 0 }
