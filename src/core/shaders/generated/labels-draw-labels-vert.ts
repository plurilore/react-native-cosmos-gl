// Generated from shaders/Labels/draw-labels.vert by scripts/build-shaders.mjs. Do not edit.
// Derived from cosmos.gl (https://github.com/cosmosgl/graph), MIT licensed.
export const labelsDrawLabelsVert = `#version 300 es
#ifdef GL_ES
precision highp float;
#endif


// Injected by scripts/build-shaders.mjs — see NAN_HELPERS there for why the
// built-in isnan() is not used.
bool cosmosIsNaN(float x) {
  uint bits = floatBitsToUint(x);
  return (bits & 0x7F800000u) == 0x7F800000u && (bits & 0x007FFFFFu) != 0u;
}
bvec2 cosmosIsNaN(vec2 v) { return bvec2(cosmosIsNaN(v.x), cosmosIsNaN(v.y)); }
bvec3 cosmosIsNaN(vec3 v) { return bvec3(cosmosIsNaN(v.x), cosmosIsNaN(v.y), cosmosIsNaN(v.z)); }
bvec4 cosmosIsNaN(vec4 v) { return bvec4(cosmosIsNaN(v.x), cosmosIsNaN(v.y), cosmosIsNaN(v.z), cosmosIsNaN(v.w)); }

in vec2 vertexCoord;
in float labelPointIndex;
in vec2 labelAnchor;
in vec2 labelSize;
in vec4 labelUvRect;
in float labelVisible;
in vec4 labelTextColor;
in vec4 labelChipColor;
in float labelPointRadius;
in float labelMargin;
in float labelCornerRadius;

uniform sampler2D positionsTexture;
uniform float pointsTextureSize;
uniform float pointsNumber;
uniform float spaceSize;
uniform vec2 screenSize;
uniform vec2 spaceOffsets;
uniform vec3 viewTransform;

out vec2 atlasUv;
out vec2 localPosition;
out vec2 instanceSize;
out vec4 textColor;
out vec4 chipColor;
out float cornerRadius;

void main() {
  bool usesPoint = labelPointIndex >= 0.0;
  vec2 anchor = labelAnchor;
  if (usesPoint) {
    int index = int(labelPointIndex + 0.5);
    if (index < 0 || float(index) >= pointsNumber) {
      gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
      return;
    }
    int textureSize = int(pointsTextureSize + 0.5);
    ivec2 texel = ivec2(index % textureSize, index / textureSize);
    anchor = texelFetch(positionsTexture, texel, 0).rg;
  }

  if (labelVisible < 0.5 || any(cosmosIsNaN(anchor)) || screenSize.x <= 0.0 || screenSize.y <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }

  vec2 unit = vertexCoord * 0.5 + 0.5;
  float screenX = (anchor.x + spaceOffsets.x) * viewTransform.x + viewTransform.y;
  float screenY = (spaceSize - anchor.y + spaceOffsets.y) * viewTransform.x + viewTransform.z;
  vec2 topLeft = vec2(
    screenX - labelSize.x * 0.5,
    screenY - labelPointRadius - labelMargin - labelSize.y
  );
  vec2 pixel = topLeft + unit * labelSize;

  gl_Position = vec4(
    pixel.x * 2.0 / screenSize.x - 1.0,
    1.0 - pixel.y * 2.0 / screenSize.y,
    0.0,
    1.0
  );
  atlasUv = mix(labelUvRect.xy, labelUvRect.zw, unit);
  localPosition = unit * labelSize;
  instanceSize = labelSize;
  textColor = labelTextColor;
  chipColor = labelChipColor;
  cornerRadius = labelCornerRadius;
}
`
export default labelsDrawLabelsVert
