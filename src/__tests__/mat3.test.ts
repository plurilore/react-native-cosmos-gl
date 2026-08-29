import { describe, it, expect } from 'vitest'
import * as mat3 from '../core/mat3'

describe('mat3', () => {
  it('creates an identity that leaves points unchanged', () => {
    const m = mat3.create()
    expect(mat3.applyToPoint(m, 3, 7)).toEqual([3, 7])
  })

  it('translates and scales in the order the view chain relies on', () => {
    const m = mat3.create()
    mat3.translate(m, m, 10, 20)
    mat3.scale(m, m, 2, 2)
    // Post-multiplication: the scale applies to the point first, then the shift.
    expect(mat3.applyToPoint(m, 1, 1)).toEqual([12, 22])
  })

  it('inverts', () => {
    const m = mat3.create()
    mat3.translate(m, m, 5, -3)
    mat3.scale(m, m, 2, 4)
    const inverse = mat3.invert(mat3.create(), m)
    expect(inverse).not.toBeNull()
    const [x, y] = mat3.applyToPoint(m, 2, 3)
    const [ix, iy] = mat3.applyToPoint(inverse as mat3.Mat3, x, y)
    expect(ix).toBeCloseTo(2, 5)
    expect(iy).toBeCloseTo(3, 5)
  })

  it('reports a singular matrix instead of emitting NaN', () => {
    const m = mat3.create()
    mat3.scale(m, m, 0, 0)
    expect(mat3.invert(mat3.create(), m)).toBeNull()
  })

  it('projects pixel space onto clip space with Y pointing down', () => {
    // The matrix is a Float32Array, matching what a GLSL uniform receives, so
    // the corners land within float32 epsilon rather than exactly.
    const m = mat3.projection(mat3.create(), 800, 600)
    const corners: [number, number, number, number][] = [
      [0, 0, -1, 1],
      [800, 600, 1, -1],
      [400, 300, 0, 0],
    ]
    for (const [px, py, ex, ey] of corners) {
      const [x, y] = mat3.applyToPoint(m, px, py)
      expect(x).toBeCloseTo(ex, 6)
      expect(y).toBeCloseTo(ey, 6)
    }
  })

  it('widens to a mat4 keeping column-major order and a homogeneous last column', () => {
    const m = mat3.create()
    mat3.translate(m, m, 7, 9)
    const m4 = mat3.toMat4Array(m)
    expect(m4).toHaveLength(16)
    expect(m4.slice(0, 3)).toEqual([m[0], m[1], m[2]])
    expect(m4.slice(12)).toEqual([0, 0, 0, 1])
    expect([m4[3], m4[7], m4[11]]).toEqual([0, 0, 0])
  })
})
