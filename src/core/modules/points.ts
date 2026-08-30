import {
  Model,
  Texture,
  Framebuffer,
  GLBuffer,
  createQuadModel,
  createIndexesForBuffer,
  updateAttributeBuffer,
  updateAttributeBuffers,
  type PipelineParameters,
} from '../../gl'
import { CoreModule } from './core-module'
import { EXIT_DEFAULT_SIZE, EXIT_DEFAULT_COLOR_CHANNEL } from '../variables'
import { isPointAbsent, glslFloatLiteral, textureSizeFor } from '../helper'
import { getRgbaColor } from '../color'
import { Transition, TransitionProperty } from '../transition'
import type { Hovered } from '../store'
import { buildPositionTextureData, buildSourcePositionTextureData } from './position-utils'
import {
  getPickingBufferSize,
  getPickingWindow,
  resolveNearestPickedPoint,
  numberArraysEqual,
  PICKING_WINDOW_SIZE,
} from './picking-utils'
import {
  pointsDrawPointsVert,
  pointsDrawPointsFrag,
  pointsUpdatePositionFrag,
  pointsInterpolatePositionFrag,
  pointsDragPointFrag,
  pointsFillPickingBufferVert,
  pointsFillSampledPointsVert,
  pointsFillSampledPointsFrag,
  pointsFillPickingBufferFrag,
  pointsTrackPositionsFrag,
  pointsFindPointsInRectFrag,
  pointsFindPointsInPolygonFrag,
  pointsDrawHighlightedVert,
  pointsDrawHighlightedFrag,
} from '../shaders'

const BLEND_PARAMETERS = {
  blend: true,
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one-minus-src-alpha',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one-minus-src-alpha',
} as const

/** Standard point drawing: blended, no depth testing. */
const DEFAULT_DRAW_PARAMETERS: PipelineParameters = {
  ...BLEND_PARAMETERS,
  depthWriteEnabled: false,
  depthCompare: 'always',
}

/**
 * Occlusion-culling pass A: opaque point interiors drawn front-to-back
 * (reversed index order) so early-z rejects fragments hidden behind nearer
 * points.
 */
const CORE_PASS_PARAMETERS: PipelineParameters = {
  blend: false,
  depthTest: true,
  depthWriteEnabled: true,
  depthCompare: 'less',
}

/**
 * Occlusion-culling pass B: antialiasing fringes and translucent points drawn
 * back-to-front, depth-tested against the cores. A point's own core fails
 * `less` at equal z, so nothing draws twice.
 */
const FRINGE_PASS_PARAMETERS: PipelineParameters = {
  ...BLEND_PARAMETERS,
  depthTest: true,
  depthWriteEnabled: false,
  depthCompare: 'less',
}

/**
 * Points: position storage, the integrator, drawing, and screen-space picking.
 *
 * Positions live in a pair of ping-ponged RGBA32F textures rather than in CPU
 * arrays. Everything downstream — the forces, the link renderer, hover, the
 * public position getters — reads `currentPositionTexture`, so it is the single
 * source of truth for where a point is. Only four things write it: the
 * integrator, the transition interpolator, a drag, and a direct upload from
 * `updatePositions()`; and the last of those only runs when no shader is about
 * to write, so the invariant "this texture matches what is on screen" holds.
 */
export class Points extends CoreModule {
  public transition: Transition | undefined

  public currentPositionTexture: Texture | undefined
  public currentPositionFbo: Framebuffer | undefined
  /**
   * The previous frame's positions, so simulation and drag shaders can read
   * them while writing the new frame — a single texture cannot be both read and
   * written in one pass. `swapFbo()` rotates the pair each frame.
   */
  public previousPositionTexture: Texture | undefined
  public previousPositionFbo: Framebuffer | undefined
  public velocityTexture: Texture | undefined
  public velocityFbo: Framebuffer | undefined

  /** Per-point `[greyout, outlined, 0, 0]`. */
  public pointStatusTexture: Texture | undefined
  /**
   * Exit status derived from NaN positions: `R` = previous absence, `G` =
   * current absence, 1 meaning absent. The single source of truth for "is this
   * point leaving or gone" — draw blends R→G by transition progress for the
   * fade, while the integrator and the forces read G to exclude absent points
   * from physics.
   *
   * While nothing is absent — the common case — this is a 1×1 all-zero
   * stand-in: any sample reads "present", the texel stays cache-resident, and
   * the full-size texture is never allocated.
   */
  public exitTexture: Texture | undefined
  public sizeTexture: Texture | undefined
  public pinnedStatusTexture: Texture | undefined
  /**
   * Mirrors point colors into a texture so the link shader can sample each
   * link's endpoint colors for gradient links. Exists only while
   * `linkColorInterpolateFromEndpoints` is on, so other graphs pay nothing.
   */
  public pointColorsTexture: Texture | undefined

  /** Start and end of a position transition, blended by `interpolatePosition()`. */
  public sourcePositionTexture: Texture | undefined
  public targetPositionTexture: Texture | undefined

  /**
   * Screen-space picking buffer holding `[index, x, y, _]` per pixel at reduced
   * resolution, with -1 meaning empty. Refilled only when the scene changed, so
   * a pick costs one small readback rather than a pass over every point.
   */
  public pickingFbo: Framebuffer | undefined
  public pickingTexture: Texture | undefined
  /** Set when positions, sizes, highlighting or the view changed since the last fill. */
  public isPickingBufferStale = true

  /** Cleared whenever GPU positions change, so cluster centroids get recomputed. */
  public areClusterCentroidsUpToDate = false

  public scaleX: ((x: number) => number) | undefined
  public scaleY: ((y: number) => number) | undefined
  public shouldSkipRescale: boolean | undefined

  private drawCommand: Model | undefined
  private drawCoreCommand: Model | undefined
  private updatePositionCommand: Model | undefined
  private interpolatePositionCommand: Model | undefined
  private dragPointCommand: Model | undefined
  private fillPickingBufferCommand: Model | undefined
  private fillSampledPointsCommand: Model | undefined
  private trackPointsCommand: Model | undefined
  private sampledPointsTexture: Texture | undefined
  private sampledPointsFbo: Framebuffer | undefined
  /** Cell size, in screen pixels, the sampling grid was last built for. */
  private sampledPointsDistance = -1
  private findPointsInRectCommand: Model | undefined

  private drawPointIndices: GLBuffer | undefined
  /** Element indices `[N-1 … 0]` for the front-to-back core pass. */
  private reversedPointIndexBuffer: GLBuffer | undefined
  /** Point count the reversed buffer was built for; -1 when it is stale. */
  private reversedPointIndexCount = -1
  private sourceColorBuffer: GLBuffer | undefined
  private targetColorBuffer: GLBuffer | undefined
  private previousColorData: Float32Array | undefined
  private sourceSizeBuffer: GLBuffer | undefined
  private targetSizeBuffer: GLBuffer | undefined
  private previousSizeData: Float32Array | undefined
  private shapeBuffer: GLBuffer | undefined
  private imageIndicesBuffer: GLBuffer | undefined
  private imageSizesBuffer: GLBuffer | undefined

