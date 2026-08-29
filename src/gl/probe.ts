import type { GL } from './types'

/**
 * What a device can actually do, and whether the engine will run on it.
 *
 * This exists because the engine's requirements are not visible until something
 * fails deep inside a shader compile, by which point the error describes a
 * symptom rather than the cause. Running this first turns "the graph is blank"
 * into a specific, reportable answer — before any application code is written
 * against it.
 */
export type DeviceReport = {
  /** Whether the engine can run at all. */
  supported: boolean
  /** Why not, when `supported` is false. */
  blockers: string[]
  /** Things that work but in a degraded mode. */
  warnings: string[]

  isWebGL2: boolean
  /** `EXT_color_buffer_float` — full-precision float render targets. */
  renderToFloat32: boolean
  /** `EXT_color_buffer_half_float` — the degraded fallback. */
  renderToFloat16: boolean
  /** `EXT_float_blend` — additive blending into float targets. */
  floatBlend: boolean
  floatLinearFilter: boolean

  maxTextureSize: number
  maxTextureArrayLayers: number
  maxTextureUnits: number
  /** Largest point sprite the hardware will rasterize, in device pixels. */
  maxPointSize: number

  vendor: string
  renderer: string
  version: string
  shadingLanguageVersion: string

  /** Points this device should comfortably handle, given its texture limit. */
  estimatedMaxPoints: number
}

/**
 * Probes a live WebGL context.
 *
 * Cheap enough to run once at startup and report, but it does issue a dozen
 * synchronous `getParameter` calls, so it should not run per frame.
 */
export function probeDevice (gl: GL): DeviceReport {
  const has = (name: string): boolean => {
    try {
      return gl.getExtension(name) !== null
    } catch {
      return false
    }
  }
  const param = <T>(name: number, fallback: T): T => {
    try {
      const value = gl.getParameter(name) as T
      return value === null || value === undefined ? fallback : value
    } catch {
      return fallback
    }
  }
  const str = (name: number): string => {
    try {
      return String(gl.getParameter(name) ?? 'unknown')
    } catch {
      return 'unknown'
    }
  }

  // WebGL2 is checked by feature rather than by a version string: `expo-gl`
  // hands back an object whose shape is the real answer, and a device that fell
  // back to ES 2.0 still reports a plausible-looking version.
  const isWebGL2 = typeof gl.createVertexArray === 'function' &&
    typeof gl.texStorage3D === 'function' &&
    typeof gl.drawArraysInstanced === 'function'

  const renderToFloat32 = has('EXT_color_buffer_float')
  const renderToFloat16 = renderToFloat32 || has('EXT_color_buffer_half_float')
  const floatBlend = has('EXT_float_blend')
  const floatLinearFilter = has('OES_texture_float_linear')

  const maxTextureSize = param(gl.MAX_TEXTURE_SIZE, 0) as number
  const pointRange = param(gl.ALIASED_POINT_SIZE_RANGE, [1, 1]) as ArrayLike<number>

  const blockers: string[] = []
  const warnings: string[] = []

  if (!isWebGL2) {
    blockers.push(
      'Not a WebGL2 context. The shaders are GLSL ES 3.00 and the data lives in float ' +
      'textures, neither of which WebGL1 supports. On React Native this usually means the ' +
      'device gave expo-gl an OpenGL ES 2.0 context instead of ES 3.0.'
    )
  }
  if (!renderToFloat32 && !renderToFloat16) {
    blockers.push(
      'No float render targets (neither EXT_color_buffer_float nor ' +
      'EXT_color_buffer_half_float). The simulation stores positions and velocities in ' +
      'float textures and cannot run without one of them.'
    )
  }
  if (maxTextureSize < 2048) {
    blockers.push(`Maximum texture size is only ${maxTextureSize}; the engine needs at least 2048.`)
  }

  if (isWebGL2 && !renderToFloat32 && renderToFloat16) {
    warnings.push(
      'Only half-float render targets. Positions quantize to a 10-bit mantissa, so large ' +
      'graphs will look visibly stepped.'
    )
  }
  if (!floatBlend) {
    warnings.push(
      'No EXT_float_blend. Repulsion falls back to the exact all-pairs path at every graph ' +
      'size — correct, but O(n squared) — and the cluster and collision forces are skipped.'
    )
  }

  // One texel per point in a square texture, and the engine allocates roughly a
  // dozen such textures, so the practical ceiling is well under the theoretical
  // one. A quarter of the limit per axis is a conservative, honest figure.
  const estimatedMaxPoints = Math.floor(Math.pow(maxTextureSize / 4, 2))

  return {
    supported: blockers.length === 0,
    blockers,
    warnings,
    isWebGL2,
    renderToFloat32,
    renderToFloat16,
    floatBlend,
    floatLinearFilter,
    maxTextureSize,
    maxTextureArrayLayers: param(gl.MAX_ARRAY_TEXTURE_LAYERS, 0) as number,
    maxTextureUnits: param(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS, 0) as number,
    maxPointSize: pointRange[1] ?? 1,
    vendor: str(gl.VENDOR),
    renderer: str(gl.RENDERER),
    version: str(gl.VERSION),
    shadingLanguageVersion: str(gl.SHADING_LANGUAGE_VERSION),
    estimatedMaxPoints,
  }
}

/** Formats a report as plain text, for logging or pasting into an issue. */
export function formatDeviceReport (report: DeviceReport): string {
  const yes = (value: boolean): string => (value ? 'yes' : 'NO')
  const lines = [
    `supported:            ${report.supported ? 'YES' : 'NO'}`,
    `webgl2:               ${yes(report.isWebGL2)}`,
    `float render targets: ${report.renderToFloat32 ? 'rgba32f' : report.renderToFloat16 ? 'rgba16f only' : 'NONE'}`,
    `float blend:          ${yes(report.floatBlend)}`,
    `float linear filter:  ${yes(report.floatLinearFilter)}`,
    `max texture size:     ${report.maxTextureSize}`,
    `max point size:       ${report.maxPointSize}`,
    `est. max points:      ${report.estimatedMaxPoints.toLocaleString()}`,
    `renderer:             ${report.renderer}`,
    `vendor:               ${report.vendor}`,
    `gl version:           ${report.version}`,
    `glsl version:         ${report.shadingLanguageVersion}`,
  ]
  for (const blocker of report.blockers) lines.push(`BLOCKER: ${blocker}`)
  for (const warning of report.warnings) lines.push(`warning: ${warning}`)
  return lines.join('\n')
}
