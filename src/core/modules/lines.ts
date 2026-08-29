import {
  Model,
  Texture,
  Framebuffer,
  GLBuffer,
  updateAttributeBuffer,
  updateAttributeBuffers,
  type PipelineParameters,
  type AttributeBinding,
} from '../../gl'
import { CoreModule } from './core-module'
import { EXIT_DEFAULT_COLOR_CHANNEL } from '../variables'
import { glslFloatLiteral, ensureVec2, ensureVec4 } from '../helper'
import { Transition, TransitionProperty } from '../transition'
import {
  withShaderModules,
  conicParametricCurveGLSL,
  linesDrawCurveLineVert,
  linesDrawCurveLineFrag,
} from '../shaders'
import {
  getPickingBufferSize,
  getPickingWindow,
  numberArraysEqual,
  PICKING_WINDOW_SIZE,
} from './picking-utils'

/** Alpha-blended link drawing. */
const BLENDED_PARAMETERS: PipelineParameters = {
  blend: true,
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one-minus-src-alpha',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one-minus-src-alpha',
  depthWriteEnabled: false,
  depthCompare: 'always',
}

/**
 * Unblended link drawing.
 *
 * Significantly faster on a dense graph — overlapping links stop generating
 * blend traffic — at the cost of correct overlap. Selected by
 * `config.linkBlending`.
 */
const OPAQUE_PARAMETERS: PipelineParameters = {
  blend: false,
  depthWriteEnabled: false,
  depthCompare: 'always',
}

/**
 * Link rendering.
 *
 * Each link is one instance of a thin triangle strip laid along a rational
 * quadratic Bézier. Straight links are the same geometry with one segment, so
 * there is a single pipeline rather than two, and toggling `curvedLinks` costs
 * nothing but a uniform.
 *
 * Endpoints are not uploaded as coordinates: `pointA` / `pointB` hold the
 * *texel* of each endpoint in the position texture, which the vertex shader
 * fetches. That is what lets links follow the simulation without any per-frame
 * CPU work — the positions never leave the GPU.
 */
export class Lines extends CoreModule {
  public transition: Transition | undefined

  private drawCurveCommand: Model | undefined
  private curveLineGeometry: Float32Array | undefined
  private curveLineBuffer: GLBuffer | undefined
  private curveLineVertexCount = 0

  private pointABuffer: GLBuffer | undefined
  private pointBBuffer: GLBuffer | undefined
  private sourceColorBuffer: GLBuffer | undefined
  private targetColorBuffer: GLBuffer | undefined
  private previousColorData: Float32Array | undefined
  private sourceWidthBuffer: GLBuffer | undefined
  private targetWidthBuffer: GLBuffer | undefined
  private previousWidthData: Float32Array | undefined
  private arrowBuffer: GLBuffer | undefined
  private linkIndexBuffer: GLBuffer | undefined
  private linkStyleBuffer: GLBuffer | undefined

  private linkStatusTexture: Texture | undefined
  private linkStatusTextureSize = 0

  /**
   * Screen-space link index buffer: each pixel holds the index of the link
   * drawn there, with alpha marking "a link is here" so index 0 stays
   * distinguishable from empty.
   *
   * Allocated only once a link-hover or link-click callback exists, so a graph
   * that never picks links never pays for a screen-sized float target.
   */
  private linkIndexTexture: Texture | undefined
  private linkIndexFbo: Framebuffer | undefined
  private drawCurvePickingCommand: Model | undefined
  /** Set when the view or the data moved since the buffer was last filled. */
  private isLinkIndexBufferStale = true
  private pickingTransform: number[] = []
  private linkPickingReadback = new Float32Array(PICKING_WINDOW_SIZE * PICKING_WINDOW_SIZE * 4)

  private transitionProgress = 1
  private shouldAnimateLinkColors = false
  private shouldAnimateLinkWidths = false
  private shouldAnimatePositions = false
  /** Blend mode the pipeline currently carries, so it only switches on change. */
  private isBlendingEnabled: boolean | undefined

