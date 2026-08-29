import type { Device } from './device'
import type { UniformMap, UniformValue } from './types'
import type { Texture } from './texture'

type UniformInfo = {
  location: WebGLUniformLocation
  type: number
  size: number
  /** Assigned texture unit, for sampler uniforms only. */
  unit: number
}

export type ProgramProps = {
  vs: string
  fs: string
  /** Prepended as `#define NAME value` after the `#version` line. */
  defines?: Record<string, string | number | boolean>
  id?: string
}

export class ShaderCompilationError extends Error {
  public constructor (message: string) {
    super(message)
    this.name = 'ShaderCompilationError'
  }
}

/**
 * A linked shader program with introspected uniforms and attributes.
 *
 * Uniform values are cached and re-sent only on change. On React Native every
 * `uniform*` call is a bridge crossing, and the engine sets the same handful of
 * uniforms on every pass of every frame, so this removes the large majority of
 * them.
 */
export class Program {
  public readonly device: Device
  public readonly id: string
  public handle: WebGLProgram | null
  public destroyed = false

  private readonly uniforms = new Map<string, UniformInfo>()
  private readonly attributes = new Map<string, number>()
  /** Last value written to each uniform, compared before re-sending. */
  private readonly uniformCache = new Map<string, number | number[]>()
  private samplerCount = 0

  public constructor (device: Device, props: ProgramProps) {
    const gl = device.gl
    this.device = device
    this.id = props.id ?? 'program'

    const vsSource = injectDefines(props.vs, props.defines)
    const fsSource = injectDefines(props.fs, props.defines)
    const vs = compileShader(device, gl.VERTEX_SHADER, vsSource, `${this.id}.vs`)
    const fs = compileShader(device, gl.FRAGMENT_SHADER, fsSource, `${this.id}.fs`)

    const program = gl.createProgram()
    if (!program) throw new ShaderCompilationError(`Could not create program "${this.id}"`)
    this.handle = program
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)

    // Shaders are refcounted by the program; flagging them for delete now means
    // they go away with it.
    gl.deleteShader(vs)
    gl.deleteShader(fs)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      this.handle = null
      throw new ShaderCompilationError(`Could not link program "${this.id}":\n${log ?? '(no log)'}`)
    }

    this.introspect()
  }

  private introspect (): void {
    const gl = this.device.gl
    const program = this.handle
    if (!program) return

    const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < uniformCount; i++) {
      const info = gl.getActiveUniform(program, i)
      if (!info) continue
      const location = gl.getUniformLocation(program, info.name)
      if (!location) continue
      // An array uniform is reported as `name[0]`; callers address it as `name`.
      const name = info.name.endsWith('[0]') ? info.name.slice(0, -3) : info.name
      const unit = isSampler(gl, info.type) ? this.samplerCount++ : -1
      this.uniforms.set(name, { location, type: info.type, size: info.size, unit })
    }

    const attributeCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number
    for (let i = 0; i < attributeCount; i++) {
      const info = gl.getActiveAttrib(program, i)
      if (!info) continue
      this.attributes.set(info.name, gl.getAttribLocation(program, info.name))
    }
  }

  public use (): void {
    this.device.useProgram(this.handle)
  }

  public getAttributeLocation (name: string): number | undefined {
    return this.attributes.get(name)
  }

  public hasUniform (name: string): boolean {
    return this.uniforms.has(name)
  }

  /**
   * Assigns values by name. Unknown names are ignored — a uniform the compiler
   * eliminated as unused simply is not there, and that is not an error.
   *
   * Must be called with this program in use.
   */
  public setUniforms (values: UniformMap): void {
    for (const name in values) {
      const value = values[name]
      if (value === undefined) continue
      this.setUniform(name, value)
    }
  }

  public setUniform (name: string, value: UniformValue): void {
    const info = this.uniforms.get(name)
    if (!info) return
    const gl = this.device.gl

    if (typeof value === 'number' || typeof value === 'boolean') {
      const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : value
      if (this.uniformCache.get(name) === numeric) return
      this.uniformCache.set(name, numeric)
      if (isIntegerType(gl, info.type)) gl.uniform1i(info.location, numeric)
      else gl.uniform1f(info.location, numeric)
      return
    }

    const array = value as ArrayLike<number>
    const cached = this.uniformCache.get(name)
    if (Array.isArray(cached) && sameValues(cached, array)) return
    const copy = new Array<number>(array.length)
    for (let i = 0; i < array.length; i++) copy[i] = array[i] as number
    this.uniformCache.set(name, copy)

    setVectorUniform(gl, info, array)
  }

  /**
   * Binds `texture` to the sampler `name`, on the unit reserved for it at link
   * time. A `null` texture leaves the unit bound to nothing, which reads as
   * zeros — shaders guard against that rather than relying on it.
   */
  public setTexture (name: string, texture: Texture | null | undefined): void {
    const info = this.uniforms.get(name)
    if (!info || info.unit < 0) return
    const gl = this.device.gl
    const target = texture?.target ?? gl.TEXTURE_2D
    this.device.bindTexture(info.unit, texture?.handle ?? null, target)
    // The sampler's unit index never changes, so it is sent once and cached.
    if (this.uniformCache.get(`sampler:${name}`) !== info.unit) {
      this.uniformCache.set(`sampler:${name}`, info.unit)
      gl.uniform1i(info.location, info.unit)
    }
  }

  public setTextures (textures: Record<string, Texture | null | undefined>): void {
    for (const name in textures) this.setTexture(name, textures[name])
  }

  /**
   * Drops the cached uniform values. Required after anything outside this class
   * could have changed the program's uniform state — otherwise a cached value
   * would suppress a write the GPU never received.
   */
  public invalidateUniformCache (): void {
    this.uniformCache.clear()
  }

  public destroy (): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.handle) this.device.gl.deleteProgram(this.handle)
    this.handle = null
    this.uniforms.clear()
    this.attributes.clear()
    this.uniformCache.clear()
  }
}

