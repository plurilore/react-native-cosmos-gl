/**
 * The label subsystem's vocabulary.
 *
 * Deliberately free of React, React Native and any renderer: what should be
 * drawn is a different question from how to draw it, and keeping them apart is
 * what lets the policy be tested without a GPU and reused by more than one
 * renderer.
 */

/**
 * Why a label is a candidate. The class decides its priority band, and which
 * classes exist at all depends on whether anything is selected.
 */
export type LabelClass =
  /** Sampled from the viewport grid — the shifting ones that fill empty space. */
  | 'dynamic'
  /** Highest-weighted points overall. Stable as the camera moves. */
  | 'top'
  /** Points in the active selection. */
  | 'selected'
  /** The one focused point. Outranks everything. */
  | 'focused'
  /** Named explicitly by the host, and shown even in cluster mode. */
  | 'forced'
  /** A cluster's centre of mass. */
  | 'cluster'
  /** Supplied wholesale by the host at an arbitrary position. */
  | 'custom'

/** A label the manager is considering, before collision. */
export type LabelCandidate = {
  /** Stable across frames, so hysteresis can recognise the same label again. */
  id: string
  kind: LabelClass
  /** Point index, or cluster index for `cluster`. `-1` for `custom`. */
  index: number
  text: string
  /** Simulation space. The camera projects it; the manager never does. */
  position: [number, number]
  /** Raw value from the weight column, before banding. */
  weight?: number
  /** Member count, for `cluster` — its priority scales with it. */
  count?: number
}

/** A candidate with its resolved priority, ready for collision. */
export type PrioritisedLabel = LabelCandidate & {
  /** Higher wins an overlap. */
  priority: number
  /** Survives collision even when it loses. */
  forceShow: boolean
}

/**
 * A label measured in screen pixels, for the collision pass.
 *
 * `x` is the horizontal centre and `y` the **bottom** edge — labels sit above
 * the thing they name, so that is the edge the anchor pins.
 */
export type LabelBox = {
  id: string
  x: number
  y: number
  width: number
  height: number
  priority: number
  forceShow: boolean
  /** Whether this label was visible last frame. Breaks ties, and stops flicker. */
  previouslyVisible: boolean
}

/** What the manager was asked to show. */
export type LabelPolicy = {
  showTopLabels?: boolean
  topLabelsLimit?: number
  showDynamicLabels?: boolean
  dynamicLabelsLimit?: number
  showSelectedLabels?: boolean
  selectedLabelsLimit?: number
  showClusterLabels?: boolean
  clusterLabelsLimit?: number
  showFocusedLabel?: boolean
  /** Point indices always labelled, cluster mode included. */
  showLabelsFor?: number[]
}
