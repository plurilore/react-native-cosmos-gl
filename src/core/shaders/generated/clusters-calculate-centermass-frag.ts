// Generated from shaders/Clusters/calculate-centermass.frag by scripts/build-shaders.mjs. Do not edit.
// Derived from cosmos.gl (https://github.com/cosmosgl/graph), MIT licensed.
export const clustersCalculateCentermassFrag = `#version 300 es
#ifdef GL_ES
precision highp float;
#endif

in vec4 rgba;

out vec4 fragColor;

void main() {
  fragColor = rgba;
}
`
export default clustersCalculateCentermassFrag
