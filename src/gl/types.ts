/**
 * Shared GL types.
 *
 * The engine talks to the GPU exclusively through this layer, never through a
 * DOM-bound helper library. That is what lets the same core run on an `expo-gl`
 * context (iOS/Android) and on a browser `<canvas>` without branching.
 */

/**
 * A WebGL2 context. Deliberately typed structurally rather than as the DOM's
 * `WebGL2RenderingContext`: `expo-gl`'s context is API-compatible but is not an
 * instance of the DOM class, and React Native has no DOM lib at all.
 */
export type GL = WebGL2RenderingContext

/** Numeric texture formats the engine uses, named rather than raw GL enums. */
export type TextureFormat =
  | 'rgba32float'
  | 'rgba16float'
  | 'rgba8unorm'
  | 'r8unorm'
  | 'rg32float'
  | 'r32float'

export type TextureFilter = 'nearest' | 'linear'

export type BlendFactor =
  | 'zero'
  | 'one'
  | 'src-alpha'
  | 'one-minus-src-alpha'
  | 'dst-alpha'
  | 'one-minus-dst-alpha'

export type DepthCompare = 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'always'

/**
 * Fixed-function state for a draw. Mirrors the subset of luma.gl's
 * `RenderPipelineParameters` the engine actually varies, so the ported modules
 * read the same as upstream.
 */
export type PipelineParameters = {
  blend?: boolean
  blendColorSrcFactor?: BlendFactor
  blendColorDstFactor?: BlendFactor
  blendAlphaSrcFactor?: BlendFactor
  blendAlphaDstFactor?: BlendFactor
  depthTest?: boolean
  depthWriteEnabled?: boolean
  depthCompare?: DepthCompare
}

/** A value assignable to a `uniform` by name. */
export type UniformValue =
  | number
  | boolean
  | readonly number[]
  | Float32Array
  | Int32Array

export type UniformMap = Record<string, UniformValue | undefined>

/** Primitive topology for a draw call. */
export type Topology = 'triangle-strip' | 'triangle-list' | 'point-list' | 'line-list'

/** Per-attribute vertex buffer binding. */
export type AttributeBinding = {
  buffer: import('./buffer').GLBuffer
  /** Components per vertex (1–4). */
  size: number
  /** Bytes between consecutive elements; 0 = tightly packed. */
  stride?: number
  /** Byte offset of the first element. */
  offset?: number
  /** Advance once per instance rather than per vertex. */
  divisor?: number
  /** Element type; defaults to FLOAT. */
  type?: 'float' | 'int' | 'uint'
}