  private drawHighlightedCommand: Model | undefined
  private findPointsInPolygonCommand: Model | undefined
  private polygonPathTexture: Texture | undefined
  private polygonPathLength = 0
  private searchTexture: Texture | undefined
  private searchFbo: Framebuffer | undefined
  private trackedPositionsFbo: Framebuffer | undefined
  private trackedPositionsTexture: Texture | undefined
  private trackedIndicesTexture: Texture | undefined
  private trackedIndices: number[] | undefined
  private trackedPositions: Map<number, [number, number]> | undefined
  /**
   * Guards the CPU-side tracked-position cache. Cleared on every write to
   * `currentPositionFbo` so the next read goes back to the GPU.
   */
  private isPositionsUpToDate = false

  /** Previous-frame absence per point, so the next `updateExit` can fill R. */
  private previousExitData: Float32Array | undefined
  private hasAnyAbsentPoint = false

  private transitionProgress = 1
  private shouldAnimatePointColors = false
  private shouldAnimatePointSizes = false
  private shouldAnimatePointPositions = false

  private pickingReadbackBuffer = new Float32Array(PICKING_WINDOW_SIZE * PICKING_WINDOW_SIZE * 4)
  /** View transform the picking buffer was last filled with. */
  private pickingTransform: number[] = []
  private isOcclusionCullingActive = false

  /** Compiles the models. Safe to call repeatedly; work happens once. */
  public create (): void {
    if (this.drawCommand) return
    const { device } = this

    const drawDefines = {
      EXIT_DEFAULT_SIZE: glslFloatLiteral(EXIT_DEFAULT_SIZE),
      EXIT_DEFAULT_COLOR_CHANNEL: glslFloatLiteral(EXIT_DEFAULT_COLOR_CHANNEL),
    }

    this.drawCommand = new Model(device, {
      id: 'draw-points',
      vs: pointsDrawPointsVert,
      fs: pointsDrawPointsFrag,
      defines: drawDefines,
      topology: 'point-list',
      parameters: DEFAULT_DRAW_PARAMETERS,
    })

    // Shares the draw program and every attribute buffer; differs only in
    // parameters and in walking the indices back-to-front.
    this.drawCoreCommand = new Model(device, {
      id: 'draw-points-core',
      vs: pointsDrawPointsVert,
      fs: pointsDrawPointsFrag,
      defines: drawDefines,
      topology: 'point-list',
      parameters: CORE_PASS_PARAMETERS,
    })

    this.updatePositionCommand = createQuadModel(device, {
      id: 'update-position',
      fs: pointsUpdatePositionFrag,
    })
    this.interpolatePositionCommand = createQuadModel(device, {
      id: 'interpolate-position',
      fs: pointsInterpolatePositionFrag,
    })
    this.dragPointCommand = createQuadModel(device, {
      id: 'drag-point',
      fs: pointsDragPointFrag,
    })
    this.trackPointsCommand = createQuadModel(device, {
      id: 'track-positions',
      fs: pointsTrackPositionsFrag,
    })
    this.findPointsInRectCommand = createQuadModel(device, {
      id: 'find-points-in-rect',
      fs: pointsFindPointsInRectFrag,
    })
    this.findPointsInPolygonCommand = createQuadModel(device, {
      id: 'find-points-in-polygon',
      fs: pointsFindPointsInPolygonFrag,
    })
    // One quad reused for every ring: the shader places and sizes it from the
    // point index, so hovered and focused rings are the same draw with
    // different uniforms.
    this.drawHighlightedCommand = createQuadModel(device, {
      id: 'draw-highlighted',
      vs: pointsDrawHighlightedVert,
      fs: pointsDrawHighlightedFrag,
      parameters: DEFAULT_DRAW_PARAMETERS,
    })

    this.fillPickingBufferCommand = new Model(device, {
      id: 'fill-picking-buffer',
      vs: pointsFillPickingBufferVert,
      fs: pointsFillPickingBufferFrag,
      topology: 'point-list',
      parameters: { blend: false, depthTest: false, depthWriteEnabled: false },
    })

    this.fillSampledPointsCommand = new Model(device, {
      id: 'fill-sampled-points',
      vs: pointsFillSampledPointsVert,
      fs: pointsFillSampledPointsFrag,
      topology: 'point-list',
      // No blending and no depth: each cell keeps whichever point drew last,
      // which is the whole sampling rule.
      parameters: { blend: false, depthTest: false, depthWriteEnabled: false },
    })
  }

  /**
   * Uploads positions to the GPU and (re)allocates everything sized by the
   * point count. Returns false when there is nothing to upload.
   */
  public updatePositions (): boolean {
    const { device, store, data } = this
    const { rescalePositions, enableSimulation } = this.config

    const { pointsTextureSize } = store
    if (!pointsTextureSize || !data.pointPositions || data.pointsNumber === undefined) return false

    let shouldRescale = rescalePositions
    // Without a simulation to spread points out, incoming coordinates are taken
    // literally — so an unspecified `rescalePositions` defaults to rescaling,
    // which is what makes a raw embedding or a geographic dataset show up at all.
    if (rescalePositions === undefined && !enableSimulation) shouldRescale = true
    if (this.shouldSkipRescale) shouldRescale = false

    if (shouldRescale) {
      this.rescaleInitialPointPositions()
    } else if (!this.shouldSkipRescale) {
      this.scaleX = undefined
      this.scaleY = undefined
    }
    this.shouldSkipRescale = undefined

    const sourceCount = data.sourcePointsNumber
    const targetCount = data.targetPointsNumber
    const sameCount = sourceCount === targetCount
    const shouldAnimate =
      this.transition?.isPendingFor(TransitionProperty.Positions) === true &&
      (this.transition?.duration ?? this.config.transitionDuration) > 0 &&
      Boolean(this.currentPositionTexture)

    const targetState = buildPositionTextureData(data.pointPositions, pointsTextureSize, targetCount)

    // Transition source, by case:
    //   · same count      — copy what is currently on screen
    //   · count changed   — read it back and remap, so survivors keep their place
    //   · no prior frame  — source = target (nothing to animate from)
    let animatedSourceData: Float32Array | undefined
    if (shouldAnimate) {
      this.createTransitionResources()
      if (this.sourcePositionTexture && this.targetPositionTexture) {
        if (sameCount && this.currentPositionFbo && !this.currentPositionFbo.destroyed) {
          this.copyPositionTexture(this.currentPositionFbo, this.sourcePositionTexture)
        } else if (this.currentPositionFbo) {
          const previous = new Float32Array(pointsTextureSize * pointsTextureSize * 4)
          this.currentPositionFbo.readPixels(previous)
          animatedSourceData = buildSourcePositionTextureData(
            previous,
            targetState,
            Math.min(sourceCount, targetCount),
            targetCount,
            pointsTextureSize
          )
          this.sourcePositionTexture.write(animatedSourceData)
        } else {
          this.sourcePositionTexture.write(targetState)
        }
        this.targetPositionTexture.write(targetState)
      }
    }

    this.ensurePositionTextures(pointsTextureSize)
    if (!shouldAnimate) {
      this.currentPositionTexture?.write(targetState)
      this.previousPositionTexture?.write(targetState)
    } else if (animatedSourceData) {
      // Freshly recreated textures must not be empty, and must not show the
      // target before the first interpolate frame lands.
      this.currentPositionTexture?.write(animatedSourceData)
      this.previousPositionTexture?.write(animatedSourceData)
    }

    this.areClusterCentroidsUpToDate = false
    this.isPositionsUpToDate = false
    if (this.config.enableSimulation) this.ensureSimulationResources(pointsTextureSize)

    if (!this.searchTexture || this.searchTexture.width !== pointsTextureSize) {
      this.searchFbo?.destroy()
      this.searchTexture?.destroy()
      this.searchTexture = new Texture(device, {
        width: pointsTextureSize,
        height: pointsTextureSize,
        format: 'rgba32float',
        data: targetState,
        id: 'search',
      })
      this.searchFbo = new Framebuffer(device, { colorAttachments: [this.searchTexture], id: 'search' })
    } else {
      this.searchTexture.write(targetState)
    }

    // New data invalidates whatever the picking buffer holds — its indices
    // belong to the replaced dataset.
    this.isPickingBufferStale = true

    const indexData = createIndexesForBuffer(pointsTextureSize)
    this.drawPointIndices = updateAttributeBuffer(device, this.drawPointIndices, indexData)
    // The reversed order buffer is built on demand in `draw()`; the point count
    // it must match has just changed, so drop the stale one.
    this.reversedPointIndexCount = -1

    return true
  }

