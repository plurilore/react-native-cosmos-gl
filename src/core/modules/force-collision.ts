import { Model, Texture, Framebuffer, GLBuffer, createQuadModel, createIndexesForBuffer } from '../../gl'
import { CoreModule } from './core-module'
import { defaultConfigValues } from '../variables'
import {
  forceCollisionBuildGridVert,
  forceCollisionBuildGridFrag,
  forceCollisionForceCollisionSpatialFrag,
} from '../shaders'

type GridTarget = { texture: Texture; fbo: Framebuffer }

/**
 * Sub-cell offsets for the grid passes.
 *
 * A single fixed grid misses collisions between points that sit either side of
 * a cell boundary — each only scans its own 3×3 neighbourhood, and a boundary
 * pair can fall outside it. Repeating the build at half-cell offsets shifts the
 * boundaries so any given pair lands inside a shared neighbourhood in at least
 * one pass.
 */
const GRID_OFFSETS: [number, number][] = [
  [0.0, 0.0],
  [0.5, 0.0],
  [0.0, 0.5],
  [0.5, 0.5],
]

const MAX_GRID_SIZE = 512

const ADDITIVE = {
  blend: true,
  blendColorSrcFactor: 'one',
  blendColorDstFactor: 'one',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one',
  depthWriteEnabled: false,
  depthCompare: 'always',
} as const

/**
 * Keeps points from overlapping, using a spatial-hash grid.
 *
 * Each tick builds the grid from scratch — points have moved — then a force
 * pass scans each point's 3×3 cell neighbourhood for overlaps. That is what
 * makes it scale: the work per point is bounded by local density rather than by
 * the graph size.
 *
 * Allocated lazily on first use, so a graph that never enables collision never
 * pays for the grid or the size texture.
 */
export class ForceCollision extends CoreModule {
  private gridTargets: GridTarget[] = []
  private sizeTexture: Texture | undefined
  private pointIndices: GLBuffer | undefined
  private buildGridCommand: Model | undefined
  private forceCommand: Model | undefined

  private gridTextureSize = 0
  private cellSize = 0
  private previousPointsTextureSize: number | undefined
  private previousSpaceSize: number | undefined

  public create (): void {
    const { device, store, data, config } = this
    if (!store.pointsTextureSize || data.pointsNumber === undefined) return

    // Scan for the largest size rather than spreading into Math.max — spreading
    // a large typed array as arguments throws a RangeError on big graphs. Sizes
    // go through the resolver because the raw array may hold NaN.
    let maxSize = config.pointDefaultSize ?? defaultConfigValues.pointDefaultSize
    if (data.pointSizes) {
      for (let i = 0; i < data.pointsNumber; i++) maxSize = Math.max(maxSize, data.getResolvedPointSize(i))
    }

    const collisionRadius = config.simulationCollisionRadius ?? 0
    const collisionPadding = config.simulationCollisionPadding ?? 0
    const effectiveRadius = (collisionRadius > 0 ? collisionRadius : maxSize * 0.5) + collisionPadding

    // Two touching points interact up to 2 × the radius apart, and the 3×3 scan
    // only reaches one cell of separation — so a cell must span the whole
    // interaction range. The offset passes shuffle cell alignment; they do not
    // extend the search radius.
    this.cellSize = Math.max(effectiveRadius * 2, 8)

    // Flooring is what keeps the fitted cell at or above the interaction range;
    // rounding up would divide the space into cells smaller than it. A large
    // radius therefore yields a coarse grid — the cell size is the constraint,
    // not the cell count.
    //
    // The point count bounds it too, at roughly two cells per axis per √n — about
    // four cells per point, which is what a spatial hash wants. Without this the
    // grid sits at its cap for any small graph with default-sized points: 512²
    // cells for a few hundred points is over a thousand cells each, and since
    // the grid is built four times at half-cell offsets it costs 16 MB of GPU
    // memory to separate a graph that would fit in a fraction of that. Coarser
    // is always safe — cells only ever grow past the interaction range, never
    // below it — and costs a little more scanning per cell instead.
    const cellsForSpace = Math.floor(store.adjustedSpaceSize / this.cellSize)
    const cellsForPoints = Math.ceil(2 * Math.sqrt(Math.max(1, data.pointsNumber)))
    this.gridTextureSize = Math.max(1, Math.min(MAX_GRID_SIZE, cellsForSpace, cellsForPoints))
    this.cellSize = store.adjustedSpaceSize / this.gridTextureSize

    // Scratch buffers, cleared and rebuilt every tick — reuse them whenever the
    // dimensions still match instead of reallocating on every create().
    const gridTargetsValid =
      this.gridTargets.length === GRID_OFFSETS.length &&
      this.gridTargets.every((t) => !t.texture.destroyed && t.texture.width === this.gridTextureSize)
    if (!gridTargetsValid) {
      this.destroyGridTargets()
      this.gridTargets = GRID_OFFSETS.map((_, i) => {
        const texture = new Texture(device, {
          width: this.gridTextureSize,
          height: this.gridTextureSize,
          format: 'rgba32float',
          id: `collision-grid-${i}`,
        })
        const fbo = new Framebuffer(device, { colorAttachments: [texture], id: `collision-grid-${i}` })
        return { texture, fbo }
      })
    }

    const sizeState = new Float32Array(store.pointsTextureSize * store.pointsTextureSize * 4)
    for (let i = 0; i < data.pointsNumber; i++) sizeState[i * 4] = data.getResolvedPointSize(i)

    if (!this.sizeTexture || this.sizeTexture.width !== store.pointsTextureSize) {
      this.sizeTexture?.destroy()
      this.sizeTexture = new Texture(device, {
        width: store.pointsTextureSize,
        height: store.pointsTextureSize,
        format: 'rgba32float',
        data: sizeState,
        id: 'collision-size',
      })
    } else {
      this.sizeTexture.write(sizeState)
    }

    if (!this.pointIndices || this.previousPointsTextureSize !== store.pointsTextureSize) {
      this.pointIndices?.destroy()
      this.pointIndices = new GLBuffer(device, 'vertex', createIndexesForBuffer(store.pointsTextureSize))
    }

    this.previousPointsTextureSize = store.pointsTextureSize
    this.previousSpaceSize = store.adjustedSpaceSize
  }