  public create (): void {
    this.updateCurveLineGeometry()
    this.updatePointsBuffer()
    this.updateColor()
    this.updateWidth()
    this.updateArrow()
    this.updateStyle()
    this.updateLinkStatus()
  }

  public initPrograms (): void {
    const { device } = this
    if (this.drawCurveCommand) return

    this.drawCurveCommand = new Model(device, {
      id: 'draw-curve-line',
      vs: withShaderModules(linesDrawCurveLineVert, conicParametricCurveGLSL),
      fs: linesDrawCurveLineFrag,
      topology: 'triangle-strip',
      defines: {
        EXIT_DEFAULT_COLOR_CHANNEL: glslFloatLiteral(EXIT_DEFAULT_COLOR_CHANNEL),
      },
      parameters: this.config.linkBlending ? BLENDED_PARAMETERS : OPAQUE_PARAMETERS,
    })
    this.isBlendingEnabled = this.config.linkBlending
  }

  /**
   * Rebuilds the strip the curve is swept along.
   *
   * The parametric positions are spaced by a squared power scale rather than
   * uniformly, so vertices cluster toward the ends of the link where the
   * curvature and the arrowhead need the resolution, instead of being wasted in
   * the straight middle.
   */
  public updateCurveLineGeometry (): void {
    const segments = this.config.curvedLinks ? Math.max(1, this.config.curvedLinkSegments) : 1
    const values: number[] = []
    for (let i = 0; i < segments; i++) values.push(-0.5 + i / segments)
    values.push(0.5)

    const geometry = new Float32Array(values.length * 4)
    values.forEach((value, i) => {
      const d = value * 2
      // d3's `scalePow().exponent(2).domain([-1, 1]).range([0, 1])`, inlined:
      // a sign-preserving square, remapped from [-1, 1] to [0, 1].
      const t = (Math.sign(d) * d * d + 1) / 2
      geometry[i * 4 + 0] = t
      geometry[i * 4 + 1] = 0.5
      geometry[i * 4 + 2] = t
      geometry[i * 4 + 3] = -0.5
    })

    this.curveLineGeometry = geometry
    this.curveLineVertexCount = values.length * 2
    this.curveLineBuffer = updateAttributeBuffer(this.device, this.curveLineBuffer, geometry)
  }

  /**
   * Uploads each link's endpoint *texels* — not coordinates.
   *
   * Links whose endpoints are not real point indices collapse to texel `(0, 0)`
   * and are skipped by the shader's absence guard, which keeps a malformed link
   * from drawing a line to the origin.
   */
  public updatePointsBuffer (): void {
    const { device, data, store } = this
    const linksNumber = data.linksNumber ?? 0
    if (!data.links || !linksNumber || !store.pointsTextureSize) return

    const pointAData = new Float32Array(linksNumber * 2)
    const pointBData = new Float32Array(linksNumber * 2)
    const linkIndices = new Float32Array(linksNumber)
    const size = store.pointsTextureSize

    for (let i = 0; i < linksNumber; i++) {
      const source = data.links[i * 2]
      const target = data.links[i * 2 + 1]
      if (data.isPointIndex(source)) {
        pointAData[i * 2] = source % size
        pointAData[i * 2 + 1] = Math.floor(source / size)
      }
      if (data.isPointIndex(target)) {
        pointBData[i * 2] = target % size
        pointBData[i * 2 + 1] = Math.floor(target / size)
      }
      linkIndices[i] = i
    }

    this.pointABuffer = updateAttributeBuffer(device, this.pointABuffer, pointAData)
    this.pointBBuffer = updateAttributeBuffer(device, this.pointBBuffer, pointBData)
    this.linkIndexBuffer = updateAttributeBuffer(device, this.linkIndexBuffer, linkIndices)
  }

  public updateColor (): void {
    const { device, data } = this
    if (!data.linkColors) return
    const shouldAnimate = this.transition?.isPendingFor(TransitionProperty.LinkColors) === true
    const buffers = updateAttributeBuffers(
      device,
      data.linkColors,
      this.sourceColorBuffer,
      this.targetColorBuffer,
      shouldAnimate ? this.previousColorData : undefined,
      4
    )
    this.sourceColorBuffer = buffers.source
    this.targetColorBuffer = buffers.target
    this.previousColorData = buffers.previous
  }

