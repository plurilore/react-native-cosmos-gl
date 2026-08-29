/**
 * A mock WebGL2 context that records what the engine asks of it.
 *
 * The point is not to simulate a GPU. It is to catch the class of bug this
 * codebase is most exposed to: uniforms and attributes are addressed by
 * *string name*, and a real driver silently ignores a name that does not exist.
 * A typo therefore produces a graph that renders but behaves wrongly — points
 * at the origin, no repulsion, an unmoving view — with nothing logged anywhere.
 *
 * So this context parses each shader's declarations for real, and reports only
 * those as active. Setting an unknown uniform then shows up as a recorded miss,
 * which the tests assert on.
 */

type ActiveInfo = { name: string; type: number; size: number }

const GL_ENUMS: Record<string, number> = {
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  ACTIVE_UNIFORMS: 0x8b86,
  ACTIVE_ATTRIBUTES: 0x8b89,
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  TEXTURE_2D: 0x0de1,
  TEXTURE_2D_ARRAY: 0x8c1a,
  TEXTURE_3D: 0x806f,
  TEXTURE_CUBE_MAP: 0x8513,
  TEXTURE0: 0x84c0,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  NEAREST: 0x2600,
  LINEAR: 0x2601,
  CLAMP_TO_EDGE: 0x812f,
  FRAMEBUFFER: 0x8d40,
  RENDERBUFFER: 0x8d41,
  COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_ATTACHMENT: 0x8d00,
  DEPTH_COMPONENT16: 0x81a5,
  DEPTH_COMPONENT24: 0x81a6,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  COLOR_BUFFER_BIT: 0x4000,
  DEPTH_BUFFER_BIT: 0x100,
  BLEND: 0x0be2,
  DEPTH_TEST: 0x0b71,
  POINTS: 0x0000,
  LINES: 0x0001,
  TRIANGLES: 0x0004,
  TRIANGLE_STRIP: 0x0005,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  UNSIGNED_BYTE: 0x1401,
  UNSIGNED_INT: 0x1405,
  INT: 0x1404,
  RGBA: 0x1908,
  RG: 0x8227,
  RED: 0x1903,
  RGBA32F: 0x8814,
  RGBA16F: 0x881a,
  RG32F: 0x8230,
  R32F: 0x822e,
  RGBA8: 0x8058,
  DYNAMIC_DRAW: 0x88e8,
  NO_ERROR: 0,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  MAX_COLOR_ATTACHMENTS: 0x8cdf,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  ALIASED_POINT_SIZE_RANGE: 0x846d,
  ZERO: 0,
  ONE: 1,
  SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  DST_ALPHA: 0x0304,
  ONE_MINUS_DST_ALPHA: 0x0305,
  NEVER: 0x0200,
  LESS: 0x0201,
  EQUAL: 0x0202,
  LEQUAL: 0x0203,
  GREATER: 0x0204,
  ALWAYS: 0x0207,
  SAMPLER_2D: 0x8b5e,
  SAMPLER_CUBE: 0x8b60,
  SAMPLER_3D: 0x8b5f,
  SAMPLER_2D_ARRAY: 0x8dc1,
  INT_SAMPLER_2D: 0x8dca,
  UNSIGNED_INT_SAMPLER_2D: 0x8dd2,
  INT_SAMPLER_2D_ARRAY: 0x8dcf,
  UNSIGNED_INT_SAMPLER_2D_ARRAY: 0x8dd7,
  FLOAT_VEC2: 0x8b50,
  FLOAT_VEC3: 0x8b51,
  FLOAT_VEC4: 0x8b52,
  INT_VEC2: 0x8b53,
  INT_VEC3: 0x8b54,
  INT_VEC4: 0x8b55,
  BOOL: 0x8b56,
  BOOL_VEC2: 0x8b57,
  BOOL_VEC3: 0x8b58,
  BOOL_VEC4: 0x8b59,
  FLOAT_MAT2: 0x8b5a,
  FLOAT_MAT3: 0x8b5b,
  FLOAT_MAT4: 0x8b5c,
}

const TYPE_BY_GLSL: Record<string, number> = {
  float: GL_ENUMS.FLOAT as number,
  vec2: GL_ENUMS.FLOAT_VEC2 as number,
  vec3: GL_ENUMS.FLOAT_VEC3 as number,
  vec4: GL_ENUMS.FLOAT_VEC4 as number,
  int: GL_ENUMS.INT as number,
  ivec2: GL_ENUMS.INT_VEC2 as number,
  ivec3: GL_ENUMS.INT_VEC3 as number,
  ivec4: GL_ENUMS.INT_VEC4 as number,
  bool: GL_ENUMS.BOOL as number,
  mat2: GL_ENUMS.FLOAT_MAT2 as number,
  mat3: GL_ENUMS.FLOAT_MAT3 as number,
  mat4: GL_ENUMS.FLOAT_MAT4 as number,
  sampler2D: GL_ENUMS.SAMPLER_2D as number,
  sampler2DArray: GL_ENUMS.SAMPLER_2D_ARRAY as number,
  sampler3D: GL_ENUMS.SAMPLER_3D as number,
}

