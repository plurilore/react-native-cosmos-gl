/**
 * Compatibility name for the single-surface label adapter.
 *
 * Skia is used only to rasterize missing strings into CPU alpha patches. The
 * graph owns the atlas and draws labels in its existing GL framebuffer; this
 * module mounts no Canvas and has no Reanimated dependency.
 */
export {
  CosmosInlineSkiaLabels as CosmosSkiaLabels,
  type CosmosInlineSkiaLabelsProps as CosmosSkiaLabelsProps,
  type LabelPerformanceSample,
} from './CosmosInlineSkiaLabels'