function compileShader (device: Device, type: number, source: string, label: string): WebGLShader {
  const gl = device.gl
  const shader = gl.createShader(type)
  if (!shader) throw new ShaderCompilationError(`Could not create shader "${label}"`)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(no log)'
    gl.deleteShader(shader)
    throw new ShaderCompilationError(`Could not compile "${label}":\n${log}\n${numberLines(source)}`)
  }
  return shader
}

/**
 * Inserts `#define`s directly after the `#version` line, which GLSL requires to
 * come first in the source.
 */
function injectDefines (source: string, defines: Record<string, string | number | boolean> | undefined): string {
  if (!defines) return source
  const entries = Object.entries(defines).filter(([, value]) => value !== false && value !== undefined)
  if (entries.length === 0) return source
  const block = entries
    .map(([name, value]) => (value === true ? `#define ${name}` : `#define ${name} ${String(value)}`))
    .join('\n')

  const versionMatch = /^\s*#version[^\n]*\n/.exec(source)
  if (!versionMatch) return `${block}\n${source}`
  const end = versionMatch[0].length
  return `${source.slice(0, end)}${block}\n${source.slice(end)}`
}

function numberLines (source: string): string {
  return source
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(4, ' ')} | ${line}`)
    .join('\n')
}

function isSampler (gl: WebGL2RenderingContext, type: number): boolean {
  return (
    type === gl.SAMPLER_2D ||
    type === gl.SAMPLER_CUBE ||
    type === gl.SAMPLER_2D_ARRAY ||
    type === gl.SAMPLER_3D ||
    type === gl.INT_SAMPLER_2D ||
    type === gl.UNSIGNED_INT_SAMPLER_2D ||
    type === gl.INT_SAMPLER_2D_ARRAY ||
    type === gl.UNSIGNED_INT_SAMPLER_2D_ARRAY
  )
}

function isIntegerType (gl: WebGL2RenderingContext, type: number): boolean {
  return type === gl.INT || type === gl.BOOL || type === gl.UNSIGNED_INT || isSampler(gl, type)
}

function sameValues (a: number[], b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function setVectorUniform (gl: WebGL2RenderingContext, info: UniformInfo, value: ArrayLike<number>): void {
  const data = value instanceof Float32Array ? value : Float32Array.from(value)
  switch (info.type) {
    case gl.FLOAT: gl.uniform1fv(info.location, data); return
    case gl.FLOAT_VEC2: gl.uniform2fv(info.location, data); return
    case gl.FLOAT_VEC3: gl.uniform3fv(info.location, data); return
    case gl.FLOAT_VEC4: gl.uniform4fv(info.location, data); return
    case gl.FLOAT_MAT2: gl.uniformMatrix2fv(info.location, false, data); return
    case gl.FLOAT_MAT3: gl.uniformMatrix3fv(info.location, false, data); return
    case gl.FLOAT_MAT4: gl.uniformMatrix4fv(info.location, false, data); return
    default: {
      const ints = value instanceof Int32Array ? value : Int32Array.from(value)
      switch (info.type) {
        case gl.INT: case gl.BOOL: gl.uniform1iv(info.location, ints); return
        case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2iv(info.location, ints); return
        case gl.INT_VEC3: case gl.BOOL_VEC3: gl.uniform3iv(info.location, ints); return
        case gl.INT_VEC4: case gl.BOOL_VEC4: gl.uniform4iv(info.location, ints); return
      }
    }
  }
}
