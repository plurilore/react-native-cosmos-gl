import type { GL, PipelineParameters, BlendFactor, DepthCompare } from './types'

/**
 * What the host GPU actually supports. Probed once at device creation, because
 * on React Native every `getParameter` / `getExtension` is a synchronous hop
 * across the JS↔GL boundary and must not happen per frame.
 */
export type DeviceFeatures = {
  /** `EXT_color_buffer_float` — render into RGBA32F. The engine cannot run without it. */
  renderToFloat32: boolean
  /** `EXT_color_buffer_half_float` — render into RGBA16F, the degraded fallback. */
  renderToFloat16: boolean
  /**
   * `EXT_float_blend` — additive blending into a float render target. The
   * many-body and link forces accumulate velocity contributions this way; a
   * device without it falls back to non-blended force paths.
   */
  floatBlend: boolean
  /** `OES_texture_float_linear` — linear filtering of float textures. */
  floatLinearFilter: boolean
  maxTextureSize: number
  maxTextureArrayLayers: number
  maxColorAttachments: number
  maxTextureUnits: number
}

export class DeviceError extends Error {
  public constructor (message: string) {
    super(message)
    this.name = 'DeviceError'
  }
}

/**
 * Owns the GL context, the capability probe, and a cache of every piece of
 * fixed-function state the engine toggles.
 *
 * The state cache is not a micro-optimization here. Each GL call from React
 * Native crosses a bridge; a frame of this engine issues dozens of passes that
 * mostly want the *same* blend and depth state, and re-sending it every time is
 * measurable. Every setter below is a no-op when the value already matches.
 */
export class Device {
  public readonly gl: GL
  public readonly features: DeviceFeatures
  /** Set when the context is lost; every resource method becomes a no-op. */
  public isLost = false

  private boundProgram: WebGLProgram | null = null
  private boundFramebuffer: WebGLFramebuffer | null = null
  private boundVertexArray: WebGLVertexArrayObject | null = null
  private viewportState: [number, number, number, number] = [-1, -1, -1, -1]
  private blendEnabled: boolean | undefined = undefined
  private blendFuncState: [number, number, number, number] | undefined = undefined
  private depthTestEnabled: boolean | undefined = undefined
  private depthMaskState: boolean | undefined = undefined
  private depthFuncState: number | undefined = undefined
  /** Texture currently bound to each unit, so redundant binds are skipped. */
  private textureUnits: (WebGLTexture | null)[] = []
  private activeTextureUnit = -1

  public constructor (gl: GL) {
    // WebGL2 first, before probing anything else. `expo-gl` asks for an OpenGL
    // ES 3.0 context and silently falls back to ES 2.0 when the device cannot
    // give it one — at which point every symptom downstream (a missing float
    // extension, a shader that will not compile) describes a consequence rather
    // than the cause.
    if (typeof gl.createVertexArray !== 'function' || typeof gl.texStorage3D !== 'function') {
      throw new DeviceError(
        'This context is not WebGL2. The engine\'s shaders are GLSL ES 3.00 and its data lives in ' +
        'float textures, neither of which WebGL1 supports. On React Native this usually means the ' +
        'device fell back to OpenGL ES 2.0; `gl.supportsWebGL2` reports whether expo-gl got an ' +
        'ES 3.0 context.'
      )
    }

    this.gl = gl
    this.features = probeFeatures(gl)
    this.textureUnits = new Array<WebGLTexture | null>(this.features.maxTextureUnits).fill(null)

    if (!this.features.renderToFloat32 && !this.features.renderToFloat16) {
      throw new DeviceError(
        'This device cannot render to floating-point textures (neither EXT_color_buffer_float nor ' +
        'EXT_color_buffer_half_float is available). The GPU force simulation stores positions and ' +
        'velocities in float render targets and cannot run without one of them.'
      )
    }
  }

  /**
   * The format the simulation stores positions and velocities in. RGBA16F has
   * a 10-bit mantissa — enough for a few thousand distinct coordinates — so it
   * is a visible-quality fallback, not an equivalent one, and is only chosen
   * when full float render targets are unavailable.
   */
  public get simulationTextureFormat (): 'rgba32float' | 'rgba16float' {
    return this.features.renderToFloat32 ? 'rgba32float' : 'rgba16float'
  }

  public useProgram (program: WebGLProgram | null): void {
    if (this.boundProgram === program) return
    this.boundProgram = program
    this.gl.useProgram(program)
  }

