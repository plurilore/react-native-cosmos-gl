/**
 * The 3×3 affine transform math the view needs, in column-major order — the
 * layout GLSL's `mat3` expects, so a matrix goes to a uniform without a
 * transpose.
 *
 * ```
 * [m0 m3 m6]     stored as [m0, m1, m2, m3, m4, m5, m6, m7, m8]
 * [m1 m4 m7]
 * [m2 m5 m8]
 * ```
 *
 * This exists instead of a `gl-matrix` dependency: the engine uses six
 * operations on one matrix shape, and a React Native library that ships with no
 * runtime dependencies is meaningfully easier to adopt.
 */
export type Mat3 = Float32Array

/** A 4×4 matrix as 16 numbers, column-major — the std140-friendly uniform form. */
export type Mat4Array = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
]

export function create (): Mat3 {
  const out = new Float32Array(9)
  out[0] = 1
  out[4] = 1
  out[8] = 1
  return out
}

export function identity (out: Mat3): Mat3 {
  out[0] = 1; out[1] = 0; out[2] = 0
  out[3] = 0; out[4] = 1; out[5] = 0
  out[6] = 0; out[7] = 0; out[8] = 1
  return out
}

export function copy (out: Mat3, source: Mat3): Mat3 {
  out.set(source)
  return out
}

/** `out = a * b`. */
export function multiply (out: Mat3, a: Mat3, b: Mat3): Mat3 {
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!
  const a10 = a[3]!, a11 = a[4]!, a12 = a[5]!
  const a20 = a[6]!, a21 = a[7]!, a22 = a[8]!

  const b00 = b[0]!, b01 = b[1]!, b02 = b[2]!
  const b10 = b[3]!, b11 = b[4]!, b12 = b[5]!
  const b20 = b[6]!, b21 = b[7]!, b22 = b[8]!

  out[0] = b00 * a00 + b01 * a10 + b02 * a20
  out[1] = b00 * a01 + b01 * a11 + b02 * a21
  out[2] = b00 * a02 + b01 * a12 + b02 * a22
  out[3] = b10 * a00 + b11 * a10 + b12 * a20
  out[4] = b10 * a01 + b11 * a11 + b12 * a21
  out[5] = b10 * a02 + b11 * a12 + b12 * a22
  out[6] = b20 * a00 + b21 * a10 + b22 * a20
  out[7] = b20 * a01 + b21 * a11 + b22 * a21
  out[8] = b20 * a02 + b21 * a12 + b22 * a22
  return out
}

/** Post-multiplies `a` by a translation. */
export function translate (out: Mat3, a: Mat3, x: number, y: number): Mat3 {
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!
  const a10 = a[3]!, a11 = a[4]!, a12 = a[5]!
  const a20 = a[6]!, a21 = a[7]!, a22 = a[8]!

  out[0] = a00; out[1] = a01; out[2] = a02
  out[3] = a10; out[4] = a11; out[5] = a12
  out[6] = x * a00 + y * a10 + a20
  out[7] = x * a01 + y * a11 + a21
  out[8] = x * a02 + y * a12 + a22
  return out
}

/** Post-multiplies `a` by a scale. */
export function scale (out: Mat3, a: Mat3, x: number, y: number): Mat3 {
  out[0] = x * a[0]!; out[1] = x * a[1]!; out[2] = x * a[2]!
  out[3] = y * a[3]!; out[4] = y * a[4]!; out[5] = y * a[5]!
  out[6] = a[6]!; out[7] = a[7]!; out[8] = a[8]!
  return out
}

/** Inverts `a` into `out`. Returns `null` when `a` is singular. */
export function invert (out: Mat3, a: Mat3): Mat3 | null {
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!
  const a10 = a[3]!, a11 = a[4]!, a12 = a[5]!
  const a20 = a[6]!, a21 = a[7]!, a22 = a[8]!

  const b01 = a22 * a11 - a12 * a21
  const b11 = -a22 * a10 + a12 * a20
  const b21 = a21 * a10 - a11 * a20

  const det = a00 * b01 + a01 * b11 + a02 * b21
  if (!det) return null
  const invDet = 1 / det

  out[0] = b01 * invDet
  out[1] = (-a22 * a01 + a02 * a21) * invDet
  out[2] = (a12 * a01 - a02 * a11) * invDet
  out[3] = b11 * invDet
  out[4] = (a22 * a00 - a02 * a20) * invDet
  out[5] = (-a12 * a00 + a02 * a10) * invDet
  out[6] = b21 * invDet
  out[7] = (-a21 * a00 + a01 * a20) * invDet
  out[8] = (a11 * a00 - a01 * a10) * invDet
  return out
}

/** Applies `m` to the 2D point `(x, y)`, treating it as `(x, y, 1)`. */
export function applyToPoint (m: Mat3, x: number, y: number): [number, number] {
  return [
    m[0]! * x + m[3]! * y + m[6]!,
    m[1]! * x + m[4]! * y + m[7]!,
  ]
}

/**
 * Widens a 3×3 to a 4×4 for the shader uniform.
 *
 * A `mat3` uniform under std140 pads each column to 16 bytes, giving a 48-byte
 * block that drivers have historically disagreed about. `mat4` is a clean 64
 * bytes, behaves identically everywhere, and the shader recovers the 3×3 with
 * `mat3(transformationMatrix)`.
 */
export function toMat4Array (m: Mat3): Mat4Array {
  return [
    m[0]!, m[1]!, m[2]!, 0,
    m[3]!, m[4]!, m[5]!, 0,
    m[6]!, m[7]!, m[8]!, 0,
    0, 0, 0, 1,
  ]
}

/**
 * A pixel-space → clip-space projection: `(0, 0)` maps to the top-left corner
 * `(-1, 1)` and `(width, height)` to the bottom-right `(1, -1)`.
 *
 * Matches `gl-matrix`'s `mat3.projection`, which the upstream view transform is
 * built on, so the composed chain behaves identically.
 */
export function projection (out: Mat3, width: number, height: number): Mat3 {
  out[0] = 2 / width; out[1] = 0; out[2] = 0
  out[3] = 0; out[4] = -2 / height; out[5] = 0
  out[6] = -1; out[7] = 1; out[8] = 1
  return out
}