  /** Per-point colors as source/target attribute pairs, so a change can animate. */
  public updateColor (): void {
    const { device, data, store } = this
    if (!data.pointColors || data.pointsNumber === undefined) return

    const shouldAnimate = this.transition?.isPendingFor(TransitionProperty.PointColors) === true
    const buffers = updateAttributeBuffers(
      device,
      data.pointColors,
      this.sourceColorBuffer,
      this.targetColorBuffer,
      shouldAnimate ? this.previousColorData : undefined,
      4
    )
    this.sourceColorBuffer = buffers.source
    this.targetColorBuffer = buffers.target
    this.previousColorData = buffers.previous

    if (this.config.linkColorInterpolateFromEndpoints) {
      this.ensurePointColorsTexture(store.pointsTextureSize, data.pointColors, data.pointsNumber)
    } else if (this.pointColorsTexture) {
      this.pointColorsTexture.destroy()
      this.pointColorsTexture = undefined
    }
    this.isPickingBufferStale = true
  }

  public updateSize (): void {
    const { device, data, store } = this
    if (!data.pointSizes || data.pointsNumber === undefined) return

    const shouldAnimate = this.transition?.isPendingFor(TransitionProperty.PointSizes) === true
    const buffers = updateAttributeBuffers(
      device,
      data.pointSizes,
      this.sourceSizeBuffer,
      this.targetSizeBuffer,
      shouldAnimate ? this.previousSizeData : undefined,
      1
    )
    this.sourceSizeBuffer = buffers.source
    this.targetSizeBuffer = buffers.target
    this.previousSizeData = buffers.previous

    // The collision force and the hover ring read sizes as a texture; the raw
    // array may hold NaN, so it goes through the resolver first.
    const textureSize = store.pointsTextureSize
    if (textureSize > 0) {
      const sizeData = new Float32Array(textureSize * textureSize * 4)
      for (let i = 0; i < data.pointsNumber; i++) sizeData[i * 4] = data.getResolvedPointSize(i)
      this.sizeTexture = this.writeOrCreate(this.sizeTexture, textureSize, sizeData, 'point-size')
    }
    this.isPickingBufferStale = true
  }

  public updateShape (): void {
    const { device, data } = this
    if (!data.pointShapes) return
    this.shapeBuffer = updateAttributeBuffer(device, this.shapeBuffer, data.pointShapes)
  }

  public updateImages (): void {
    const { device, data } = this
    if (data.pointImageIndices) {
      this.imageIndicesBuffer = updateAttributeBuffer(device, this.imageIndicesBuffer, data.pointImageIndices)
    }
    if (data.pointImageSizes) {
      this.imageSizesBuffer = updateAttributeBuffer(device, this.imageSizesBuffer, data.pointImageSizes)
    }
  }

  /** Per-point `[greyout, outlined, 0, 0]`, derived from the highlight config. */
  public updatePointStatus (): void {
    const { store, data } = this
    const textureSize = store.pointsTextureSize
    const pointsNumber = data.pointsNumber
    if (!textureSize || pointsNumber === undefined) return

    const statusData = new Float32Array(textureSize * textureSize * 4)
    const { highlightedPointSet, outlinedPointSet } = store
    // With no highlight set, nothing is greyed out — the common case, kept off
    // the per-point branch below.
    const hasHighlight = highlightedPointSet !== undefined && highlightedPointSet.size > 0
    for (let i = 0; i < pointsNumber; i++) {
      statusData[i * 4] = hasHighlight && !highlightedPointSet.has(i) ? 1 : 0
      statusData[i * 4 + 1] = outlinedPointSet?.has(i) ? 1 : 0
    }
    this.pointStatusTexture = this.writeOrCreate(this.pointStatusTexture, textureSize, statusData, 'point-status')
    this.isPickingBufferStale = true
  }

  public updatePinnedStatus (): void {
    const { store, data } = this
    const textureSize = store.pointsTextureSize
    const pointsNumber = data.pointsNumber
    if (!textureSize || pointsNumber === undefined) return

    const pinned = data.inputPinnedPoints
    const pinnedData = new Float32Array(textureSize * textureSize * 4)
    if (pinned) {
      for (const index of pinned) {
        if (data.isPointIndex(index)) pinnedData[index * 4] = 1
      }
    }
    this.pinnedStatusTexture = this.writeOrCreate(this.pinnedStatusTexture, textureSize, pinnedData, 'pinned-status')
  }

