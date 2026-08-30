import type { LabelBox } from './types'

/**
 * Which labels survive overlapping each other.
 *
 * Sweep-and-prune: sort by left edge, and for each label only compare against
 * those starting before its right edge. That turns the quadratic pairwise test
 * into something close to linear for the sparse arrangements labels actually
 * form, which matters because this runs whenever the set or the camera changes.
 *
 * The tie-break is the part worth keeping: when two labels of equal priority
 * overlap, the one that was **visible last frame** wins. Without it a settling
 * simulation makes labels trade places every tick, and a flickering label is
 * harder to read than no label.
 */
export function resolveCollisions (
  boxes: readonly LabelBox[],
  viewport: { width: number; height: number }
): Set<string> {
  const left = (box: LabelBox): number => box.x - box.width / 2
  const right = (box: LabelBox): number => box.x + box.width / 2
  const top = (box: LabelBox): number => box.y - box.height
  const bottom = (box: LabelBox): number => box.y

  const visible = new Map<string, boolean>()
  for (const box of boxes) {
    // Off-screen labels are dropped outright rather than clamped to an edge,
    // where they would pile up describing points nobody can see.
    visible.set(
      box.id,
      box.x > 0 && box.y > 0 && box.x < viewport.width && box.y < viewport.height
    )
  }

  const sorted = [...boxes].sort((a, b) => left(a) - left(b))

  for (let i = 0; i < sorted.length; i++) {
    const first = sorted[i] as LabelBox
    if (!visible.get(first.id)) continue

    for (let j = i + 1; j < sorted.length; j++) {
      const second = sorted[j] as LabelBox
      // Sorted by left edge, so once one starts past this one's right edge,
      // nothing after it can overlap either.
      if (left(second) > right(first)) break
      if (!visible.get(second.id)) continue
      if (top(second) > bottom(first) || top(first) > bottom(second)) continue

      const preferSecond =
        second.priority > first.priority ||
        (second.priority === first.priority &&
          !first.forceShow &&
          !second.forceShow &&
          second.previouslyVisible &&
          !first.previouslyVisible)

      const winner = preferSecond ? second : first
      const loser = preferSecond ? first : second
      // A forced label survives losing — unless the winner is forced too, in
      // which case something has to give and the loser goes.
      visible.set(loser.id, winner.forceShow ? false : loser.forceShow)

      if (!visible.get(first.id)) break
    }
  }

  const result = new Set<string>()
  for (const [id, isVisible] of visible) if (isVisible) result.add(id)
  return result
}
