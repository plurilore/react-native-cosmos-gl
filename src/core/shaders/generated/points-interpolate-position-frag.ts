// Generated from shaders/Points/interpolate-position.frag by scripts/build-shaders.mjs. Do not edit.
// Derived from cosmos.gl (https://github.com/cosmosgl/graph), MIT licensed.
export const pointsInterpolatePositionFrag = `#version 300 es
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

uniform sampler2D sourceTexture;
uniform sampler2D targetTexture;

#ifdef USE_UNIFORM_BUFFERS
layout(std140) uniform interpolatePositionUniforms {
  float progress;
} interpolatePosition;

#define progress interpolatePosition.progress
#else
uniform float progress;
#endif

out vec4 fragColor;

void main() {
  ivec2 pointTexel = ivec2(gl_FragCoord.xy);

  vec4 source = texelFetch(sourceTexture, pointTexel, 0);
  vec4 target = texelFetch(targetTexture, pointTexel, 0);
  // NaN means absent (ingest normalizes half-NaN to full-NaN, so checking one
  // channel suffices). Hold the real side so the point stays put while it fades,
  // never interpolating to/from NaN:
  //   · exiting  (target NaN): freeze at source.
  //   · entering (source NaN): appear at target (no slide in from NaN).
  vec2 src = cosmosIsNaN(source.r) ? target.rg : source.rg;
  vec2 tgt = cosmosIsNaN(target.r) ? src : target.rg;
  vec2 position = mix(src, tgt, progress);
  fragColor = vec4(position, source.b, 1.0);
}
`
export default pointsInterpolatePositionFrag