  public updateWidth (): void {
    const { device, data } = this
    if (!data.linkWidths) return
    const shouldAnimate = this.transition?.isPendingFor(TransitionProperty.LinkWidths) === true
    const buffers = updateAttributeBuffers(
      device,
      data.linkWidths,
      this.sourceWidthBuffer,
      this.targetWidthBuffer,
      shouldAnimate ? this.previousWidthData : undefined,
      1
    )
    this.sourceWidthBuffer = buffers.source
    this.targetWidthBuffer = buffers.target
    this.previousWidthData = buffers.previous
  }

  public updateArrow (): void {
    const { device, data } = this
    if (!data.linkArrows) return
    this.arrowBuffer = updateAttributeBuffer(device, this.arrowBuffer, Float32Array.from(data.linkArrows))
  }

  public updateStyle (): void {
    const { device, data } = this
    if (!data.linkStyles) return
    this.linkStyleBuffer = updateAttributeBuffer(device, this.linkStyleBuffer, data.linkStyles)
  }

  /**
   * Per-link greyout status, as `[greyedOut, 0, 0, 0]`.
   *
   * With highlighting off the texture is kept but its declared size is set to
   * 0, which is how the shader is told not to sample it — a sampler must stay
   * bound for the draw to run at all, so it cannot simply be detached.
   */
  public updateLinkStatus (): void {
    const { config, data } = this
    const linksNumber = data.linksNumber ?? 0

    if (!linksNumber || config.highlightedLinkIndices === undefined) {
      this.ensureLinkStatusPlaceholder()
      this.linkStatusTextureSize = 0
      return
    }

    const textureSize = Math.ceil(Math.sqrt(linksNumber))
    this.linkStatusTextureSize = textureSize

    const state = new Float32Array(textureSize * textureSize * 4)
    for (let i = 0; i < linksNumber; i++) state[i * 4] = 1
    for (const index of config.highlightedLinkIndices) {
      if (index >= 0 && index < linksNumber) state[index * 4] = 0
    }

    if (this.linkStatusTexture && this.linkStatusTexture.width === textureSize) {
      this.linkStatusTexture.write(state)
    } else {
      this.linkStatusTexture?.destroy()
      this.linkStatusTexture = new Texture(this.device, {
        width: textureSize, height: textureSize, format: 'rgba32float', data: state, id: 'link-status',
      })
    }
  }

  public setTransitionProgress (
    progress: number,
    animateColors: boolean,
    animateWidths: boolean,
    animatePositions: boolean
  ): void {
    this.transitionProgress = progress
    this.shouldAnimateLinkColors = animateColors
    this.shouldAnimateLinkWidths = animateWidths
    this.shouldAnimatePositions = animatePositions
  }

  public draw (viewport: readonly [number, number, number, number], target?: Framebuffer | null): void {
    const { config, points, data } = this
    const command = this.drawCurveCommand
    const linksNumber = data.linksNumber ?? 0
    if (!command || !points?.currentPositionTexture || !linksNumber) return
    if (!points.exitTexture) points.updateExit()
    if (!points.exitTexture) return

    if (!this.pointABuffer || !this.pointBBuffer) this.updatePointsBuffer()
    if (!this.targetColorBuffer) this.updateColor()
    if (!this.targetWidthBuffer) this.updateWidth()
    if (!this.arrowBuffer) this.updateArrow()
    if (!this.linkStyleBuffer) this.updateStyle()
    if (!this.curveLineBuffer) this.updateCurveLineGeometry()
    if (!this.linkStatusTexture) this.ensureLinkStatusPlaceholder()

    const attributes = this.buildAttributes()
    if (!attributes) return

    if (this.isBlendingEnabled !== config.linkBlending) {
      this.isBlendingEnabled = config.linkBlending
      command.parameters = config.linkBlending ? BLENDED_PARAMETERS : OPAQUE_PARAMETERS
    }

    command.setAttributes(attributes)
    command.vertexCount = this.curveLineVertexCount
    command.instanceCount = linksNumber
    command.setUniforms({ ...this.buildDrawUniforms(), renderMode: 0 })
    command.setTextures({
      positionsTexture: points.currentPositionTexture,
      linkStatus: this.linkStatusTexture,
      exitTexture: points.exitTexture,
      // The sampler must always have something bound, but this stand-in is
      // never read: with the gradient off the vertex shader skips the fetch,
      // and with it on `Points.updateColor()` has built the real texture.
      pointColorsTexture: points.pointColorsTexture ?? points.currentPositionTexture,
    })
    command.draw(target, viewport)
  }

