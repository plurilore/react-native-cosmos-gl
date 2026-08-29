/**
 * Placement comparison for the label overlays.
 *
 * Its own module, free of React and React Native imports, so it can be tested
 * directly — the overlays themselves cannot be, since the test environment is
 * plain Node with no React Native resolution.
 */

/** A label positioned in screen pixels. */
export type PlacedLabel = {
  index: number
  text: string
  x: number
  y: number
}

/**
 * Whether two placements are the same to within half a pixel.
 *
 * The overlays recompute placement on a timer and would otherwise call
 * `setState` with a fresh array every tick, re-rendering every label for no
 * visible change — on the same JS thread that drives the frame loop, so it is
 * paid in frames. Sub-pixel movement is invisible but constant while a
 * simulation settles, which is why this is a tolerance and not an equality.
 */
export function isSamePlacement (a: PlacedLabel[], b: PlacedLabel[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i] as PlacedLabel
    const right = b[i] as PlacedLabel
    if (left.index !== right.index || left.text !== right.text) return false
    if (Math.abs(left.x - right.x) > 0.5 || Math.abs(left.y - right.y) > 0.5) return false
  }
  return true
}
