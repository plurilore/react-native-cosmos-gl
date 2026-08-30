/**
 * Projection and collision over flat arrays, for the UI thread.
 *
 * The object-based `resolveCollisions` allocates a Map, a Set and a sorted
 * copy. That is fine on the JS thread once a tick, and wrong on the render
 * thread every frame — so this is the same algorithm expressed over
 * preallocated typed arrays, allocating nothing per call.
 *
 * It is deliberately a separate implementation rather than a rewrite of the
 * original: the original stays as the reference the tests check this against,
 * and as what the non-Skia overlay uses.
 */

import { projectViewPoint, type ViewProjection } from '../core/view-projection'

/**
 * A label set laid out for the fast path.
 *
 * Parallel arrays rather than objects, sized to the pool and reused. `count`
 * is how many slots are live; the rest are parked.
 */
export type LabelLayoutBuffers = {
  /** Simulation-space anchors, interleaved `[x0, y0, x1, y1, …]`. */
  anchors: Float32Array
  /** Screen size of each label, interleaved `[w0, h0, w1, h1, …]`. */
  sizes: Float32Array
  priorities: Float32Array
  /** 1 where the label survives losing an overlap. */
  forced: Uint8Array
  /** Written by `layoutLabels`: screen positions, interleaved. */
  screen: Float32Array
  /** Written by `layoutLabels`: 1 visible, 0 hidden. */
  visible: Uint8Array
  /** Visibility from the previous pass, for the tie-break. */
  previous: Uint8Array
  /** Scratch: slot indices ordered by left edge. */
  order: Uint32Array
  count: number
}

/** Allocates the buffers for a pool of `capacity` labels. */
export function createLabelLayoutBuffers (capacity: number): LabelLayoutBuffers {
  return {
    anchors: new Float32Array(capacity * 2),
    sizes: new Float32Array(capacity * 2),
    priorities: new Float32Array(capacity),
    forced: new Uint8Array(capacity),
    screen: new Float32Array(capacity * 2),
    visible: new Uint8Array(capacity),
    previous: new Uint8Array(capacity),
    order: new Uint32Array(capacity),
    count: 0,
  }
}

/**
 * Projects every anchor and resolves overlaps, in place.
 *
 * Same rules as `resolveCollisions`: off-screen labels drop, the higher
 * priority of an overlapping pair wins, a tie goes to whichever was visible
 * last time, and a forced label survives losing unless the winner is forced
 * too.
 *
 * Marked as a worklet so Reanimated will run it on the UI thread. Allocates
 * nothing, so it is safe to call at display refresh.
 */
export function layoutLabels (buffers: LabelLayoutBuffers, view: ViewProjection): void {
  'worklet'
  const { anchors, sizes, priorities, forced, screen, visible, previous, order } = buffers
  const count = buffers.count

  for (let i = 0; i < count; i++) {
    const [screenX, screenY] = projectViewPoint(view, anchors[i * 2] as number, anchors[i * 2 + 1] as number)
    screen[i * 2] = screenX
    screen[i * 2 + 1] = screenY
    const onScreen =
      Number.isFinite(screenX) && Number.isFinite(screenY) &&
      screenX > 0 && screenY > 0 &&
      screenX < view.screenWidth && screenY < view.screenHeight
    visible[i] = onScreen ? 1 : 0
    order[i] = i
  }

  // Insertion sort by left edge. The order barely changes between frames, so
  // on a nearly-sorted array this beats a comparator sort and allocates
  // nothing — which a `[...boxes].sort()` cannot claim.
  for (let i = 1; i < count; i++) {
    const slot = order[i] as number
    const left = (screen[slot * 2] as number) - (sizes[slot * 2] as number) / 2
    let j = i - 1
    while (j >= 0) {
      const other = order[j] as number
      const otherLeft = (screen[other * 2] as number) - (sizes[other * 2] as number) / 2
      if (otherLeft <= left) break
      order[j + 1] = other
      j--
    }
    order[j + 1] = slot
  }

  for (let i = 0; i < count; i++) {
    const first = order[i] as number
    if (visible[first] === 0) continue
    const firstHalf = (sizes[first * 2] as number) / 2
    const firstLeft = (screen[first * 2] as number) - firstHalf
    const firstRight = (screen[first * 2] as number) + firstHalf
    const firstBottom = screen[first * 2 + 1] as number
    const firstTop = firstBottom - (sizes[first * 2 + 1] as number)

    for (let j = i + 1; j < count; j++) {
      const second = order[j] as number
      const secondHalf = (sizes[second * 2] as number) / 2
      const secondLeft = (screen[second * 2] as number) - secondHalf
      // Sorted by left edge: nothing after this can overlap either.
      if (secondLeft > firstRight) break
      if (visible[second] === 0) continue

      const secondBottom = screen[second * 2 + 1] as number
      const secondTop = secondBottom - (sizes[second * 2 + 1] as number)
      if (secondTop > firstBottom || firstTop > secondBottom) continue
      if ((screen[second * 2] as number) + secondHalf < firstLeft) continue

      const preferSecond =
        (priorities[second] as number) > (priorities[first] as number) ||
        ((priorities[second] as number) === (priorities[first] as number) &&
          forced[first] === 0 && forced[second] === 0 &&
          previous[second] === 1 && previous[first] === 0)

      const winner = preferSecond ? second : first
      const loser = preferSecond ? first : second
      visible[loser] = forced[winner] === 1 ? 0 : ((forced[loser] ?? 0) as number)

      if (visible[first] === 0) break
    }
  }

  for (let i = 0; i < count; i++) previous[i] = (visible[i] ?? 0) as number
}