  /**
   * Rebuilds the exit texture from NaN positions.
   *
   * Kept as a 1×1 zero texture while nothing is absent, so graphs that never
   * remove a point never allocate the full-size one.
   */
  public updateExit (): void {
    const { device, store, data } = this
    const textureSize = store.pointsTextureSize
    const pointsNumber = data.pointsNumber
    if (!textureSize || pointsNumber === undefined || !data.pointPositions) return

    const current = new Float32Array(pointsNumber)
    let hasAbsent = false
    for (let i = 0; i < pointsNumber; i++) {
      const absent = isPointAbsent(data.pointPositions, i)
      current[i] = absent ? 1 : 0
      if (absent) hasAbsent = true
    }

    if (!hasAbsent && !this.hasAnyAbsentPoint) {
      if (!this.exitTexture || this.exitTexture.width !== 1) {
        this.exitTexture?.destroy()
        this.exitTexture = new Texture(device, {
          width: 1,
          height: 1,
          format: 'rgba32float',
          data: new Float32Array(4),
          id: 'exit-empty',
        })
      }
      this.previousExitData = current
      this.hasAnyAbsentPoint = false
      return
    }

    const exitData = new Float32Array(textureSize * textureSize * 4)
    for (let i = 0; i < pointsNumber; i++) {
      exitData[i * 4] = this.previousExitData?.[i] ?? current[i] ?? 0
      exitData[i * 4 + 1] = current[i] ?? 0
    }
    // A 1×1 stand-in cannot be resized in place.
    if (this.exitTexture && this.exitTexture.width !== textureSize) {
      this.exitTexture.destroy()
      this.exitTexture = undefined
    }
    this.exitTexture = this.writeOrCreate(this.exitTexture, textureSize, exitData, 'exit')
    this.previousExitData = current
    this.hasAnyAbsentPoint = hasAbsent
  }

  /** One integrator step: apply friction, advance by velocity, clamp to the space. */
  public updatePosition (): void {
    const command = this.updatePositionCommand
    if (!command || !this.currentPositionFbo || this.currentPositionFbo.destroyed) return
    if (!this.previousPositionTexture || !this.velocityTexture) return
    if (!this.pinnedStatusTexture || !this.exitTexture) return

    command.setUniforms({
      friction: this.config.simulationFriction,
      spaceSize: this.store.adjustedSpaceSize,
    })
    command.setTextures({
      positionsTexture: this.previousPositionTexture,
      velocity: this.velocityTexture,
      pinnedStatusTexture: this.pinnedStatusTexture,
      exitTexture: this.exitTexture,
    })
    // `swapFbo()` must have run first, so `previousPositionTexture` holds the
    // freshest positions for the shader to read.
    command.draw(this.currentPositionFbo)
    this.isPositionsUpToDate = false
  }

  /** Blends source → target positions at the transition's current progress. */
  public interpolatePosition (progress: number): void {
    const command = this.interpolatePositionCommand
    if (!command || !this.currentPositionFbo || this.currentPositionFbo.destroyed) return
    if (!this.sourcePositionTexture || !this.targetPositionTexture) return

    command.setUniforms({ progress })
    command.setTextures({
      sourceTexture: this.sourcePositionTexture,
      targetTexture: this.targetPositionTexture,
    })
    command.draw(this.currentPositionFbo)
    this.isPositionsUpToDate = false
    this.areClusterCentroidsUpToDate = false
    this.isPickingBufferStale = true
  }

  /** Moves the dragged point to the pointer position. */
  public drag (): void {
    const command = this.dragPointCommand
    if (!command || !this.currentPositionFbo || this.currentPositionFbo.destroyed) return
    if (!this.previousPositionTexture) return

    command.setUniforms({
      mousePos: this.store.pointerPosition,
      index: this.store.draggingPointIndex ?? -1,
    })
    command.setTextures({ positionsTexture: this.previousPositionTexture })
    command.draw(this.currentPositionFbo)
    this.isPositionsUpToDate = false
    this.isPickingBufferStale = true
  }

  /**
   * Draws the points.
   *
   * With occlusion culling on this is two passes: opaque cores front-to-back
   * with depth writes, then fringes and translucent points back-to-front,
   * depth-tested. On a dense graph the second pass's fragments are mostly
   * rejected before shading, which is where the win comes from.
   */
  public draw (viewport: readonly [number, number, number, number], target?: Framebuffer | null): void {
    const command = this.drawCommand
    const { store, data, config } = this
    if (!command || !this.currentPositionTexture || data.pointsNumber === undefined) return
    if (!this.drawPointIndices) return

    const pointsNumber = data.pointsNumber
    const uniforms = this.buildDrawUniforms()
    const attributes = this.buildDrawAttributes()
    if (!attributes) return
    const textures = {
      positionsTexture: this.currentPositionTexture,
      pointStatus: this.pointStatusTexture,
      exitTexture: this.exitTexture,
      imageAtlasCoords: null,
    }

    // Occlusion culling needs a depth buffer, which only exists when drawing
    // into a target that has one; on the default framebuffer we rely on the
    // context having been created with `depth: true`.
    const useOcclusionCulling = config.pointOcclusionCulling && config.pointOpacity >= 1
    this.isOcclusionCullingActive = useOcclusionCulling

    const reversedIndices = useOcclusionCulling ? this.ensureReversedPointIndexBuffer() : undefined
    if (useOcclusionCulling && this.drawCoreCommand && reversedIndices) {
      const core = this.drawCoreCommand
      core.setAttributes(attributes)
      core.setIndexBuffer(reversedIndices)
      core.vertexCount = pointsNumber
      core.setUniforms(uniforms)
      core.setTextures(textures)
      core.draw(target, viewport)

      command.parameters = FRINGE_PASS_PARAMETERS
    } else {
      command.parameters = DEFAULT_DRAW_PARAMETERS
    }

    command.setAttributes(attributes)
    command.setIndexBuffer(undefined)
    command.vertexCount = pointsNumber
    command.setUniforms(uniforms)
    command.setTextures(textures)
    command.draw(target, viewport)

    // Rings last, so they sit above every point rather than being overdrawn by
    // whatever happens to be painted after the one they mark.
    if (config.renderHoveredPointRing && store.hoveredPoint) {
      this.drawRing(store.hoveredPoint.index, store.hoveredPointRingColor, viewport, target)
    }
    if (store.focusedPoint) {
      this.drawRing(store.focusedPoint.index, store.focusedPointRingColor, viewport, target)
    }
  }

  /**
   * Draws one ring around a point.
   *
   * Sized from the point's *resolved* size rather than its raw value, so a
   * point using the configured default still gets a ring that fits it — the
   * raw array may hold NaN meaning "use the default".
   */
  private drawRing (
    index: number,
    color: readonly number[],
    viewport: readonly [number, number, number, number],
    target?: Framebuffer | null
  ): void {
    const command = this.drawHighlightedCommand
    const { store, config, data } = this
    if (!command || !this.currentPositionTexture || !this.pointStatusTexture) return
    if (!data.isPointIndex(index)) return

    const pointSize = data.getResolvedPointSize(index)
    const imageSize = data.pointImageSizes?.[index] ?? pointSize
    command.setUniforms({
      size: Math.max(pointSize, imageSize),
      transformationMatrix: store.transform,
      pointsTextureSize: store.pointsTextureSize,
      sizeScale: config.pointSizeScale,
      spaceSize: store.adjustedSpaceSize,
      screenSize: store.screenSize,
      scalePointsOnZoom: config.scalePointsOnZoom ? 1 : 0,
      pointIndex: index,
      maxPointSize: store.maxPointSize,
      color,
      universalPointOpacity: config.pointOpacity,
      // -1 tells the shader "not set", so it leaves the opacity alone rather
      // than treating an absent value as fully transparent.
      greyoutOpacity: config.pointGreyoutOpacity ?? -1,
      isDarkenGreyout: store.isDarkenGreyout ? 1 : 0,
      backgroundColor: store.backgroundColor,
      greyoutColor: store.greyoutPointColor,
      width: 0.85,
    })
    command.setTextures({
      positionsTexture: this.currentPositionTexture,
      pointStatus: this.pointStatusTexture,
      exitTexture: this.exitTexture,
    })
    command.draw(target, viewport)
  }

