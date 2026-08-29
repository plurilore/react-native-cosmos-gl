// Generated from shaders/ForceManyBody/build-nearfield-slots.frag by scripts/build-shaders.mjs. Do not edit.
// Derived from cosmos.gl (https://github.com/cosmosgl/graph), MIT licensed.
export const forceManyBodyBuildNearfieldSlotsFrag = `#version 300 es
precision highp float;

in vec2 slotData;
out vec4 fragColor;

void main() {
  fragColor = vec4(slotData, 0.0, 0.0);
}
`
export default forceManyBodyBuildNearfieldSlotsFrag