  public initPrograms (): void {
    const { device } = this
    this.buildGridCommand ||= new Model(device, {
      id: 'collision-build-grid',
      vs: forceCollisionBuildGridVert,
      fs: forceCollisionBuildGridFrag,
      topology: 'point-list',
      parameters: ADDITIVE,
    })
    this.forceCommand ||= createQuadModel(device, {
      id: 'force-collision-spatial',
      fs: forceCollisionForceCollisionSpatialFrag,
      parameters: ADDITIVE,
    })
  }

  public run (): void {
    const { store, data, points, config } = this
    const buildGrid = this.buildGridCommand
    const force = this.forceCommand
    if (!buildGrid || !force || !points?.previousPositionTexture || !points.velocityFbo) return
    if (!this.pointIndices || !this.sizeTexture || data.pointsNumber === undefined) return
    if (this.gridTargets.length !== GRID_OFFSETS.length) return
    // Both the grid build and the force accumulation blend additively.
    if (!this.device.features.floatBlend) return
    // Sizes changed and `create()` has not caught up yet.
    if (store.pointsTextureSize !== this.previousPointsTextureSize) return
    if (store.adjustedSpaceSize !== this.previousSpaceSize) return

    const collisionRadius = config.simulationCollisionRadius ?? 0
    const collisionPadding = config.simulationCollisionPadding ?? 0

    buildGrid.setAttributes({ pointIndices: { buffer: this.pointIndices, size: 2 } })
    buildGrid.vertexCount = data.pointsNumber
    buildGrid.setTextures({
      positionsTexture: points.previousPositionTexture,
      sizeTexture: this.sizeTexture,
      exitTexture: points.exitTexture,
    })
    for (const [i, gridOffset] of GRID_OFFSETS.entries()) {
      const target = this.gridTargets[i]
      if (!target || target.fbo.destroyed) continue
      buildGrid.setUniforms({
        gridTextureSize: this.gridTextureSize,
        cellSize: this.cellSize,
        gridOffset,
      })
      target.fbo.clear(0, 0, 0, 0)
      buildGrid.draw(target.fbo)
    }

    // All four offset passes accumulate into the velocity target, cleared once.
    points.velocityFbo.clear(0, 0, 0, 0)
    force.setTextures({
      positionsTexture: points.previousPositionTexture,
      sizeTexture: this.sizeTexture,
    })
    for (const [i, gridOffset] of GRID_OFFSETS.entries()) {
      const target = this.gridTargets[i]
      if (!target || target.texture.destroyed) continue
      force.setUniforms({
        gridTextureSize: this.gridTextureSize,
        cellSize: this.cellSize,
        alpha: store.alpha,
        collisionStrength: config.simulationCollision ?? 0,
        collisionRadius,
        collisionPadding,
        pointsNumber: data.pointsNumber,
        gridOffset,
      })
      force.setTextures({ gridTexture: target.texture })
      force.draw(points.velocityFbo)
    }
  }

  public destroy (): void {
    this.destroyGridTargets()
    this.sizeTexture?.destroy()
    this.pointIndices?.destroy()
    this.buildGridCommand?.destroy()
    this.forceCommand?.destroy()
    this.sizeTexture = undefined
    this.pointIndices = undefined
    this.buildGridCommand = undefined
    this.forceCommand = undefined
  }

  private destroyGridTargets (): void {
    for (const target of this.gridTargets) {
      target.fbo.destroy()
      target.texture.destroy()
    }
    this.gridTargets = []
  }
}