  /** Rotates the position ping-pong pair. Call before every write. */
  public swapFbo (): void {
    if (!this.currentPositionTexture || !this.previousPositionTexture) return
    if (!this.currentPositionFbo || !this.previousPositionFbo) return

    const texture = this.previousPositionTexture
    const fbo = this.previousPositionFbo
    this.previousPositionTexture = this.currentPositionTexture
    this.previousPositionFbo = this.currentPositionFbo
    this.currentPositionTexture = texture
    this.currentPositionFbo = fbo
    this.areClusterCentroidsUpToDate = false
  }

  /**
   * Refills the screen-space picking buffer, if the scene changed since the
   * last fill.
   *
   * Costs one pass over every point, so it is gated on staleness: with a static
   * view and static data, repeated picks are just small readbacks.
   */
  public updatePickingBuffer (): void {
    const command = this.fillPickingBufferCommand
    const { store, data, config } = this
    if (!command || !this.currentPositionTexture || data.pointsNumber === undefined) return
    if (!this.drawPointIndices) return

    const [screenWidth, screenHeight] = store.screenSize
    if (!screenWidth || !screenHeight) return

    const { width, height } = getPickingBufferSize(screenWidth, screenHeight)
    if (!this.pickingTexture || this.pickingTexture.width !== width || this.pickingTexture.height !== height) {
      this.pickingFbo?.destroy()
      this.pickingTexture?.destroy()
      this.pickingTexture = new Texture(this.device, {
        width, height, format: 'rgba32float', id: 'picking',
      })
      this.pickingFbo = new Framebuffer(this.device, { colorAttachments: [this.pickingTexture], id: 'picking' })
      this.isPickingBufferStale = true
    }

    const transform = Array.from(store.transform)
    if (!this.isPickingBufferStale && numberArraysEqual(transform, this.pickingTransform)) return
    this.pickingTransform = transform

    const fbo = this.pickingFbo
    if (!fbo) return
    // -1 in R marks an empty pixel; point index 0 must stay distinguishable.
    fbo.clear(-1, -1, -1, -1)

    // Falling back to another buffer here would not fail — it would read
    // whatever floats happen to be there as sizes, and pick with a wrong
    // radius. Better to skip the fill and leave the previous buffer standing.
    const sizeBuffer = this.targetSizeBuffer
    if (!sizeBuffer) return
    command.setAttributes({
      pointIndices: { buffer: this.drawPointIndices, size: 2 },
      size: { buffer: sizeBuffer, size: 1 },
      imageSize: { buffer: this.imageSizesBuffer ?? sizeBuffer, size: 1 },
    })
    command.vertexCount = data.pointsNumber
    command.setUniforms({
      ratio: config.pixelRatio,
      transformationMatrix: store.transform,
      pointsTextureSize: store.pointsTextureSize,
      sizeScale: config.pointSizeScale,
      spaceSize: store.adjustedSpaceSize,
      screenSize: store.screenSize,
      scalePointsOnZoom: config.scalePointsOnZoom ? 1 : 0,
      maxPointSize: store.maxPointSize,
      skipHighlighted: 0,
      skipGreyed: 0,
      pointDefaultSize: config.pointDefaultSize,
      pickingPixelRatio: width / screenWidth,
    })
    command.setTextures({
      positionsTexture: this.currentPositionTexture,
      pointStatus: this.pointStatusTexture,
      exitTexture: this.exitTexture,
    })
    command.draw(fbo)
    this.isPickingBufferStale = false
  }

  /**
   * The point at a screen position, or `undefined`.
   *
   * `x` and `y` are in logical pixels with a top-left origin — the coordinate
   * space gestures arrive in. The readback is a fixed small window regardless
   * of graph size, which is what makes picking affordable on a phone.
   */
  public findPointOnScreen (x: number, y: number): Hovered | undefined {
    const { store } = this
    const [screenWidth, screenHeight] = store.screenSize
    if (!screenWidth || !screenHeight) return undefined

    this.updatePickingBuffer()
    const fbo = this.pickingFbo
    if (!fbo) return undefined

    // Framebuffers read bottom-up; pointer coordinates arrive top-down.
    const flippedY = screenHeight - y
    const window = getPickingWindow(fbo.width, fbo.height, x, flippedY, screenWidth, screenHeight)
    fbo.readPixels(this.pickingReadbackBuffer, window.x, window.y, PICKING_WINDOW_SIZE, PICKING_WINDOW_SIZE)

    return resolveNearestPickedPoint(
      this.pickingReadbackBuffer,
      window.centerX - window.x,
      window.centerY - window.y
    )
  }

  /**
   * One representative point per cell of a screen-space grid.
   *
   * This is how a label layer decides what to name without reading every point
   * back: the viewport is tiled into `distance`-pixel cells, every visible
   * point draws a single pixel into its cell, and whichever draws last wins it.
   * The result is a set that is spread across the screen rather than clustered
   * where the graph happens to be dense — which is what makes labels fill the
   * view instead of piling into one corner.
   *
   * Off-screen points clip away entirely, so the candidate set is bounded by
   * the *screen*, not by the size of the graph. Returns simulation-space
   * positions, so the caller can project them itself without a second readback.
   */
  public sampleVisiblePoints (distance = 125): Map<number, [number, number]> {
    const command = this.fillSampledPointsCommand
    const { store, data } = this
    const result = new Map<number, [number, number]>()
    if (!command || !this.currentPositionTexture || !this.drawPointIndices) return result

    const pointsNumber = data.pointsNumber ?? 0
    if (pointsNumber === 0) return result

    const [screenWidth, screenHeight] = store.screenSize
    if (!screenWidth || !screenHeight) return result

    const cell = distance > 0 ? distance : 100
    const width = Math.max(1, Math.ceil(screenWidth / cell))
    const height = Math.max(1, Math.ceil(screenHeight / cell))

    if (
      !this.sampledPointsTexture ||
      this.sampledPointsTexture.width !== width ||
      this.sampledPointsTexture.height !== height ||
      this.sampledPointsDistance !== cell
    ) {
      this.sampledPointsFbo?.destroy()
      this.sampledPointsTexture?.destroy()
      this.sampledPointsTexture = new Texture(this.device, {
        width, height, format: 'rgba32float', id: 'sampled-points',
      })
      this.sampledPointsFbo = new Framebuffer(this.device, {
        colorAttachments: [this.sampledPointsTexture], id: 'sampled-points',
      })
      this.sampledPointsDistance = cell
    }

    const fbo = this.sampledPointsFbo
    if (!fbo) return result
    // Alpha 0 marks an empty cell. Index 0 is a real point, so the emptiness
    // test cannot be on the index channel.
    fbo.clear(0, 0, 0, 0)

    command.setAttributes({ pointIndices: { buffer: this.drawPointIndices, size: 2 } })
    command.vertexCount = pointsNumber
    command.setUniforms({
      pointsTextureSize: store.pointsTextureSize,
      transformationMatrix: store.transform,
      spaceSize: store.adjustedSpaceSize,
      screenSize: store.screenSize,
    })
    command.setTextures({
      positionsTexture: this.currentPositionTexture,
      exitTexture: this.exitTexture,
    })
    command.draw(fbo)

    const pixels = new Float32Array(width * height * 4)
    fbo.readPixels(pixels)
    for (let i = 0; i < width * height; i++) {
      if (pixels[i * 4 + 1] !== 1) continue
      const index = Math.round(pixels[i * 4] as number)
      if (index < 0 || index >= pointsNumber) continue
      const x = pixels[i * 4 + 2] as number
      const y = pixels[i * 4 + 3] as number
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      result.set(index, [x, y])
    }
    return result
  }

