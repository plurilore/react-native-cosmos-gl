/**
 * Copying a selected label set into the flat buffers the layout pass reads.
 *
 * Its own module so it can be tested: this is where two coordinate systems
 * meet, and getting the conversion wrong is invisible until labels collide
 * against boxes three times the size of the text.
 */

import type { LabelLayoutBuffers } from './layout'
import type { MeasuredLabel } from './manager'
import type { LabelAtlasMetrics } from './metrics'

/** A cluster centroid, in simulation space. */
export type LabelCluster = { index: number; position: [number, number] }

/**
 * Fills the buffers, converting physical sizes back to logical points.
 *
 * The measured sizes arrive in physical pixels, because the atlas is baked in
 * them. Collision and projection both work in the logical screen space
 * `ViewProjection` reports, so mixing the two would inflate every collision box
 * by the device ratio and hide most of the labels on a dense screen.
 */
export function fillBuffers (
  buffers: LabelLayoutBuffers,
  labels: readonly MeasuredLabel[],
  anchors: Map<number, [number, number]>,
  sampled: Map<number, [number, number]>,
  clusters: readonly LabelCluster[] | undefined,
  metrics: LabelAtlasMetrics
): void {
  const { pixelRatio } = metrics
  const margin = metrics.margin / pixelRatio
  buffers.count = labels.length
  labels.forEach((label, index) => {
    const position =
      label.kind === 'cluster'
        ? clusters?.find((cluster) => cluster.index === label.index)?.position ?? label.position
        : anchors.get(label.index) ?? sampled.get(label.index) ?? label.position
    buffers.anchors[index * 2] = position[0]
    buffers.anchors[index * 2 + 1] = position[1]
    buffers.sizes[index * 2] = label.width / pixelRatio
    // The margin lifts the label clear of the point it names; folding it into
    // the height keeps the collision box and the drawn position agreeing.
    buffers.sizes[index * 2 + 1] = label.height / pixelRatio + margin
    buffers.priorities[index] = label.priority
    buffers.forced[index] = label.forceShow ? 1 : 0
  })
  for (let i = labels.length; i < buffers.visible.length; i++) buffers.visible[i] = 0
}
