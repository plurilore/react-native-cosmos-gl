export { LabelManager, type MeasureLabel, type ResolvedLabel } from './manager'
export { collectCandidates, trackedPointIndices, type LabelSource } from './candidates'
export { resolveCollisions } from './collision'
export {
  prioritise,
  clusterPriority,
  normaliseColumnWeight,
  countExtent,
  LABEL_PRIORITY_BAND,
  CLUSTER_PRIORITY_RANGE,
  COLUMN_WEIGHT_SPAN,
} from './weights'
export type {
  LabelBox,
  LabelCandidate,
  LabelClass,
  LabelPolicy,
  PrioritisedLabel,
} from './types'