  /**
   * Registers the points whose positions should be cheap to read back.
   *
   * Reading every position back to place a handful of labels would stall the
   * pipeline on the whole texture. Instead a small pass gathers just these
   * points into a texture sized to fit them, and only that is read — so the
   * cost is set by the number of labels, not by the size of the graph.
   *
   * Pass `undefined` to stop tracking and release the resources.
   */
  public trackPointsByIndices (indices?: number[]): void {
    if (!indices || indices.length === 0) {
      this.trackedIndices = undefined
      this.trackedPositions = undefined
      this.trackedPositionsFbo?.destroy()
      this.trackedPositionsTexture?.destroy()
      this.trackedIndicesTexture?.destroy()
      this.trackedPositionsFbo = undefined
      this.trackedPositionsTexture = undefined
      this.trackedIndicesTexture = undefined
      return
    }

    this.trackedIndices = indices
    this.isPositionsUpToDate = false
    const size = textureSizeFor(indices.length)

    // The lookup table holds raw point indices, with -1 marking a slot the
    // square texture has but the caller did not fill. The shader derives the
    // texel from the position texture's current width, so the table stays valid
    // when the point grid relayouts.
    const indexData = new Float32Array(size * size * 4).fill(-1)
    for (let i = 0; i < indices.length; i++) indexData[i * 4] = indices[i] as number

    if (this.trackedIndicesTexture && this.trackedIndicesTexture.width === size) {
      this.trackedIndicesTexture.write(indexData)
    } else {
      this.trackedIndicesTexture?.destroy()
      this.trackedIndicesTexture = new Texture(this.device, {
        width: size, height: size, format: 'rgba32float', data: indexData, id: 'tracked-indices',
      })
    }

    if (!this.trackedPositionsTexture || this.trackedPositionsTexture.width !== size) {
      this.trackedPositionsFbo?.destroy()
      this.trackedPositionsTexture?.destroy()
      this.trackedPositionsTexture = new Texture(this.device, {
        width: size, height: size, format: 'rgba32float', id: 'tracked-positions',
      })
      this.trackedPositionsFbo = new Framebuffer(this.device, {
        colorAttachments: [this.trackedPositionsTexture], id: 'tracked-positions',
      })
    }
  }

  /**
   * Gathers the tracked points' current positions into the small cache texture.
   *
   * Must run after every write to `currentPositionTexture` — the simulation
   * tick, a drag, a transition frame — or the cache describes the frame before.
   */
  public trackPoints (): void {
    const command = this.trackPointsCommand
    if (!command || !this.trackedPositionsFbo || !this.trackedIndicesTexture) return
    if (!this.currentPositionTexture) return

    command.setTextures({
      positionsTexture: this.currentPositionTexture,
      trackedIndices: this.trackedIndicesTexture,
    })
    command.draw(this.trackedPositionsFbo)
  }