  /**
   * The link under a screen position, or `undefined`.
   *
   * Links are picked by rendering their indices into an off-screen buffer and
   * reading a small window around the touch. Testing geometrically on the CPU
   * would mean walking every link and evaluating its Bezier — the GPU already
   * knows exactly which pixels each link covers, curvature, width, arrowheads
   * and all, so asking it is both cheaper and exact.
   *
   * `x` and `y` are logical pixels with a top-left origin.
   */
  public findLinkOnScreen (x: number, y: number): number | undefined {
    const [screenWidth, screenHeight] = this.store.screenSize
    if (!screenWidth || !screenHeight) return undefined
    if (!this.updateLinkIndexBuffer()) return undefined
    const fbo = this.linkIndexFbo
    if (!fbo) return undefined

    // Framebuffers read bottom-up; touches arrive top-down.
    const window = getPickingWindow(fbo.width, fbo.height, x, screenHeight - y, screenWidth, screenHeight)
    fbo.readPixels(this.linkPickingReadback, window.x, window.y, PICKING_WINDOW_SIZE, PICKING_WINDOW_SIZE)

    return resolveNearestLink(
      this.linkPickingReadback,
      window.centerX - window.x,
      window.centerY - window.y
    )
  }

  /** Marks the index buffer for a refill — the view or the data moved. */
  public markLinkPickingStale (): void {
    this.isLinkIndexBufferStale = true
  }

  /**
   * Refills the link index buffer if the scene changed. Returns whether a
   * usable buffer exists.
   *
   * Gated on staleness for the same reason point picking is: the fill costs a
   * pass over every link, and repeated taps on a static view should cost only
   * the small readback.
   */
  private updateLinkIndexBuffer (): boolean {
    const { device, store, config, points, data } = this
    const linksNumber = data.linksNumber ?? 0
    if (!points?.currentPositionTexture || !linksNumber) return false
    if (!points.exitTexture) points.updateExit()
    if (!points.exitTexture) return false

    const [screenWidth, screenHeight] = store.screenSize
    if (!screenWidth || !screenHeight) return false

    // Reduced resolution, like point picking: a screen-sized RGBA32F target is
    // tens of megabytes on a modern phone, and the window scan below recovers
    // the precision that costs.
    const { width, height } = getPickingBufferSize(screenWidth, screenHeight)
    if (!this.linkIndexTexture || this.linkIndexTexture.width !== width || this.linkIndexTexture.height !== height) {
      this.linkIndexFbo?.destroy()
      this.linkIndexTexture?.destroy()
      this.linkIndexTexture = new Texture(device, {
        width, height, format: 'rgba32float', id: 'link-index',
      })
      this.linkIndexFbo = new Framebuffer(device, {
        colorAttachments: [this.linkIndexTexture], id: 'link-index',
      })
      this.isLinkIndexBufferStale = true
    }

    const fbo = this.linkIndexFbo
    if (!fbo) return false

    const transform = Array.from(store.transform)
    if (!this.isLinkIndexBufferStale && numberArraysEqual(transform, this.pickingTransform)) return true
    this.pickingTransform = transform

    const attributes = this.buildAttributes()
    if (!attributes) return false

    // Never blended: the pass writes exact index values, and blending would mix
    // two links' indices into a third link that does not exist.
    this.drawCurvePickingCommand ||= new Model(device, {
      id: 'draw-curve-line-picking',
      vs: withShaderModules(linesDrawCurveLineVert, conicParametricCurveGLSL),
      fs: linesDrawCurveLineFrag,
      topology: 'triangle-strip',
      defines: { EXIT_DEFAULT_COLOR_CHANNEL: glslFloatLiteral(EXIT_DEFAULT_COLOR_CHANNEL) },
      parameters: OPAQUE_PARAMETERS,
    })

    const command = this.drawCurvePickingCommand
    command.setAttributes(attributes)
    command.vertexCount = this.curveLineVertexCount
    command.instanceCount = linksNumber
    command.setUniforms({
      ...this.buildDrawUniforms(),
      renderMode: 1,
      // Mirrors the *visible* blend mode rather than this pass's own: a link
      // hidden by unblended rendering must not be pickable, and one visible
      // under blending must be.
      linkBlending: config.linkBlending ? 1 : 0,
    })
    command.setTextures({
      positionsTexture: points.currentPositionTexture,
      linkStatus: this.linkStatusTexture,
      exitTexture: points.exitTexture,
      pointColorsTexture: points.pointColorsTexture ?? points.currentPositionTexture,
    })

    // Alpha 0 is "no link here", which is what makes link index 0 readable.
    fbo.clear(-1, 0, 0, 0)
    command.draw(fbo)
    this.isLinkIndexBufferStale = false
    return true
  }

