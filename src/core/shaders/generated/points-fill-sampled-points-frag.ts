// Generated from shaders/Points/fill-sampled-points.frag by scripts/build-shaders.mjs. Do not edit.
// Derived from cosmos.gl (https://github.com/cosmosgl/graph), MIT licensed.
export const pointsFillSampledPointsFrag = `#version 300 es
#ifdef GL_ES
precision highp float;
#endif

in vec4 rgba;

out vec4 fragColor;

void main() {
  fragColor = rgba;
}
`
export default pointsFillSampledPointsFrag
