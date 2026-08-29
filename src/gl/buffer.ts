import type { Device } from './device'

export type BufferUsage = 'vertex' | 'index'

/**
 * A GPU buffer holding vertex attributes or element indices.
 *
 * `write` reuses the existing allocation whenever the incoming data still fits,
 * because reallocating is the expensive half of an upload and the engine
 * rewrites the same buffers every time data changes.
 */
export class GLBuffer {
  public readonly device: Device
  public readonly usage: BufferUsage
  public handle: WebGLBuffer | null
  public byteLength = 0
  public destroyed = false

  private readonly target: number
  /** Bytes currently allocated, which may exceed `byteLength` after a shrink. */
  private capacity = 0

  public constructor (device: Device, usage: BufferUsage, data?: ArrayBufferView | number) {
    this.device = device
    this.usage = usage
    const gl = device.gl
    this.target = usage === 'index' ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER
    this.handle = gl.createBuffer()

    if (typeof data === 'number') {
      this.allocate(data)
    } else if (data) {
      this.write(data)
    }
  }

  /** Reserves `byteLength` bytes of uninitialized storage. */
  public allocate (byteLength: number): void {
    if (this.destroyed || !this.handle) return
    const gl = this.device.gl
    gl.bindBuffer(this.target, this.handle)
    gl.bufferData(this.target, byteLength, gl.DYNAMIC_DRAW)
    this.capacity = byteLength
    this.byteLength = byteLength
  }

  /**
   * Uploads `data`, reallocating only when it no longer fits. `byteOffset`
   * writes into an existing allocation and never reallocates.
   */
  public write (data: ArrayBufferView, byteOffset = 0): void {
    if (this.destroyed || !this.handle) return
    const gl = this.device.gl
    gl.bindBuffer(this.target, this.handle)

    if (byteOffset === 0 && data.byteLength > this.capacity) {
      gl.bufferData(this.target, data as unknown as BufferSource, gl.DYNAMIC_DRAW)
      this.capacity = data.byteLength
      this.byteLength = data.byteLength
      return
    }

    gl.bufferSubData(this.target, byteOffset, data as unknown as BufferSource)
    this.byteLength = Math.max(this.byteLength, byteOffset + data.byteLength)
  }

  public destroy (): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.handle) this.device.gl.deleteBuffer(this.handle)
    this.handle = null
    this.byteLength = 0
    this.capacity = 0
  }
}

/**
 * Creates, resizes or rewrites a vertex buffer so it holds exactly `data`,
 * returning the buffer for the caller to assign back to its field.
 *
 * Mirrors cosmos.gl's `updateAttributeBuffer`, but reuses the allocation on a
 * size *decrease* too — `GLBuffer.write` tracks capacity separately from
 * length, so a shrinking graph does not churn GPU allocations.
 */
export function updateAttributeBuffer (
  device: Device,
  buffer: GLBuffer | undefined,
  data: ArrayBufferView
): GLBuffer {
  if (!buffer || buffer.destroyed) return new GLBuffer(device, 'vertex', data)
  buffer.write(data)
  // A shrink leaves stale bytes past the new length; record the real length so
  // draws derived from `byteLength` do not walk into them.
  buffer.byteLength = data.byteLength
  return buffer
}

/**
 * Maintains the source/target buffer pair behind an animated attribute.
 *
 * When the element count is unchanged the two buffers simply swap roles: last
 * frame's target becomes this frame's source, so a transition always starts
 * from what is currently on screen. When the count changed the pair is rebuilt,
 * carrying over the overlapping prefix so surviving elements animate from their
 * old value while new ones start at their final value.
 */
export function updateAttributeBuffers (
  device: Device,
  targetData: Float32Array,
  sourceBuffer: GLBuffer | undefined,
  targetBuffer: GLBuffer | undefined,
  previousData: Float32Array | undefined,
  tupleSize: 1 | 4
): { source: GLBuffer; target: GLBuffer; previous: Float32Array } {
  const oldCount = previousData ? previousData.length / tupleSize : 0
  const newCount = targetData.length / tupleSize
  const sameCount = oldCount === newCount

  if (
    sameCount &&
    sourceBuffer && !sourceBuffer.destroyed &&
    targetBuffer && !targetBuffer.destroyed
  ) {
    const nextSource = targetBuffer
    const nextTarget = sourceBuffer
    nextTarget.write(targetData)
    return { source: nextSource, target: nextTarget, previous: new Float32Array(targetData) }
  }

  const sourceData = new Float32Array(targetData.length)
  const sharedCount = Math.min(oldCount, newCount)
  const sharedValues = sharedCount * tupleSize
  for (let i = 0; i < sharedValues; i++) sourceData[i] = previousData?.[i] ?? targetData[i] ?? 0
  for (let i = sharedValues; i < targetData.length; i++) sourceData[i] = targetData[i] ?? 0

  sourceBuffer?.destroy()
  targetBuffer?.destroy()

  return {
    source: new GLBuffer(device, 'vertex', sourceData),
    target: new GLBuffer(device, 'vertex', targetData),
    previous: new Float32Array(targetData),
  }
}

/**
 * One (x, y) texel coordinate per texel of a `textureSize`² data texture, in
 * row-major order, so a draw of N vertices walks texels 0…N-1.
 *
 * The values are whole numbers exactly representable in float32, which is what
 * lets shaders read them back as `texelFetch(tex, ivec2(pointIndices), 0)`:
 * `ivec2` truncates, and truncating an exact integer is exact. Shaders must not
 * sample these textures with normalized coordinates instead — `index /
 * textureSize` lands on a texel *boundary*, where the sampler's floor can fall
 * to the previous texel and silently return another point's data.
 */
export function createIndexesForBuffer (textureSize: number): Float32Array {
  const indexes = new Float32Array(textureSize * textureSize * 2)
  for (let y = 0; y < textureSize; y++) {
    for (let x = 0; x < textureSize; x++) {
      const i = y * textureSize * 2 + x * 2
      indexes[i + 0] = x
      indexes[i + 1] = y
    }
  }
  return indexes
}