/**
 * Resolves the `#ifdef` / `#else` / `#endif` blocks of a shader against the
 * `#define`s present in its source.
 *
 * Only needed for `USE_UNIFORM_BUFFERS`, which the engine never defines — so
 * every shader takes its plain-uniform branch, and the uniform-block branch
 * must not be parsed as declarations that do not exist.
 */
function preprocess (source: string): string {
  const defined = new Set<string>()
  for (const match of source.matchAll(/^\s*#define\s+(\w+)/gm)) {
    if (match[1]) defined.add(match[1])
  }

  const out: string[] = []
  const stack: boolean[] = []
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    const ifdef = /^#ifdef\s+(\w+)/.exec(trimmed)
    const ifndef = /^#ifndef\s+(\w+)/.exec(trimmed)
    if (ifdef) {
      stack.push(defined.has(ifdef[1] as string))
      continue
    }
    if (ifndef) {
      stack.push(!defined.has(ifndef[1] as string))
      continue
    }
    if (/^#else\b/.test(trimmed)) {
      stack[stack.length - 1] = !(stack[stack.length - 1] ?? true)
      continue
    }
    if (/^#endif\b/.test(trimmed)) {
      stack.pop()
      continue
    }
    if (stack.every(Boolean)) out.push(line)
  }
  return out.join('\n')
}

