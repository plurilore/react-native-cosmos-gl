// Generated from shaders/Points/fill-picking-buffer.frag by scripts/build-shaders.mjs. Do not edit.
// Derived from cosmos.gl (https://github.com/cosmosgl/graph), MIT licensed.
export const pointsFillPickingBufferFrag = `#version 300 es
#ifdef GL_ES
precision highp float;
#endif

in vec4 rgba;

out vec4 fragColor;

void main() {
  // Circular sprite: hover is radius-based, like the rendered point shape.
  vec2 fromCenter = 2.0 * gl_PointCoord - 1.0;
  if (dot(fromCenter, fromCenter) > 1.0) discard;
  fragColor = rgba;
}
`
export default pointsFillPickingBufferFrag