  /**
   * Tracked positions by point index.
   *
   * Cached while the simulation is idle, since the readback is the expensive
   * part and a settled graph returns the same answer every time.
   */
  public getTrackedPositionsMap (): Map<number, [number, number]> {
    const indices = this.trackedIndices
    const fbo = this.trackedPositionsFbo
    if (!indices || !fbo) return new Map()
    if (this.isPositionsUpToDate && this.trackedPositions) return this.trackedPositions

    const size = fbo.width
    const pixels = new Float32Array(size * size * 4)
    fbo.readPixels(pixels)

    const result = new Map<number, [number, number]>()
    const pointsNumber = this.data.pointsNumber ?? 0
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i] as number
      // The shader cannot range-check, so an index past the point count comes
      // back as zeros; dropping it here keeps a phantom point out of the map.
      if (index < 0 || index >= pointsNumber) continue
      const x = pixels[i * 4] as number
      const y = pixels[i * 4 + 1] as number
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      result.set(index, [x, y])
    }

    this.trackedPositions = result
    if (!this.store.isSimulationRunning) this.isPositionsUpToDate = true
    return result
  }

  /**
   * Point indices inside a screen-space rectangle.
   *
   * The test runs on the GPU — one output texel per point — and only the
   * results come back, so the cost does not depend on how many points match.
   */
  public findPointsInRect (rect: [[number, number], [number, number]]): number[] {
    const command = this.findPointsInRectCommand
    if (!command || !this.searchFbo || !this.currentPositionTexture || !this.sizeTexture) return []
    if (!this.exitTexture) this.updateExit()
    if (!this.exitTexture) return []

    command.setUniforms({
      spaceSize: this.store.adjustedSpaceSize,
      screenSize: this.store.screenSize,
      sizeScale: this.config.pointSizeScale,
      transformationMatrix: this.store.transform,
      ratio: this.config.pixelRatio,
      rect0: rect[0],
      rect1: rect[1],
      scalePointsOnZoom: this.config.scalePointsOnZoom ? 1 : 0,
      maxPointSize: this.store.maxPointSize,
    })
    command.setTextures({
      positionsTexture: this.currentPositionTexture,
      pointSize: this.sizeTexture,
      exitTexture: this.exitTexture,
    })
    command.draw(this.searchFbo)
    return this.readMatchedIndices()
  }

  /**
   * Point indices inside a screen-space polygon — the lasso-selection query.
   *
   * The path is uploaded as a texture rather than as uniforms, so a lasso of any
   * length works without recompiling the shader for a new array bound.
   */
  public findPointsInPolygon (path: [number, number][]): number[] {
    const command = this.findPointsInPolygonCommand
    if (!command || !this.searchFbo || !this.currentPositionTexture) return []
    if (path.length < 3) return []
    if (!this.exitTexture) this.updateExit()
    if (!this.exitTexture) return []

    this.updatePolygonPath(path)
    if (!this.polygonPathTexture) return []

    command.setUniforms({
      spaceSize: this.store.adjustedSpaceSize,
      screenSize: this.store.screenSize,
      transformationMatrix: this.store.transform,
      polygonPathLength: this.polygonPathLength,
    })
    command.setTextures({
      positionsTexture: this.currentPositionTexture,
      polygonPathTexture: this.polygonPathTexture,
      exitTexture: this.exitTexture,
    })
    command.draw(this.searchFbo)
    return this.readMatchedIndices()
  }

  /** Current point positions, read back from the GPU as `[x0, y0, x1, y1, …]`. */
  public getPointPositions (): Float32Array {
    const { store, data } = this
    const pointsNumber = data.pointsNumber ?? 0
    const result = new Float32Array(pointsNumber * 2)
    const fbo = this.currentPositionFbo
    if (!fbo || pointsNumber === 0) return result

    const size = store.pointsTextureSize
    const pixels = new Float32Array(size * size * 4)
    fbo.readPixels(pixels)
    for (let i = 0; i < pointsNumber; i++) {
      result[i * 2] = pixels[i * 4] as number
      result[i * 2 + 1] = pixels[i * 4 + 1] as number
    }
    return result
  }

  /**
   * Reads the search buffer and collects the matching indices.
   *
   * Bounded by the real point count: the texture is square, so texels past the
   * count hold position (0, 0) and would match any area covering the space
   * origin — reporting points that do not exist.
   */
  private readMatchedIndices (): number[] {
    const fbo = this.searchFbo
    const pointsNumber = this.data.pointsNumber ?? 0
    if (!fbo || pointsNumber === 0) return []
    const size = this.store.pointsTextureSize
    const pixels = new Float32Array(size * size * 4)
    fbo.readPixels(pixels)

    const result: number[] = []
    for (let i = 0; i < pointsNumber; i += 1) {
      if (pixels[i * 4] !== 0) result.push(i)
    }
    return result
  }

  /** Uploads a screen-space polygon path as an Nx1 texture of `[x, y]` pairs. */
  private updatePolygonPath (path: [number, number][]): void {
    this.polygonPathLength = path.length
    const data = new Float32Array(path.length * 4)
    for (let i = 0; i < path.length; i++) {
      data[i * 4] = path[i]?.[0] ?? 0
      data[i * 4 + 1] = path[i]?.[1] ?? 0
    }
    if (this.polygonPathTexture && this.polygonPathTexture.width === path.length) {
      this.polygonPathTexture.write(data)
      return
    }
    this.polygonPathTexture?.destroy()
    this.polygonPathTexture = new Texture(this.device, {
      width: path.length, height: 1, format: 'rgba32float', data, id: 'polygon-path',
    })
  }

  public setTransitionProgress (
    progress: number,
    animateColors: boolean,
    animateSizes: boolean,
    animatePositions: boolean
  ): void {
    this.transitionProgress = progress
    this.shouldAnimatePointColors = animateColors
    this.shouldAnimatePointSizes = animateSizes
    this.shouldAnimatePointPositions = animatePositions
  }

  public createTransitionResources (): void {
    const size = this.store.pointsTextureSize
    if (!size) return
    if (!this.sourcePositionTexture || this.sourcePositionTexture.width !== size) {
      this.sourcePositionTexture?.destroy()
      this.sourcePositionTexture = new Texture(this.device, {
        width: size, height: size, format: 'rgba32float', id: 'source-position',
      })
    }
    if (!this.targetPositionTexture || this.targetPositionTexture.width !== size) {
      this.targetPositionTexture?.destroy()
      this.targetPositionTexture = new Texture(this.device, {
        width: size, height: size, format: 'rgba32float', id: 'target-position',
      })
    }
  }

  public destroyTransitionResources (): void {
    this.sourcePositionTexture?.destroy()
    this.targetPositionTexture?.destroy()
    this.sourcePositionTexture = undefined
    this.targetPositionTexture = undefined
  }

  public destroy (): void {
    const textures = [
      this.currentPositionTexture, this.previousPositionTexture, this.velocityTexture,
      this.pointStatusTexture, this.exitTexture, this.sizeTexture, this.pinnedStatusTexture,
      this.pointColorsTexture, this.sourcePositionTexture, this.targetPositionTexture,
      this.pickingTexture, this.searchTexture, this.trackedPositionsTexture, this.trackedIndicesTexture,
      this.polygonPathTexture, this.sampledPointsTexture,
    ]
    const framebuffers = [
      this.currentPositionFbo, this.previousPositionFbo, this.velocityFbo,
      this.pickingFbo, this.searchFbo, this.trackedPositionsFbo, this.sampledPointsFbo,
    ]
    const buffers = [
      this.drawPointIndices, this.reversedPointIndexBuffer,
      this.sourceColorBuffer, this.targetColorBuffer,
      this.sourceSizeBuffer, this.targetSizeBuffer,
      this.shapeBuffer, this.imageIndicesBuffer, this.imageSizesBuffer,
    ]
    const models = [
      this.drawCommand, this.drawCoreCommand, this.updatePositionCommand,
      this.interpolatePositionCommand, this.dragPointCommand,
      this.fillPickingBufferCommand, this.fillSampledPointsCommand, this.trackPointsCommand,
      this.findPointsInRectCommand, this.findPointsInPolygonCommand,
      this.drawHighlightedCommand,
    ]
    // Framebuffers first: deleting an attached texture while its framebuffer
    // still references it is legal but leaves the target incomplete.
    for (const item of framebuffers) item?.destroy()
    for (const item of textures) item?.destroy()
    for (const item of buffers) item?.destroy()
    for (const item of models) item?.destroy()

    this.currentPositionTexture = undefined
    this.previousPositionTexture = undefined
    this.velocityTexture = undefined
    this.currentPositionFbo = undefined
    this.previousPositionFbo = undefined
    this.velocityFbo = undefined
    this.drawCommand = undefined
  }

  private buildDrawUniforms (): Record<string, number | number[] | Float32Array> {
    const { store, config, data } = this
    const greyoutColor = config.pointGreyoutColor
      ? getRgbaColor(config.pointGreyoutColor)
      : store.greyoutPointColor
    return {
      ratio: config.pixelRatio,
      transformationMatrix: store.transform,
      pointsTextureSize: store.pointsTextureSize,
      sizeScale: config.pointSizeScale,
      spaceSize: store.adjustedSpaceSize,
      screenSize: store.screenSize,
      greyoutColor,
      backgroundColor: store.backgroundColor,
      scalePointsOnZoom: config.scalePointsOnZoom ? 1 : 0,
      maxPointSize: store.maxPointSize,
      isDarkenGreyout: store.isDarkenGreyout ? 1 : 0,
      skipHighlighted: 0,
      skipGreyed: 0,
      hasImages: 0,
      imageCount: 0,
      imageAtlasCoordsTextureSize: 1,
      transitionProgress: this.transitionProgress,
      animateColors: this.shouldAnimatePointColors ? 1 : 0,
      animateSizes: this.shouldAnimatePointSizes ? 1 : 0,
      animatePositions: this.shouldAnimatePointPositions ? 1 : 0,
      pointDefaultColor: data.defaultRgba,
      pointDefaultSize: config.pointDefaultSize,
      pointsNumber: data.pointsNumber ?? 0,
      pointOpacity: config.pointOpacity,
      greyoutOpacity: config.pointGreyoutOpacity ?? 0.1,
    }
  }

  private buildDrawAttributes (): Record<string, { buffer: GLBuffer; size: number }> | undefined {
    const indices = this.drawPointIndices
    const sourceColor = this.sourceColorBuffer
    const targetColor = this.targetColorBuffer
    const sourceSize = this.sourceSizeBuffer
    const targetSize = this.targetSizeBuffer
    const shape = this.shapeBuffer
    if (!indices || !sourceColor || !targetColor || !sourceSize || !targetSize || !shape) return undefined
    return {
      pointIndices: { buffer: indices, size: 2 },
      sourceColor: { buffer: sourceColor, size: 4 },
      targetColor: { buffer: targetColor, size: 4 },
      sourceSize: { buffer: sourceSize, size: 1 },
      targetSize: { buffer: targetSize, size: 1 },
      shape: { buffer: shape, size: 1 },
      imageIndex: { buffer: this.imageIndicesBuffer ?? targetSize, size: 1 },
      imageSize: { buffer: this.imageSizesBuffer ?? targetSize, size: 1 },
    }
  }

  private ensurePositionTextures (size: number): void {
    const { device } = this
    if (!this.currentPositionTexture || this.currentPositionTexture.width !== size) {
      this.currentPositionFbo?.destroy()
      this.currentPositionTexture?.destroy()
      this.currentPositionTexture = new Texture(device, {
        width: size, height: size, format: 'rgba32float', id: 'current-position',
      })
      this.currentPositionFbo = new Framebuffer(device, {
        colorAttachments: [this.currentPositionTexture], id: 'current-position',
      })
    }
    if (!this.previousPositionTexture || this.previousPositionTexture.width !== size) {
      this.previousPositionFbo?.destroy()
      this.previousPositionTexture?.destroy()
      this.previousPositionTexture = new Texture(device, {
        width: size, height: size, format: 'rgba32float', id: 'previous-position',
      })
      this.previousPositionFbo = new Framebuffer(device, {
        colorAttachments: [this.previousPositionTexture], id: 'previous-position',
      })
    }
  }

  private ensureSimulationResources (size: number): void {
    const { device } = this
    if (!this.velocityTexture || this.velocityTexture.width !== size) {
      this.velocityFbo?.destroy()
      this.velocityTexture?.destroy()
      this.velocityTexture = new Texture(device, {
        width: size, height: size, format: 'rgba32float', id: 'velocity',
      })
      this.velocityFbo = new Framebuffer(device, {
        colorAttachments: [this.velocityTexture], id: 'velocity',
      })
      this.velocityFbo.clear(0, 0, 0, 0)
    }
  }

  private ensurePointColorsTexture (size: number, colors: Float32Array, pointsNumber: number): void {
    if (!size) return
    const data = new Float32Array(size * size * 4)
    data.set(colors.subarray(0, Math.min(colors.length, pointsNumber * 4)))
    this.pointColorsTexture = this.writeOrCreate(this.pointColorsTexture, size, data, 'point-colors')
  }

  /** Creates the texture at `size`, or rewrites it when the size already matches. */
  private writeOrCreate (
    texture: Texture | undefined,
    size: number,
    data: Float32Array,
    id: string
  ): Texture {
    if (texture && !texture.destroyed && texture.width === size && texture.height === size) {
      texture.write(data)
      return texture
    }
    texture?.destroy()
    return new Texture(this.device, { width: size, height: size, format: 'rgba32float', data, id })
  }

  /**
   * `[N-1 … 0]` element indices, so the core pass walks points front-to-back.
   *
   * Point index encodes stacking order — a higher index draws on top — so
   * reversing the walk puts the nearest points first, which is the order early-z
   * needs to reject anything behind them.
   *
   * Built on demand rather than with the other buffers: a graph that never
   * enables occlusion culling then never allocates it, and one that enables it
   * at runtime gets it on the next frame instead of waiting for a data update.
   */
  private ensureReversedPointIndexBuffer (): GLBuffer | undefined {
    const pointsNumber = this.data.pointsNumber ?? 0
    if (pointsNumber === 0) return undefined
    if (this.reversedPointIndexBuffer && this.reversedPointIndexCount === pointsNumber) {
      return this.reversedPointIndexBuffer
    }

    const indices = new Uint32Array(pointsNumber)
    for (let i = 0; i < pointsNumber; i++) indices[i] = pointsNumber - 1 - i
    if (this.reversedPointIndexBuffer && !this.reversedPointIndexBuffer.destroyed) {
      this.reversedPointIndexBuffer.write(indices)
      this.reversedPointIndexBuffer.byteLength = indices.byteLength
    } else {
      this.reversedPointIndexBuffer = new GLBuffer(this.device, 'index', indices)
    }
    this.reversedPointIndexCount = pointsNumber
    return this.reversedPointIndexBuffer
  }

  /** GPU-to-GPU copy of a position texture, avoiding a CPU round trip. */
  private copyPositionTexture (from: Framebuffer, to: Texture): void {
    const gl = this.device.gl
    this.device.bindFramebuffer(from.handle)
    this.device.bindTexture(0, to.handle, gl.TEXTURE_2D)
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, from.width, from.height)
  }

  /**
   * Maps incoming coordinates onto the simulation space.
   *
   * Positions may arrive in any range — an embedding in `[-1, 1]`, geographic
   * degrees, pixel coordinates from another tool. Without this they would land
   * in one corner of the space or outside it entirely, and the clamp in the
   * integrator would pile them on an edge.
   */
  private rescaleInitialPointPositions (): void {
    const { data, store } = this
    const positions = data.pointPositions
    const pointsNumber = data.pointsNumber
    if (!positions || !pointsNumber) return

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < pointsNumber; i++) {
      const x = positions[i * 2] as number
      const y = positions[i * 2 + 1] as number
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return

    const space = store.adjustedSpaceSize
    // A degenerate axis (every point sharing an x, a single point) would divide
    // by zero; hold that axis at the centre instead.
    const spanX = maxX - minX
    const spanY = maxY - minY
    const span = Math.max(spanX, spanY)
    // One scale for both axes, so the layout is not stretched.
    const scale = span > 0 ? (space * 0.9) / span : 1
    const offsetX = space / 2 - ((minX + maxX) / 2) * scale
    const offsetY = space / 2 - ((minY + maxY) / 2) * scale

    this.scaleX = (x: number): number => x * scale + offsetX
    this.scaleY = (y: number): number => y * scale + offsetY

    const rescaled = new Float32Array(positions.length)
    for (let i = 0; i < pointsNumber; i++) {
      rescaled[i * 2] = (positions[i * 2] as number) * scale + offsetX
      rescaled[i * 2 + 1] = (positions[i * 2 + 1] as number) * scale + offsetY
    }
    data.pointPositions = rescaled
  }
}

export { textureSizeFor }