  public destroy (): void {
    this.linkIndexFbo?.destroy()
    this.linkIndexTexture?.destroy()
    this.drawCurvePickingCommand?.destroy()
    this.drawCurveCommand?.destroy()
    this.linkStatusTexture?.destroy()
    const buffers = [
      this.curveLineBuffer, this.pointABuffer, this.pointBBuffer,
      this.sourceColorBuffer, this.targetColorBuffer,
      this.sourceWidthBuffer, this.targetWidthBuffer,
      this.arrowBuffer, this.linkIndexBuffer, this.linkStyleBuffer,
    ]
    for (const buffer of buffers) buffer?.destroy()
    this.drawCurveCommand = undefined
    this.linkStatusTexture = undefined
    this.curveLineBuffer = undefined
    this.pointABuffer = undefined
    this.pointBBuffer = undefined
  }

  /**
   * Uniforms shared by the visible draw and the picking pass.
   *
   * Shared deliberately: the index buffer is only useful if it agrees with what
   * is on screen down to curvature, width and visibility, and two copies of
   * thirty uniforms would drift the first time one was edited.
   */
  private buildDrawUniforms (): Record<string, number | number[] | Float32Array> {
    const { config, store, data } = this
    return {
      transformationMatrix: store.transform,
      widthScale: config.linkWidthScale,
      linkArrowsSizeScale: config.linkArrowsSizeScale,
      spaceSize: store.adjustedSpaceSize,
      screenSize: ensureVec2(store.screenSize, [0, 0]),
      linkVisibilityDistanceRange: ensureVec2(config.linkVisibilityDistanceRange, [50, 150]),
      linkVisibilityMinTransparency: config.linkVisibilityMinTransparency,
      linkOpacity: config.linkOpacity,
      greyoutOpacity: config.linkGreyoutOpacity,
      curvedWeight: config.curvedLinkWeight,
      curvedLinkControlPointDistance: config.curvedLinkControlPointDistance,
      curvedLinkSegments: config.curvedLinks ? config.curvedLinkSegments : 1,
      scaleLinksOnZoom: config.scaleLinksOnZoom ? 1 : 0,
      maxPointSize: store.maxPointSize,
      hoveredLinkIndex: store.hoveredLinkIndex ?? -1,
      hoveredLinkWidthIncrease: config.hoveredLinkWidthIncrease,
      isLinkHighlightingActive: config.highlightedLinkIndices !== undefined ? 1 : 0,
      linkStatusTextureSize: this.linkStatusTextureSize,
      focusedLinkIndex: config.focusedLinkIndex ?? -1,
      focusedLinkWidthIncrease: config.focusedLinkWidthIncrease,
      transitionProgress: this.transitionProgress,
      animateColors: this.shouldAnimateLinkColors ? 1 : 0,
      animateWidths: this.shouldAnimateLinkWidths ? 1 : 0,
      animatePositions: this.shouldAnimatePositions ? 1 : 0,
      // Cached parse — `draw` runs every frame, so no color-string parsing here.
      pointDefaultColor: ensureVec4(data.defaultRgba, [0, 0, 0, 1]),
      linkColorInterpolateFromEndpoints: config.linkColorInterpolateFromEndpoints ? 1 : 0,
      linkBlending: config.linkBlending ? 1 : 0,
      linkDashLength: config.linkDashLength,
      linkDashGap: config.linkDashGap,
      hoveredLinkColor: ensureVec4(store.hoveredLinkColor, [-1, -1, -1, -1]),
    }
  }