  public bindFramebuffer (framebuffer: WebGLFramebuffer | null): void {
    if (this.boundFramebuffer === framebuffer) return
    this.boundFramebuffer = framebuffer
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, framebuffer)
  }

  public bindVertexArray (vao: WebGLVertexArrayObject | null): void {
    if (this.boundVertexArray === vao) return
    this.boundVertexArray = vao
    this.gl.bindVertexArray(vao)
  }

  public bindTexture (unit: number, texture: WebGLTexture | null, target?: number): void {
    const gl = this.gl
    const bindTarget = target ?? gl.TEXTURE_2D
    // A unit can hold one texture per target, but the engine never binds two
    // targets to one unit, so caching by unit alone is sound.
    if (this.textureUnits[unit] === texture && texture !== null) return
    if (this.activeTextureUnit !== unit) {
      gl.activeTexture(gl.TEXTURE0 + unit)
      this.activeTextureUnit = unit
    }
    gl.bindTexture(bindTarget, texture)
    this.textureUnits[unit] = texture
  }

  /** Forgets a texture the caller is about to delete, so a later bind is not skipped. */
  public forgetTexture (texture: WebGLTexture): void {
    for (let i = 0; i < this.textureUnits.length; i++) {
      if (this.textureUnits[i] === texture) this.textureUnits[i] = null
    }
  }

  public setViewport (x: number, y: number, width: number, height: number): void {
    const v = this.viewportState
    if (v[0] === x && v[1] === y && v[2] === width && v[3] === height) return
    this.viewportState = [x, y, width, height]
    this.gl.viewport(x, y, width, height)
  }

  /** Applies a draw's fixed-function state, skipping whatever already matches. */
  public setParameters (params: PipelineParameters | undefined): void {
    const gl = this.gl
    const blend = params?.blend ?? false
    if (this.blendEnabled !== blend) {
      this.blendEnabled = blend
      if (blend) gl.enable(gl.BLEND)
      else gl.disable(gl.BLEND)
    }
    if (blend) {
      const srcRgb = blendFactor(gl, params?.blendColorSrcFactor ?? 'one')
      const dstRgb = blendFactor(gl, params?.blendColorDstFactor ?? 'zero')
      const srcA = blendFactor(gl, params?.blendAlphaSrcFactor ?? 'one')
      const dstA = blendFactor(gl, params?.blendAlphaDstFactor ?? 'zero')
      const f = this.blendFuncState
      if (!f || f[0] !== srcRgb || f[1] !== dstRgb || f[2] !== srcA || f[3] !== dstA) {
        this.blendFuncState = [srcRgb, dstRgb, srcA, dstA]
        gl.blendFuncSeparate(srcRgb, dstRgb, srcA, dstA)
      }
    }

    // `depthCompare: 'always'` with no depth write is how the engine says "no
    // depth at all"; disabling the test outright is cheaper and equivalent.
    const compare = params?.depthCompare ?? 'always'
    const write = params?.depthWriteEnabled ?? false
    const wantsDepth = params?.depthTest ?? (compare !== 'always' || write)
    if (this.depthTestEnabled !== wantsDepth) {
      this.depthTestEnabled = wantsDepth
      if (wantsDepth) gl.enable(gl.DEPTH_TEST)
      else gl.disable(gl.DEPTH_TEST)
    }
    if (wantsDepth) {
      const func = depthFunc(gl, compare)
      if (this.depthFuncState !== func) {
        this.depthFuncState = func
        gl.depthFunc(func)
      }
    }
    if (this.depthMaskState !== write) {
      this.depthMaskState = write
      gl.depthMask(write)
    }
  }

  /**
   * Drops every cached value. Call after any code outside this layer touched
   * the context — otherwise the cache would report state the driver no longer
   * has, and the engine would silently draw with the wrong parameters.
   */
  public invalidateStateCache (): void {
    this.boundProgram = null
    this.boundFramebuffer = null
    this.boundVertexArray = null
    this.viewportState = [-1, -1, -1, -1]
    this.blendEnabled = undefined
    this.blendFuncState = undefined
    this.depthTestEnabled = undefined
    this.depthMaskState = undefined
    this.depthFuncState = undefined
    this.textureUnits.fill(null)
    this.activeTextureUnit = -1
  }

  /**
   * Throws if the context has an error queued. Costs a synchronous round-trip,
   * so it is only ever called from setup paths, never per frame.
   */
  public checkError (context: string): void {
    const error = this.gl.getError()
    if (error !== this.gl.NO_ERROR) {
      throw new DeviceError(`GL error 0x${error.toString(16)} during ${context}`)
    }
  }
}

function probeFeatures (gl: GL): DeviceFeatures {
  const has = (name: string): boolean => {
    try {
      return gl.getExtension(name) !== null
    } catch {
      return false
    }
  }
  const param = (name: number, fallback: number): number => {
    try {
      const value = gl.getParameter(name) as number
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
    } catch {
      return fallback
    }
  }

  return {
    renderToFloat32: has('EXT_color_buffer_float'),
    renderToFloat16: has('EXT_color_buffer_half_float') || has('EXT_color_buffer_float'),
    floatBlend: has('EXT_float_blend'),
    floatLinearFilter: has('OES_texture_float_linear'),
    maxTextureSize: param(gl.MAX_TEXTURE_SIZE, 2048),
    maxTextureArrayLayers: param(gl.MAX_ARRAY_TEXTURE_LAYERS, 256),
    maxColorAttachments: param(gl.MAX_COLOR_ATTACHMENTS, 4),
    maxTextureUnits: param(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS, 16),
  }
}

function blendFactor (gl: GL, factor: BlendFactor): number {
  switch (factor) {
    case 'zero': return gl.ZERO
    case 'one': return gl.ONE
    case 'src-alpha': return gl.SRC_ALPHA
    case 'one-minus-src-alpha': return gl.ONE_MINUS_SRC_ALPHA
    case 'dst-alpha': return gl.DST_ALPHA
    case 'one-minus-dst-alpha': return gl.ONE_MINUS_DST_ALPHA
  }
}

function depthFunc (gl: GL, compare: DepthCompare): number {
  switch (compare) {
    case 'never': return gl.NEVER
    case 'less': return gl.LESS
    case 'equal': return gl.EQUAL
    case 'less-equal': return gl.LEQUAL
    case 'greater': return gl.GREATER
    case 'always': return gl.ALWAYS
  }
}
