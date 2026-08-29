// Generated from shaders/ForceCollision/build-grid.frag by scripts/build-shaders.mjs. Do not edit.
// Derived from cosmos.gl (https://github.com/cosmosgl/graph), MIT licensed.
export const forceCollisionBuildGridFrag = `#version 300 es
precision highp float;

in vec4 cellData;
out vec4 fragColor;

void main() {
  // Output accumulated cell data (blended additively)
  // xy = sum of positions, z = sum of sizes, w = count
  fragColor = cellData;
}
`
export default forceCollisionBuildGridFrag