  private buildAttributes (): Record<string, AttributeBinding> | undefined {
    const position = this.curveLineBuffer
    const pointA = this.pointABuffer
    const pointB = this.pointBBuffer
    const sourceColor = this.sourceColorBuffer
    const targetColor = this.targetColorBuffer
    const sourceWidth = this.sourceWidthBuffer
    const targetWidth = this.targetWidthBuffer
    const arrow = this.arrowBuffer
    const linkIndices = this.linkIndexBuffer
    const linkStyle = this.linkStyleBuffer
    if (
      !position || !pointA || !pointB || !sourceColor || !targetColor ||
      !sourceWidth || !targetWidth || !arrow || !linkIndices || !linkStyle
    ) return undefined

    // `position` walks the strip per vertex; everything else advances once per
    // link, which is what makes one draw call cover the whole graph.
    return {
      position: { buffer: position, size: 2 },
      pointA: { buffer: pointA, size: 2, divisor: 1 },
      pointB: { buffer: pointB, size: 2, divisor: 1 },
      sourceColor: { buffer: sourceColor, size: 4, divisor: 1 },
      targetColor: { buffer: targetColor, size: 4, divisor: 1 },
      sourceWidth: { buffer: sourceWidth, size: 1, divisor: 1 },
      targetWidth: { buffer: targetWidth, size: 1, divisor: 1 },
      arrow: { buffer: arrow, size: 1, divisor: 1 },
      linkIndices: { buffer: linkIndices, size: 1, divisor: 1 },
      linkStyle: { buffer: linkStyle, size: 1, divisor: 1 },
    }
  }

  private ensureLinkStatusPlaceholder (): void {
    if (this.linkStatusTexture && !this.linkStatusTexture.destroyed) return
    this.linkStatusTexture = new Texture(this.device, {
      width: 1, height: 1, format: 'rgba32float', data: new Float32Array(4), id: 'link-status-placeholder',
    })
  }
}

/**
 * Scans a window of `[linkIndex, _, _, hit]` pixels for the link nearest the
 * touch.
 *
 * Alpha marks occupancy rather than the index doing it, so link 0 stays
 * distinguishable from an empty pixel — the bug that would otherwise make the
 * first link in the data selectable from anywhere on screen.
 */
function resolveNearestLink (pixels: Float32Array, cursorX: number, cursorY: number): number | undefined {
  let bestIndex: number | undefined
  let bestDistanceSq = Infinity
  for (let py = 0; py < PICKING_WINDOW_SIZE; py += 1) {
    for (let px = 0; px < PICKING_WINDOW_SIZE; px += 1) {
      const offset = (py * PICKING_WINDOW_SIZE + px) * 4
      if ((pixels[offset + 3] as number) <= 0) continue
      const index = pixels[offset] as number
      if (index < 0) continue
      const dx = px + 0.5 - cursorX
      const dy = py + 0.5 - cursorY
      const distanceSq = dx * dx + dy * dy
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq
        bestIndex = Math.round(index)
      }
    }
  }
  return bestIndex
}
