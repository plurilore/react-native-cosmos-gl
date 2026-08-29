import { isPointAbsent } from '../helper'

/**
 * Builds RGBA32F texture data from a flat `[x, y, x, y, …]` positions array.
 *
 * Layout per texel is `[x, y, index, 0]`. The blue channel carries the point
 * index so `drag-point.frag` can match the drag target by identity rather than
 * by texel, which stays correct as the grid relayouts.
 */
export function buildPositionTextureData (
  pointPositions: Float32Array | undefined,
  pointsTextureSize: number,
  pointsNumber: number
): Float32Array {
  const positionData = new Float32Array(pointsTextureSize * pointsTextureSize * 4)
  if (!pointPositions) return positionData

  for (let i = 0; i < pointsNumber; ++i) {
    // Normalize a half-NaN position to fully NaN: absence is all-or-nothing by
    // the time it reaches the GPU, so shaders can test a single channel.
    const absent = isPointAbsent(pointPositions, i)
    positionData[i * 4 + 0] = absent ? NaN : (pointPositions[i * 2 + 0] as number)
    positionData[i * 4 + 1] = absent ? NaN : (pointPositions[i * 2 + 1] as number)
    positionData[i * 4 + 2] = i
  }

  return positionData
}

/**
 * Builds the transition's source-position texture when the point count changed.
 *
 * Surviving indices carry over their on-screen positions, so the animation
 * starts from where each point actually was. Indices beyond the old count start
 * at their target, so new points appear in place rather than sliding in from
 * the origin.
 */
export function buildSourcePositionTextureData (
  previousPositionPixels: Float32Array,
  targetData: Float32Array,
  sharedCount: number,
  targetCount: number,
  newTextureSize: number
): Float32Array {
  const sourceData = new Float32Array(newTextureSize * newTextureSize * 4)

  for (let i = 0; i < sharedCount; i += 1) {
    sourceData[i * 4 + 0] = previousPositionPixels[i * 4 + 0] as number
    sourceData[i * 4 + 1] = previousPositionPixels[i * 4 + 1] as number
    sourceData[i * 4 + 2] = i
  }

  for (let i = sharedCount; i < targetCount; i += 1) {
    sourceData[i * 4 + 0] = targetData[i * 4 + 0] as number
    sourceData[i * 4 + 1] = targetData[i * 4 + 1] as number
    sourceData[i * 4 + 2] = i
  }

  return sourceData
}
