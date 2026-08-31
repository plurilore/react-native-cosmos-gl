// Generated from shaders/Labels/draw-labels.frag by scripts/build-shaders.mjs. Do not edit.
// Derived from cosmos.gl (https://github.com/cosmosgl/graph), MIT licensed.
export const labelsDrawLabelsFrag = `#version 300 es
#ifdef GL_ES
precision highp float;
#endif

uniform sampler2D labelAtlas;

in vec2 atlasUv;
in vec2 localPosition;
in vec2 instanceSize;
in vec4 textColor;
in vec4 chipColor;
in float cornerRadius;

out vec4 fragColor;

float roundedRectangleAlpha(vec2 pixel, vec2 size, float radius) {
  if (radius <= 0.0) return 1.0;
  vec2 halfSize = size * 0.5;
  vec2 q = abs(pixel - halfSize) - (halfSize - vec2(radius));
  float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  return 1.0 - smoothstep(-fwidth(distance), fwidth(distance), distance);
}

void main() {
  float glyphAlpha = texture(labelAtlas, atlasUv).r * textColor.a;
  float backgroundAlpha = chipColor.a * roundedRectangleAlpha(localPosition, instanceSize, cornerRadius);
  float alpha = glyphAlpha + backgroundAlpha * (1.0 - glyphAlpha);
  if (alpha <= 0.001) discard;

  vec3 premultiplied =
    textColor.rgb * glyphAlpha +
    chipColor.rgb * backgroundAlpha * (1.0 - glyphAlpha);
  fragColor = vec4(premultiplied / alpha, alpha);
}
`
export default labelsDrawLabelsFrag
