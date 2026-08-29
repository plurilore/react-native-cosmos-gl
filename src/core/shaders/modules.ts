/**
 * Shared GLSL fragments included by more than one shader.
 *
 * luma.gl solves this with its `ShaderModule` system; here it is plain string
 * composition, which is all the engine needs and keeps the generated shader
 * text exactly what gets compiled.
 */

/**
 * A rational quadratic Bézier evaluated at `t`.
 *
 * The `w` weight is what makes it *rational* rather than a plain quadratic: it
 * pulls the curve toward the control point without moving the endpoints, so
 * link curvature can be tuned by a single uniform.
 */
export const conicParametricCurveGLSL = /* glsl */ `
vec2 conicParametricCurve(vec2 A, vec2 B, vec2 ControlPoint, float t, float w) {
  vec2 divident = (1.0 - t) * (1.0 - t) * A + 2.0 * (1.0 - t) * t * w * ControlPoint + t * t * B;
  float divisor = (1.0 - t) * (1.0 - t) + 2.0 * (1.0 - t) * t * w + t * t;
  return divident / divisor;
}
`

/**
 * Splices shared GLSL into a shader after its preamble.
 *
 * `#version` must be the first token in a GLSL source and `precision`
 * declarations have to precede any definition, so the insertion point is the
 * end of that run of directives rather than the top of the file.
 */
export function withShaderModules (source: string, ...modules: string[]): string {
  if (modules.length === 0) return source
  const lines = source.split('\n')
  let insertAt = 0
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (
      line.startsWith('#version') || line.startsWith('precision') ||
      line.startsWith('#ifdef') || line.startsWith('#endif') ||
      line.startsWith('//') || line === ''
    ) {
      insertAt = i + 1
    } else break
  }
  lines.splice(insertAt, 0, ...modules)
  return lines.join('\n')
}
