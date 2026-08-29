import type { Hovered } from '../store'

/**
 * The picking buffer renders at a fraction of screen resolution — a few pixels
 * of tolerance is plenty, and an rgba32float buffer at full device resolution
 * would cost tens of megabytes.
 */
export const PICKING_RESOLUTION_SCALE = 0.5

/** Hard cap on picking-buffer dimensions, bounding memory on large screens. */
export const MAX_PICKING_BUFFER_DIMENSION = 1536

/**
 * Edge of the square window read around the pointer, in picking-buffer pixels.
 * Its half is the pick "forgiveness" radius.
 *
 * Larger than the web engine's window: a fingertip covers far more screen than
 * a cursor hotspot, and a tap that lands a few pixels off the point it aimed at
 * should still select it.
 */
export const PICKING_WINDOW_SIZE = 13

/** A pointer-centred read window into the picking buffer, in buffer pixels. */
export type PickingWindow = {
  /** Bottom-left corner of the clamped window. */
  x: number
  y: number
  /** Unclamped pointer position in buffer pixels; may sit outside the window at edges. */
  centerX: number
  centerY: number
}

/** Element-wise equality for two numeric arrays, used to diff the view transform. */
export function numberArraysEqual (a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Picking-buffer dimensions for a screen size: a fraction of the screen, capped
 * absolutely, and never smaller than a single read window.
 */
export function getPickingBufferSize (screenWidth: number, screenHeight: number): { width: number; height: number } {
  const scale = Math.min(
    PICKING_RESOLUTION_SCALE,
    MAX_PICKING_BUFFER_DIMENSION / Math.max(screenWidth, screenHeight, 1)
  )
  return {
    width: Math.max(PICKING_WINDOW_SIZE, Math.ceil(screenWidth * scale)),
    height: Math.max(PICKING_WINDOW_SIZE, Math.ceil(screenHeight * scale)),
  }
}

/**
 * Maps the pointer (bottom-left-origin pixels, matching framebuffer
 * orientation) into a window clamped inside the buffer.
 */
export function getPickingWindow (
  bufferWidth: number,
  bufferHeight: number,
  pointerX: number,
  pointerY: number,
  screenWidth: number,
  screenHeight: number
): PickingWindow {
  const centerX = pointerX * (bufferWidth / screenWidth)
  const centerY = pointerY * (bufferHeight / screenHeight)
  const half = Math.floor(PICKING_WINDOW_SIZE / 2)
  const x = Math.min(Math.max(Math.round(centerX) - half, 0), bufferWidth - PICKING_WINDOW_SIZE)
  const y = Math.min(Math.max(Math.round(centerY) - half, 0), bufferHeight - PICKING_WINDOW_SIZE)
  return { x, y, centerX, centerY }
}

/**
 * Scans a window of `[index, x, y, _]` pixels and returns the valid candidate
 * nearest the pointer, or `undefined` when the window holds none.
 *
 * `cursorX` / `cursorY` are window-local buffer pixels.
 */
export function resolveNearestPickedPoint (
  pixels: Float32Array,
  cursorX: number,
  cursorY: number
): Hovered | undefined {
  let bestIndex = -1
  let bestPosition: [number, number] = [0, 0]
  let bestDistanceSq = Infinity
  for (let py = 0; py < PICKING_WINDOW_SIZE; py += 1) {
    for (let px = 0; px < PICKING_WINDOW_SIZE; px += 1) {
      const offset = (py * PICKING_WINDOW_SIZE + px) * 4
      const index = pixels[offset] as number
      if (index < 0) continue
      // Pixel centres sit at +0.5.
      const dx = px + 0.5 - cursorX
      const dy = py + 0.5 - cursorY
      const distanceSq = dx * dx + dy * dy
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq
        bestIndex = index
        bestPosition = [pixels[offset + 1] as number, pixels[offset + 2] as number]
      }
    }
  }
  if (bestIndex < 0) return undefined
  return { index: bestIndex, position: bestPosition }
}