/** Extracts `uniform` declarations, skipping uniform *blocks*. */
export function parseUniforms (source: string): ActiveInfo[] {
  const result: ActiveInfo[] = []
  const body = preprocess(source)
  // `uniform <type> <name>[, <name>][ [n] ];` — but never `uniform Block {`.
  const pattern = /\buniform\s+(\w+)\s+([^;{]+);/g
  for (const match of body.matchAll(pattern)) {
    const glslType = match[1] as string
    const type = TYPE_BY_GLSL[glslType]
    if (type === undefined) continue
    for (const rawName of (match[2] as string).split(',')) {
      const arrayMatch = /^\s*(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*$/.exec(rawName)
      if (!arrayMatch?.[1]) continue
      const size = arrayMatch[2] ? Number(arrayMatch[2]) : 1
      result.push({ name: size > 1 ? `${arrayMatch[1]}[0]` : arrayMatch[1], type, size })
    }
  }
  return result
}

/** Extracts vertex `in` declarations. */
export function parseAttributes (source: string): ActiveInfo[] {
  const result: ActiveInfo[] = []
  const body = preprocess(source)
  for (const match of body.matchAll(/^\s*in\s+(\w+)\s+([^;]+);/gm)) {
    const type = TYPE_BY_GLSL[match[1] as string]
    if (type === undefined) continue
    for (const rawName of (match[2] as string).split(',')) {
      const name = rawName.trim()
      if (name) result.push({ name, type, size: 1 })
    }
  }
  return result
}

export type MockGLRecord = {
  /** Uniform names set on a program that does not declare them. */
  missedUniforms: { program: string; name: string }[]
  /** Attribute names bound on a program that does not declare them. */
  missedAttributes: { program: string; name: string }[]
  drawCalls: number
  /** Every readback issued, so a test can assert what a pick actually read. */
  readPixelCalls: { x: number; y: number; width: number; height: number }[]
  /** Bytes of texture storage currently allocated, for memory accounting. */
  textureBytes: number
  /** Peak texture bytes seen, since transient targets are freed as data changes. */
  peakTextureBytes: number
  programs: { id: string; uniforms: string[]; attributes: string[] }[]
  shaderSources: string[]
}

type MockProgram = {
  id: string
  uniforms: ActiveInfo[]
  attributes: ActiveInfo[]
  locations: Map<string, { name: string }>
}

/**
 * Builds a context plus the record of what the engine did with it.
 *
 * `extensions` controls what `getExtension` reports, so a test can simulate a
 * device without float blending and check the engine degrades rather than
 * breaks.
 */
export function createMockGL (options: {
  extensions?: string[]
  /**
   * Fills readback buffers, so a picking path can be tested end to end.
   *
   * Without it `readPixels` leaves the buffer untouched and every pick resolves
   * to "nothing here" — which tests that the pass *runs*, but never that it
   * reads the right pixels back.
   */
  readPixels?: (out: ArrayBufferView, x: number, y: number, width: number, height: number) => void
} = {}): {
  gl: WebGL2RenderingContext
  record: MockGLRecord
} {
  const available = new Set(options.extensions ?? [
    'EXT_color_buffer_float',
    'EXT_float_blend',
    'OES_texture_float_linear',
  ])

  const record: MockGLRecord = {
    missedUniforms: [],
    missedAttributes: [],
    drawCalls: 0,
    readPixelCalls: [],
    textureBytes: 0,
    peakTextureBytes: 0,
    programs: [],
    shaderSources: [],
  }

  const textureSizes = new Map<object, number>()
  let boundTexture: object | null = null

  const bytesPerPixel = (internalFormat: number): number => {
    switch (internalFormat) {
      case GL_ENUMS.RGBA32F: return 16
      case GL_ENUMS.RGBA16F: return 8
      case GL_ENUMS.RG32F: return 8
      case GL_ENUMS.R32F: return 4
      default: return 4
    }
  }

  const recordTextureSize = (bytes: number): void => {
    if (!boundTexture) return
    record.textureBytes += bytes - (textureSizes.get(boundTexture) ?? 0)
    textureSizes.set(boundTexture, bytes)
    if (record.textureBytes > record.peakTextureBytes) record.peakTextureBytes = record.textureBytes
  }

  const shaders = new Map<object, { type: number; source: string }>()
  const programs = new Map<object, MockProgram>()
  const pendingShaders = new Map<object, object[]>()
  let currentProgram: MockProgram | undefined

  const gl: Record<string, unknown> = { ...GL_ENUMS }

  Object.assign(gl, {
    createShader: (type: number) => {
      const handle = {}
      shaders.set(handle, { type, source: '' })
      return handle
    },
    shaderSource: (handle: object, source: string) => {
      const shader = shaders.get(handle)
      if (shader) {
        shader.source = source
        record.shaderSources.push(source)
      }
    },
    compileShader: () => undefined,
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => undefined,

    createProgram: () => {
      const handle = {}
      pendingShaders.set(handle, [])
      return handle
    },
    attachShader: (program: object, shader: object) => {
      pendingShaders.get(program)?.push(shader)
    },
    linkProgram: (program: object) => {
      const attached = pendingShaders.get(program) ?? []
      const uniforms: ActiveInfo[] = []
      const attributes: ActiveInfo[] = []
      const seenUniforms = new Set<string>()
      for (const shaderHandle of attached) {
        const shader = shaders.get(shaderHandle)
        if (!shader) continue
        for (const uniform of parseUniforms(shader.source)) {
          // A uniform declared in both stages links as one.
          if (seenUniforms.has(uniform.name)) continue
          seenUniforms.add(uniform.name)
          uniforms.push(uniform)
        }
        if (shader.type === GL_ENUMS.VERTEX_SHADER) {
          attributes.push(...parseAttributes(shader.source))
        }
      }
      const entry: MockProgram = {
        id: `program-${programs.size}`,
        uniforms,
        attributes,
        locations: new Map(),
      }
      programs.set(program, entry)
      record.programs.push({
        id: entry.id,
        uniforms: uniforms.map((u) => u.name),
        attributes: attributes.map((a) => a.name),
      })
    },
    getProgramParameter: (program: object, parameter: number) => {
      const entry = programs.get(program)
      if (parameter === GL_ENUMS.LINK_STATUS) return true
      if (parameter === GL_ENUMS.ACTIVE_UNIFORMS) return entry?.uniforms.length ?? 0
      if (parameter === GL_ENUMS.ACTIVE_ATTRIBUTES) return entry?.attributes.length ?? 0
      return 0
    },
    getProgramInfoLog: () => '',
    getActiveUniform: (program: object, index: number) => programs.get(program)?.uniforms[index],
    getActiveAttrib: (program: object, index: number) => programs.get(program)?.attributes[index],
    getUniformLocation: (program: object, name: string) => {
      const entry = programs.get(program)
      if (!entry) return null
      const base = name.endsWith('[0]') ? name.slice(0, -3) : name
      if (!entry.uniforms.some((u) => u.name === name || u.name === `${base}[0]` || u.name === base)) return null
      let location = entry.locations.get(name)
      if (!location) {
        location = { name }
        entry.locations.set(name, location)
      }
      return location
    },
    getAttribLocation: (program: object, name: string) => {
      const entry = programs.get(program)
      const index = entry?.attributes.findIndex((a) => a.name === name) ?? -1
      return index
    },
    useProgram: (program: object | null) => {
      currentProgram = program ? programs.get(program) : undefined
    },
    deleteProgram: () => undefined,

    createBuffer: () => ({}),
    bindBuffer: () => undefined,
    bufferData: () => undefined,
    bufferSubData: () => undefined,
    deleteBuffer: () => undefined,

    createTexture: () => {
      const handle = {}
      textureSizes.set(handle, 0)
      return handle
    },
    bindTexture: (_target: number, texture: object | null) => {
      boundTexture = texture
    },
    activeTexture: () => undefined,
    texParameteri: () => undefined,
    texImage2D: (
      _target: number, _level: number, internalFormat: number,
      width: number, height: number
    ) => {
      recordTextureSize(width * height * bytesPerPixel(internalFormat))
    },
    texSubImage2D: () => undefined,
    texStorage3D: (
      _target: number, _levels: number, internalFormat: number,
      width: number, height: number, depth: number
    ) => {
      recordTextureSize(width * height * depth * bytesPerPixel(internalFormat))
    },
    texSubImage3D: () => undefined,
    copyTexSubImage2D: () => undefined,
    copyTexSubImage3D: () => undefined,
    deleteTexture: (texture: object) => {
      record.textureBytes -= textureSizes.get(texture) ?? 0
      textureSizes.delete(texture)
    },

    createFramebuffer: () => ({}),
    bindFramebuffer: () => undefined,
    framebufferTexture2D: () => undefined,
    framebufferTextureLayer: () => undefined,
    framebufferRenderbuffer: () => undefined,
    checkFramebufferStatus: () => GL_ENUMS.FRAMEBUFFER_COMPLETE,
    deleteFramebuffer: () => undefined,
    drawBuffers: () => undefined,
    readBuffer: () => undefined,
    readPixels: (x: number, y: number, width: number, height: number, _f: number, _t: number, out: ArrayBufferView) => {
      record.readPixelCalls.push({ x, y, width, height })
      options.readPixels?.(out, x, y, width, height)
    },

    createRenderbuffer: () => ({}),
    bindRenderbuffer: () => undefined,
    renderbufferStorage: () => undefined,
    deleteRenderbuffer: () => undefined,

    createVertexArray: () => ({}),
    bindVertexArray: () => undefined,
    deleteVertexArray: () => undefined,
    enableVertexAttribArray: () => undefined,
    vertexAttribPointer: () => undefined,
    vertexAttribIPointer: () => undefined,
    vertexAttribDivisor: () => undefined,

    enable: () => undefined,
    disable: () => undefined,
    blendFuncSeparate: () => undefined,
    depthFunc: () => undefined,
    depthMask: () => undefined,
    viewport: () => undefined,
    clearColor: () => undefined,
    clearDepth: () => undefined,
    clear: () => undefined,

    drawArrays: () => { record.drawCalls += 1 },
    drawArraysInstanced: () => { record.drawCalls += 1 },
    drawElements: () => { record.drawCalls += 1 },
    drawElementsInstanced: () => { record.drawCalls += 1 },

    getError: () => GL_ENUMS.NO_ERROR,
    getExtension: (name: string) => (available.has(name) ? {} : null),
    getParameter: (parameter: number) => {
      switch (parameter) {
        case GL_ENUMS.MAX_TEXTURE_SIZE: return 8192
        case GL_ENUMS.MAX_ARRAY_TEXTURE_LAYERS: return 256
        case GL_ENUMS.MAX_COLOR_ATTACHMENTS: return 8
        case GL_ENUMS.MAX_COMBINED_TEXTURE_IMAGE_UNITS: return 32
        case GL_ENUMS.ALIASED_POINT_SIZE_RANGE: return [1, 1024]
        default: return 0
      }
    },
  })

  // Every uniform setter routes through here, so a name the linked program does
  // not declare is recorded rather than silently dropped the way a driver would.
  const recordUniform = (location: unknown): void => {
    if (location === null || location === undefined) {
      record.missedUniforms.push({ program: currentProgram?.id ?? 'none', name: '<null location>' })
    }
  }
  for (const setter of [
    'uniform1f', 'uniform1i', 'uniform1fv', 'uniform1iv',
    'uniform2fv', 'uniform2iv', 'uniform3fv', 'uniform3iv', 'uniform4fv', 'uniform4iv',
    'uniformMatrix2fv', 'uniformMatrix3fv', 'uniformMatrix4fv',
  ]) {
    gl[setter] = (location: unknown) => recordUniform(location)
  }

  return { gl: gl as unknown as WebGL2RenderingContext, record }
}

export { GL_ENUMS }
