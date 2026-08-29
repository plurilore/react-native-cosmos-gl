// Generated from shaders/Shared/quad.vert by scripts/build-shaders.mjs. Do not edit.
// Derived from cosmos.gl (https://github.com/cosmosgl/graph), MIT licensed.
export const sharedQuadVert = `#version 300 es
#ifdef GL_ES
precision highp float;
#endif

in vec2 vertexCoord; // Vertex coordinates in normalized device coordinates

void main() {
    gl_Position = vec4(vertexCoord, 0, 1);
}
`
export default sharedQuadVert
