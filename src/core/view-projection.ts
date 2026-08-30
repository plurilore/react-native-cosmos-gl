/**
 * Simulation space to screen pixels, without the engine.
 *
 * A plain function over plain numbers so it can run wherever the caller needs
 * it — including a Reanimated worklet on the UI thread, which cannot call into
 * the graph at all. `Graph.getViewProjection()` supplies the numbers; a test
 * pins this against `Graph.spaceToScreenPosition` so the two cannot drift.
 */

/** Everything needed to project a point, as data rather than behaviour. */
export type ViewProjection = {
  /** Zoom level. */
  k: number
  /** Pan, screen pixels. */
  x: number
  y: number
  /** Space→screen offsets, from the screen size and the space size. */
  offsetX: number
  offsetY: number
  /** The space's extent, which the Y flip is measured from. */
  spaceSize: number
  screenWidth: number
  screenHeight: number
}

/**
 * Projects one point. Marked as a worklet so Reanimated will run it on the UI
 * thread; harmless everywhere else.
 */
export function projectViewPoint (
  view: ViewProjection,
  worldX: number,
  worldY: number
): [number, number] {
  'worklet'
  return [
    (worldX + view.offsetX) * view.k + view.x,
    // Y is inverted: simulation space has Y up, the screen has Y down.
    (view.spaceSize - worldY + view.offsetY) * view.k + view.y,
  ]
}
