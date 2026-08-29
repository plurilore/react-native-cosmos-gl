import type { Device } from './device'
import { Texture, type TextureProps } from './texture'

export type FramebufferProps = {
  /** Textures to attach as color targets, in attachment order. */
  colorAttachments: Texture[]
  /**
   * Attach a depth renderbuffer. `true` gives 16 bits; `'depth24'` gives 24.
   *
   * The near-field depth-peeling targets need 24: the depth test picks each
   * slot's winner, but the next pass compares the full 24-bit hash from the
   * colour target. At 16 bits the quantization invents ties, and a tie broken
   * by draw order can exclude the true smallest-hash point from the entire
   * tick's sample.
   */
  depth?: boolean | 'depth24'
  id?: string
}

/**
 * An off-screen render target.
 *
 * Most of the engine's work is a full-screen pass into one of these: a
 * simulation step reads the previous position texture and writes the next one,
 * a force pass blends its contribution into the velocity texture, and so on.
 */
export class Framebuffer {
  public readonly device: Device
  public readonly colorAttachments: Texture[]
  public readonly width: number
  public readonly height: number
  public handle: WebGLFramebuffer | null
  public destroyed = false
  public readonly id: string

  private depthBuffer: WebGLRenderbuffer | null = null
  /** Attachment enums for `drawBuffers`, cached to avoid rebuilding per bind. */
  private readonly drawBuffers: number[]

  public constructor (device: Device, props: FramebufferProps) {
    const gl = device.gl
    this.device = device
    this.id = props.id ?? 'framebuffer'
    this.colorAttachments = props.colorAttachments

    const first = props.colorAttachments[0]
    if (!first) throw new Error(`Framebuffer "${this.id}" needs at least one color attachment`)
    this.width = first.width
    this.height = first.height

    this.handle = gl.createFramebuffer()
    device.bindFramebuffer(this.handle)

    this.drawBuffers = []
    props.colorAttachments.forEach((texture, index) => {
      const attachment = gl.COLOR_ATTACHMENT0 + index
      this.drawBuffers.push(attachment)
      if (texture.target === gl.TEXTURE_2D_ARRAY) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, attachment, texture.handle, 0, 0)
      } else {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, texture.handle, 0)
      }
    })

    if (props.depth) {
      this.depthBuffer = gl.createRenderbuffer()
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer)
      const depthFormat = props.depth === 'depth24' ? gl.DEPTH_COMPONENT24 : gl.DEPTH_COMPONENT16
      gl.renderbufferStorage(gl.RENDERBUFFER, depthFormat, this.width, this.height)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuffer)
      gl.bindRenderbuffer(gl.RENDERBUFFER, null)
    }

    if (this.drawBuffers.length > 1) gl.drawBuffers(this.drawBuffers)

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      this.destroy()
      throw new Error(
        `Framebuffer "${this.id}" is incomplete (status 0x${status.toString(16)}). ` +
        `This usually means the device cannot render to ${first.format}.`
      )
    }
  }

  /** Points color attachment `index` at a different layer of an array texture. */
  public setAttachmentLayer (index: number, texture: Texture, layer: number): void {
    if (this.destroyed) return
    const gl = this.device.gl
    this.device.bindFramebuffer(this.handle)
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, texture.handle, 0, layer)
  }

  /** Binds this target and sets the viewport to cover it. */
  public bind (): void {
    this.device.bindFramebuffer(this.handle)
    this.device.setViewport(0, 0, this.width, this.height)
    if (this.drawBuffers.length > 1) this.device.gl.drawBuffers(this.drawBuffers)
  }

  public clear (r = 0, g = 0, b = 0, a = 0, clearDepth = false): void {
    if (this.destroyed) return
    const gl = this.device.gl
    this.bind()
    gl.clearColor(r, g, b, a)
    if (clearDepth && this.depthBuffer) {
      gl.clearDepth(1)
      // Depth writes must be on for a depth clear to land; the state cache is
      // told, so the next `setParameters` still sees the truth.
      this.device.setParameters({ depthTest: true, depthWriteEnabled: true, depthCompare: 'always' })
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    } else {
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
  }

  /**
   * Reads pixels back to the CPU.
   *
   * This is a hard pipeline stall — the GPU must finish everything queued
   * before the data is available, and on React Native the result also crosses
   * the JS bridge. Callers cache aggressively and read the smallest rectangle
   * they can; nothing here should run unconditionally per frame.
   */
  public readPixels (
    out: Float32Array,
    x = 0,
    y = 0,
    width = this.width,
    height = this.height,
    attachment = 0
  ): Float32Array {
    if (this.destroyed) return out
    const gl = this.device.gl
    this.device.bindFramebuffer(this.handle)
    if (this.drawBuffers.length > 1) gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment)
    gl.readPixels(x, y, width, height, gl.RGBA, gl.FLOAT, out)
    return out
  }

  public destroy (): void {
    if (this.destroyed) return
    this.destroyed = true
    const gl = this.device.gl
    if (this.handle) gl.deleteFramebuffer(this.handle)
    if (this.depthBuffer) gl.deleteRenderbuffer(this.depthBuffer)
    this.handle = null
    this.depthBuffer = null
  }

  /** Destroys this target together with the textures it owns. */
  public destroyWithAttachments (): void {
    const attachments = [...this.colorAttachments]
    this.destroy()
    for (const texture of attachments) texture.destroy()
  }
}

/**
 * Allocates a texture and a framebuffer wrapping it — the shape almost every
 * GPGPU target in the engine takes.
 */
export function createRenderTarget (
  device: Device,
  props: TextureProps & { depthBuffer?: boolean | 'depth24' }
): { texture: Texture; fbo: Framebuffer } {
  const texture = new Texture(device, props)
  const fbo = new Framebuffer(device, {
    colorAttachments: [texture],
    depth: props.depthBuffer,
    id: `${props.id ?? 'target'}-fbo`,
  })
  return { texture, fbo }
}
