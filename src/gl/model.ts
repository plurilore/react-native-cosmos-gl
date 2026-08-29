import type { Device } from './device'
import { GLBuffer } from './buffer'
import { Program, type ProgramProps } from './program'
import type { Framebuffer } from './framebuffer'
import type { Texture } from './texture'
import type { AttributeBinding, PipelineParameters, Topology, UniformMap } from './types'

export type ModelProps = ProgramProps & {
  attributes?: Record<string, AttributeBinding>
  indexBuffer?: GLBuffer
  vertexCount?: number
  instanceCount?: number
  topology?: Topology
  parameters?: PipelineParameters
}

/**
 * Programs are cached per device and keyed by their source, so the many models
 * that share a shader — the two point-draw passes, every force pass built from
 * the same quad vertex shader — compile once.
 */
const programCaches = new WeakMap<Device, Map<string, Program>>()

function getProgram (device: Device, props: ProgramProps): Program {
  let cache = programCaches.get(device)
  if (!cache) {
    cache = new Map()
    programCaches.set(device, cache)
  }
  const key = `${props.vs.length}:${props.fs.length}:${JSON.stringify(props.defines ?? {})}:${props.id ?? ''}`
  let program = cache.get(key)
  if (!program || program.destroyed) {
    program = new Program(device, props)
    cache.set(key, program)
  }
  return program
}

/**
 * A draw call: a program, its attribute bindings, and the fixed-function state
 * it needs.
 *
 * Attribute bindings live in a VAO that is rebuilt only when a binding actually
 * changes, so a steady-state frame re-binds one object per draw instead of
 * re-specifying every pointer.
 */
export class Model {
  public readonly device: Device
  public readonly program: Program
  public vertexCount: number
  public instanceCount: number
  public topology: Topology
  public parameters: PipelineParameters | undefined
  public indexBuffer: GLBuffer | undefined
  public destroyed = false

  private vao: WebGLVertexArrayObject | null = null
  private attributes: Record<string, AttributeBinding> = {}
  private isVertexArrayDirty = true

  public constructor (device: Device, props: ModelProps) {
    this.device = device
    this.program = getProgram(device, props)
    this.vertexCount = props.vertexCount ?? 0
    this.instanceCount = props.instanceCount ?? 0
    this.topology = props.topology ?? 'triangle-strip'
    this.parameters = props.parameters
    this.indexBuffer = props.indexBuffer
    if (props.attributes) this.setAttributes(props.attributes)
  }

  public setAttributes (attributes: Record<string, AttributeBinding>): void {
    for (const name in attributes) {
      const next = attributes[name]
      if (!next) continue
      const current = this.attributes[name]
      if (
        current &&
        current.buffer === next.buffer &&
        current.size === next.size &&
        current.stride === next.stride &&
        current.offset === next.offset &&
        current.divisor === next.divisor
      ) continue
      this.attributes[name] = next
      this.isVertexArrayDirty = true
    }
  }

  public setIndexBuffer (buffer: GLBuffer | undefined): void {
    if (this.indexBuffer === buffer) return
    this.indexBuffer = buffer
    this.isVertexArrayDirty = true
  }

  public setUniforms (uniforms: UniformMap): void {
    this.program.use()
    this.program.setUniforms(uniforms)
  }

  public setTextures (textures: Record<string, Texture | null | undefined>): void {
    this.program.use()
    this.program.setTextures(textures)
  }

