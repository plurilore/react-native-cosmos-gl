import type { Device } from './device'
import type { GL, TextureFormat, TextureFilter } from './types'

export type TextureProps = {
  width: number
  height: number
  format?: TextureFormat
  /** Layer count. Greater than 1 creates a `TEXTURE_2D_ARRAY`. */
  depth?: number
  filter?: TextureFilter
  data?: ArrayBufferView | null
  id?: string
}

type FormatDescriptor = {
  internalFormat: number
  format: number
  type: number
  bytesPerPixel: number
  /** Whether filtering beyond `nearest` needs a device extension. */
  isFloat: boolean
}

/**
 * A data or image texture.
 *
 * The engine uses textures as its primary storage: positions, velocities,
 * per-point attributes and grid aggregates all live in `rgba32float` textures
 * addressed by `texelFetch`. Filtering therefore defaults to `nearest` — a
 * filtered read of a data texture would blend two unrelated points together.
 */
export class Texture {
  public readonly device: Device
  public readonly width: number
  public readonly height: number
  public readonly depth: number
  public readonly format: TextureFormat
  public readonly target: number
  public handle: WebGLTexture | null
  public destroyed = false
  public readonly id: string

  private readonly descriptor: FormatDescriptor

  public constructor (device: Device, props: TextureProps) {
    const gl = device.gl
    this.device = device
    this.width = Math.max(1, Math.floor(props.width))
    this.height = Math.max(1, Math.floor(props.height))
    this.depth = Math.max(1, Math.floor(props.depth ?? 1))
    this.format = props.format ?? 'rgba32float'
    this.id = props.id ?? 'texture'
    this.target = this.depth > 1 ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D
    this.descriptor = describeFormat(gl, this.format)
    this.handle = gl.createTexture()

    // `linear` on a float texture silently falls back to `nearest` without
    // OES_texture_float_linear on some drivers and errors on others; ask for it
    // only when the device actually advertises it.
    const wantsLinear = props.filter === 'linear'
    const filter = wantsLinear && (!this.descriptor.isFloat || device.features.floatLinearFilter)
      ? gl.LINEAR
      : gl.NEAREST

    device.bindTexture(0, this.handle, this.target)
    gl.texParameteri(this.target, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(this.target, gl.TEXTURE_MAG_FILTER, filter)
    // Data textures are addressed by exact texel; clamping keeps an
    // out-of-range fetch on the edge instead of wrapping to unrelated data.
    gl.texParameteri(this.target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(this.target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    const { internalFormat, format, type } = this.descriptor
    if (this.target === gl.TEXTURE_2D_ARRAY) {
      gl.texStorage3D(this.target, 1, internalFormat, this.width, this.height, this.depth)
      if (props.data) {
        gl.texSubImage3D(
          this.target, 0, 0, 0, 0, this.width, this.height, this.depth,
          format, type, props.data as unknown as ArrayBufferView
        )
      }
    } else {
      // texImage2D rather than texStorage2D: expo-gl's immutable-storage path
      // has been unreliable across versions, and the engine never mipmaps.
      gl.texImage2D(
        this.target, 0, internalFormat, this.width, this.height, 0,
        format, type, (props.data ?? null) as unknown as ArrayBufferView | null
      )
    }
  }

  /** Replaces the whole texture's contents. `data` must match `width * height * depth`. */
  public write (data: ArrayBufferView | null): void {
    if (this.destroyed || !this.handle) return
    const gl = this.device.gl
    const { internalFormat, format, type } = this.descriptor
    this.device.bindTexture(0, this.handle, this.target)
    if (this.target === gl.TEXTURE_2D_ARRAY) {
      gl.texSubImage3D(
        this.target, 0, 0, 0, 0, this.width, this.height, this.depth,
        format, type, data as unknown as ArrayBufferView
      )
    } else {
      gl.texImage2D(
        this.target, 0, internalFormat, this.width, this.height, 0,
        format, type, data as unknown as ArrayBufferView | null
      )
    }
  }

  /** Replaces a sub-rectangle. Cheaper than `write` when only part changed. */
  public writeSubImage (
    data: ArrayBufferView,
    x: number,
    y: number,
    width: number,
    height: number,
    layer = 0
  ): void {
    if (this.destroyed || !this.handle) return
    const gl = this.device.gl
    const { format, type } = this.descriptor
    this.device.bindTexture(0, this.handle, this.target)
    if (this.target === gl.TEXTURE_2D_ARRAY) {
      gl.texSubImage3D(this.target, 0, x, y, layer, width, height, 1, format, type, data as unknown as ArrayBufferView)
    } else {
      gl.texSubImage2D(this.target, 0, x, y, width, height, format, type, data as unknown as ArrayBufferView)
    }
  }

  public get bytesPerPixel (): number {
    return this.descriptor.bytesPerPixel
  }

  public destroy (): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.handle) {
      this.device.forgetTexture(this.handle)
      this.device.gl.deleteTexture(this.handle)
    }
    this.handle = null
  }
}

function describeFormat (gl: GL, format: TextureFormat): FormatDescriptor {
  switch (format) {
    case 'rgba32float':
      return { internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, bytesPerPixel: 16, isFloat: true }
    case 'rgba16float':
      return { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, bytesPerPixel: 8, isFloat: true }
    case 'rg32float':
      return { internalFormat: gl.RG32F, format: gl.RG, type: gl.FLOAT, bytesPerPixel: 8, isFloat: true }
    case 'r32float':
      return { internalFormat: gl.R32F, format: gl.RED, type: gl.FLOAT, bytesPerPixel: 4, isFloat: true }
    case 'rgba8unorm':
      return { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, bytesPerPixel: 4, isFloat: false }
  }
}
