// Derived from cosmos.gl (https://github.com/cosmosgl/graph), MIT licensed.

/**
 * The link spring force, parameterised by the maximum point degree.
 *
 * GLSL ES 3.00 requires loop bounds to be compile-time constants, so the
 * maximum number of links any one point can have is baked into the source and
 * the program is rebuilt whenever that maximum changes. The loop still exits
 * early per point via `i < linkAmount`; the constant only bounds the worst case.
 */
export function forceLinkSpringFrag (maxLinks: number): string {
  return `#version 300 es
precision highp float;

uniform sampler2D positionsTexture;
uniform sampler2D exitTexture;
uniform sampler2D linkInfoTexture;      // first link index and count, per point
uniform sampler2D linkIndicesTexture;   // connected point texel, per link
uniform sampler2D linkPropertiesTexture; // bias and strength, per link
uniform sampler2D linkRandomDistanceTexture;

uniform float linkSpring;
uniform float linkDistance;
uniform vec2 linkDistRandomVariationRange;
uniform float linksTextureSize;
uniform float alpha;

out vec4 fragColor;

const float MAX_LINKS = ${Number.isFinite(maxLinks) && maxLinks > 0 ? Math.ceil(maxLinks) : 1}.0;

void main() {
  ivec2 pointTexel = ivec2(gl_FragCoord.xy);

  vec4 pointPosition = texelFetch(positionsTexture, pointTexel, 0);
  vec4 velocity = vec4(0.0);

  vec4 linkInfo = texelFetch(linkInfoTexture, pointTexel, 0);
  float iCount = linkInfo.r;
  float jCount = linkInfo.g;
  float linkAmount = linkInfo.b;

  if (linkAmount > 0.0) {
    for (float i = 0.0; i < MAX_LINKS; i += 1.0) {
      if (i < linkAmount) {
        // The link list is stored row-major in a square texture; wrap to the
        // next row when the column runs past its width.
        if (iCount >= linksTextureSize) {
          iCount = 0.0;
          jCount += 1.0;
        }
        ivec2 linkTexel = ivec2(iCount, jCount);
        vec4 connectedPointIndex = texelFetch(linkIndicesTexture, linkTexel, 0);
        vec4 biasAndStrength = texelFetch(linkPropertiesTexture, linkTexel, 0);
        vec4 randomMinDistance = texelFetch(linkRandomDistanceTexture, linkTexel, 0);
        float bias = biasAndStrength.r;
        float strength = biasAndStrength.g;
        float randomMinLinkDist = randomMinDistance.r * (linkDistRandomVariationRange.g - linkDistRandomVariationRange.r) + linkDistRandomVariationRange.r;
        randomMinLinkDist *= linkDistance;

        iCount += 1.0;

        // linkIndicesTexture stores whole texel coordinates, so truncating is exact.
        ivec2 connectedTexel = ivec2(connectedPointIndex.rg);

        // Skip a link to an absent point — its NaN position would poison the
        // spring force for the point still present. (exit.G = current absence)
        vec4 connectedExit = texelFetch(exitTexture, connectedTexel, 0);
        if (connectedExit.g > 0.5) {
          continue;
        }

        vec4 connectedPointPosition = texelFetch(positionsTexture, connectedTexel, 0);
        float x = connectedPointPosition.x - (pointPosition.x + velocity.x);
        float y = connectedPointPosition.y - (pointPosition.y + velocity.y);
        float l = sqrt(x * x + y * y);

        // Floor the distance just below the rest length so an exactly
        // coincident pair cannot divide by zero.
        l = max(l, randomMinLinkDist * 0.99);
        l = (l - randomMinLinkDist) / l;
        l *= linkSpring * alpha;
        l *= strength;
        l *= bias;
        x *= l;
        y *= l;
        velocity.x += x;
        velocity.y += y;
      }
    }
  }

  fragColor = vec4(velocity.rg, 0.0, 0.0);
}
`
}