  /**
   * Draws into `framebuffer`, or into the default framebuffer when omitted.
   *
   * `viewport` overrides the target's own size — needed when drawing to the
   * screen, whose dimensions this layer does not own.
   */
  public draw (
    framebuffer?: Framebuffer | null,
    viewport?: readonly [number, number, number, number]
  ): void {
    if (this.destroyed || !this.program.handle) return
    const gl = this.device.gl

    if (framebuffer) framebuffer.bind()
    else this.device.bindFramebuffer(null)
    if (viewport) this.device.setViewport(viewport[0], viewport[1], viewport[2], viewport[3])

    this.program.use()
    this.device.setParameters(this.parameters)
    this.bindVertexArray()

    const mode = topologyMode(gl, this.topology)
    if (this.indexBuffer) {
      const count = this.vertexCount || this.indexBuffer.byteLength / 4
      if (count <= 0) return
      if (this.instanceCount > 0) {
        gl.drawElementsInstanced(mode, count, gl.UNSIGNED_INT, 0, this.instanceCount)
      } else {
        gl.drawElements(mode, count, gl.UNSIGNED_INT, 0)
      }
      return
    }

    if (this.vertexCount <= 0) return
    if (this.instanceCount > 0) {
      gl.drawArraysInstanced(mode, 0, this.vertexCount, this.instanceCount)
    } else {
      gl.drawArrays(mode, 0, this.vertexCount)
    }
  }

  private bindVertexArray (): void {
    const gl = this.device.gl
    if (!this.vao) {
      this.vao = gl.createVertexArray()
      this.isVertexArrayDirty = true
    }
    this.device.bindVertexArray(this.vao)
    if (!this.isVertexArrayDirty) return
    this.isVertexArrayDirty = false

    for (const name in this.attributes) {
      const binding = this.attributes[name]
      if (!binding) continue
      const location = this.program.getAttributeLocation(name)
      // A location of -1 means the compiler dropped the attribute as unused,
      // which is normal for shaders shared across passes.
      if (location === undefined || location < 0) continue
      const buffer = binding.buffer
      if (!buffer.handle || buffer.destroyed) continue

      gl.bindBuffer(gl.ARRAY_BUFFER, buffer.handle)
      gl.enableVertexAttribArray(location)
      const type = binding.type ?? 'float'
      if (type === 'float') {
        gl.vertexAttribPointer(location, binding.size, gl.FLOAT, false, binding.stride ?? 0, binding.offset ?? 0)
      } else {
        const glType = type === 'int' ? gl.INT : gl.UNSIGNED_INT
        gl.vertexAttribIPointer(location, binding.size, glType, binding.stride ?? 0, binding.offset ?? 0)
      }
      if (binding.divisor !== undefined) gl.vertexAttribDivisor(location, binding.divisor)
    }

    if (this.indexBuffer?.handle) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer.handle)
    }
  }

  /**
   * Destroys the VAO. The program is left alone — it is shared through the
   * device-level cache and other models may still hold it.
   */
  public destroy (): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.vao) this.device.gl.deleteVertexArray(this.vao)
    this.vao = null
    this.attributes = {}
  }
}

function topologyMode (gl: WebGL2RenderingContext, topology: Topology): number {
  switch (topology) {
    case 'triangle-strip': return gl.TRIANGLE_STRIP
    case 'triangle-list': return gl.TRIANGLES
    case 'point-list': return gl.POINTS
    case 'line-list': return gl.LINES
  }
}

/**
 * The unit quad every full-screen GPGPU pass draws, as a triangle strip in
 * normalized device coordinates. One per device — the passes differ only in
 * their fragment shader, never in their geometry.
 */
const quadBuffers = new WeakMap<Device, GLBuffer>()

export function getQuadBuffer (device: Device): GLBuffer {
  let buffer = quadBuffers.get(device)
  if (!buffer || buffer.destroyed) {
    buffer = new GLBuffer(device, 'vertex', new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]))
    quadBuffers.set(device, buffer)
  }
  return buffer
}

/**
 * Builds a full-screen pass: one quad, one fragment shader, writing one output
 * per texel of the target. The shape of nearly every simulation step.
 */
export function createQuadModel (
  device: Device,
  props: Omit<ModelProps, 'vs' | 'attributes' | 'vertexCount' | 'topology'> & { vs?: string }
): Model {
  return new Model(device, {
    ...props,
    vs: props.vs ?? QUAD_VERTEX_SHADER,
    attributes: { vertexCoord: { buffer: getQuadBuffer(device), size: 2 } },
    vertexCount: 4,
    topology: 'triangle-strip',
  })
}

export const QUAD_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 vertexCoord;

void main() {
  gl_Position = vec4(vertexCoord, 0.0, 1.0);
}
`
