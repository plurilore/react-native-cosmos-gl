import {
  Model,
  Texture,
  Framebuffer,
  GLBuffer,
  createQuadModel,
  createIndexesForBuffer,
  type PipelineParameters,
} from '../../gl'
import { CoreModule } from './core-module'
import { ensureVec2 } from '../helper'
import {
  forceGravityForceGravityFrag,
  forceCenterCalculateCentermassVert,
  forceCenterCalculateCentermassFrag,
  forceCenterForceCenterFrag,
  forceMouseForceMouseFrag,
  forceManyBodyCalculateLevelVert,
  forceManyBodyCalculateLevelFrag,
  forceManyBodyForceLevelFrag,
  forceManyBodyForceNearfieldFrag,
  forceManyBodyForceAllpairsFrag,
  forceManyBodyBuildNearfieldSlotsVert,
  forceManyBodyBuildNearfieldSlotsFrag,
  forceLinkSpringFrag,
} from '../shaders'

/**
 * Additive accumulation into the velocity target.
 *
 * Requires `EXT_float_blend`. Modules that need it check
 * `device.features.floatBlend` and take a non-blending path when it is absent —
 * an old Android device is then slower or less exact rather than broken.
 */
const ADDITIVE: PipelineParameters = {
  blend: true,
  blendColorSrcFactor: 'one',
  blendColorDstFactor: 'one',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one',
  depthWriteEnabled: false,
  depthCompare: 'always',
}

/** A single full-screen write, replacing whatever the target held. */
const REPLACE: PipelineParameters = {
  blend: false,
  depthWriteEnabled: false,
  depthCompare: 'always',
}

/**
 * Pull toward the centre of the simulation space.
 *
 * The simplest force in the engine, and the one that establishes the pattern
 * every other follows: clear the shared velocity target, write this force's
 * contribution, and let `Points.updatePosition()` integrate it. Each force gets
 * its own clear-and-integrate cycle rather than accumulating into a common
 * velocity, so a strong force cannot swamp a weak one within a tick.
 */
export class ForceGravity extends CoreModule {
  private runCommand: Model | undefined

  public initPrograms (): void {
    if (!this.points || !this.store.pointsTextureSize) return
    this.runCommand ||= createQuadModel(this.device, {
      id: 'force-gravity',
      fs: forceGravityForceGravityFrag,
      parameters: REPLACE,
    })
  }

  public run (): void {
    const { points, store } = this
    const command = this.runCommand
    if (!command || !points?.previousPositionTexture || !points.velocityFbo) return

    command.setUniforms({
      gravity: this.config.simulationGravity,
      spaceSize: store.adjustedSpaceSize,
      alpha: store.alpha,
    })
    command.setTextures({ positionsTexture: points.previousPositionTexture })
    points.velocityFbo.clear(0, 0, 0, 0)
    command.draw(points.velocityFbo)
  }

  public destroy (): void {
    this.runCommand?.destroy()
    this.runCommand = undefined
  }
}

/**
 * Pull toward the centroid of all points.
 *
 * Unlike gravity, the target is not fixed — so a first pass sums every point's
 * position into a 1×1 texture by additive blending, and the force pass divides
 * by the count it accumulated alongside.
 */
export class ForceCenter extends CoreModule {
  private centermassTexture: Texture | undefined
  private centermassFbo: Framebuffer | undefined
  private pointIndices: GLBuffer | undefined
  private calculateCentermassCommand: Model | undefined
  private runCommand: Model | undefined
  private previousPointsTextureSize: number | undefined

  public create (): void {
    const { device, store } = this
    const { pointsTextureSize } = store
    if (!pointsTextureSize) return

    if (!this.centermassTexture) {
      this.centermassTexture = new Texture(device, {
        width: 1, height: 1, format: 'rgba32float', data: new Float32Array(4), id: 'centermass',
      })
      this.centermassFbo = new Framebuffer(device, {
        colorAttachments: [this.centermassTexture], id: 'centermass',
      })
    }

    if (!this.pointIndices || this.previousPointsTextureSize !== pointsTextureSize) {
      this.pointIndices?.destroy()
      this.pointIndices = new GLBuffer(device, 'vertex', createIndexesForBuffer(pointsTextureSize))
    }
    this.previousPointsTextureSize = pointsTextureSize
  }

  public initPrograms (): void {
    const { device, store, points } = this
    if (!points || !store.pointsTextureSize || !this.centermassFbo) return

    this.calculateCentermassCommand ||= new Model(device, {
      id: 'calculate-centermass',
      vs: forceCenterCalculateCentermassVert,
      fs: forceCenterCalculateCentermassFrag,
      topology: 'point-list',
      parameters: ADDITIVE,
    })
    this.runCommand ||= createQuadModel(device, {
      id: 'force-center',
      fs: forceCenterForceCenterFrag,
      parameters: REPLACE,
    })
  }

  public run (): void {
    const { points, store, data } = this
    const aggregate = this.calculateCentermassCommand
    const command = this.runCommand
    if (!aggregate || !command || !points?.previousPositionTexture || !points.velocityFbo) return
    if (!this.centermassFbo || !this.centermassTexture || !this.pointIndices) return
    if (!data.pointsNumber) return

    // Without float blending the sum cannot accumulate; skipping is better than
    // centring on a partial total.
    if (!this.device.features.floatBlend) return

    aggregate.setAttributes({ pointIndices: { buffer: this.pointIndices, size: 2 } })
    aggregate.vertexCount = data.pointsNumber
    aggregate.setUniforms({ pointsTextureSize: store.pointsTextureSize })
    aggregate.setTextures({
      positionsTexture: points.previousPositionTexture,
      exitTexture: points.exitTexture,
    })
    this.centermassFbo.clear(0, 0, 0, 0)
    aggregate.draw(this.centermassFbo)

    command.setUniforms({
      centerForce: this.config.simulationCenter,
      alpha: store.alpha,
    })
    command.setTextures({
      positionsTexture: points.previousPositionTexture,
      centermassTexture: this.centermassTexture,
    })
    points.velocityFbo.clear(0, 0, 0, 0)
    command.draw(points.velocityFbo)
  }

  public destroy (): void {
    this.centermassFbo?.destroy()
    this.centermassTexture?.destroy()
    this.pointIndices?.destroy()
    this.calculateCentermassCommand?.destroy()
    this.runCommand?.destroy()
    this.centermassFbo = undefined
    this.centermassTexture = undefined
    this.pointIndices = undefined
    this.calculateCentermassCommand = undefined
    this.runCommand = undefined
  }
}

/** Repulsion from the pointer, pushing points out of the way of a press. */
export class ForceMouse extends CoreModule {
  private runCommand: Model | undefined

  public initPrograms (): void {
    if (!this.points || !this.store.pointsTextureSize) return
    this.runCommand ||= createQuadModel(this.device, {
      id: 'force-mouse',
      fs: forceMouseForceMouseFrag,
      parameters: REPLACE,
    })
  }

  public run (): void {
    const { points, store } = this
    const command = this.runCommand
    if (!command || !points?.previousPositionTexture || !points.velocityFbo) return

    command.setUniforms({
      repulsion: this.config.simulationRepulsionFromMouse,
      spaceSize: store.adjustedSpaceSize,
      mousePosition: ensureVec2(store.pointerPosition, [0, 0]),
    })
    command.setTextures({ positionsTexture: points.previousPositionTexture })
    points.velocityFbo.clear(0, 0, 0, 0)
    command.draw(points.velocityFbo)
  }

  public destroy (): void {
    this.runCommand?.destroy()
    this.runCommand = undefined
  }
}

export enum LinkDirection {
  Outgoing = 'outgoing',
  Incoming = 'incoming',
}

/**
 * Spring attraction along links.
 *
 * Runs once per direction, because a fragment shader writes one output per
 * point and a point must gather from its own adjacency list — so incoming and
 * outgoing edges cannot be accumulated in a single pass.
 *
 * The adjacency is flattened into textures at `create()` time: one texture maps
 * each point to the position and length of its slice of a shared link list, and
 * that list holds the connected point's texel plus the precomputed bias and
 * strength. The shader then walks a bounded loop over a point's own slice.
 */
export class ForceLink extends CoreModule {
  private maxPointDegree = 0
  private runCommand: Model | undefined
  private linkInfoTexture: Texture | undefined
  private linkIndicesTexture: Texture | undefined
  private linkPropertiesTexture: Texture | undefined
  private linkRandomDistanceTexture: Texture | undefined

  public create (direction: LinkDirection): void {
    const { device, store, data } = this
    const { pointsTextureSize, linksTextureSize } = store
    if (!pointsTextureSize || !linksTextureSize) return

    const linkInfo = new Float32Array(pointsTextureSize * pointsTextureSize * 4)
    const indices = new Float32Array(linksTextureSize * linksTextureSize * 4)
    const biasAndStrength = new Float32Array(linksTextureSize * linksTextureSize * 4)
    const randomDistance = new Float32Array(linksTextureSize * linksTextureSize * 4)

    const grouped = direction === LinkDirection.Incoming
      ? data.sourceIndexToTargetIndices
      : data.targetIndexToSourceIndices

    this.maxPointDegree = 0
    let linkIndex = 0
    grouped?.forEach((connected, pointIndex) => {
      if (!connected) return
      linkInfo[pointIndex * 4 + 0] = linkIndex % linksTextureSize
      linkInfo[pointIndex * 4 + 1] = Math.floor(linkIndex / linksTextureSize)
      linkInfo[pointIndex * 4 + 2] = connected.length

      for (const [connectedPointIndex, originalLinkIndex] of connected) {
        indices[linkIndex * 4 + 0] = connectedPointIndex % pointsTextureSize
        indices[linkIndex * 4 + 1] = Math.floor(connectedPointIndex / pointsTextureSize)

        const degree = data.degree?.[connectedPointIndex] ?? 0
        const connectedDegree = data.degree?.[pointIndex] ?? 0
        const degreeSum = degree + connectedDegree
        const bias = degreeSum !== 0 ? degree / degreeSum : 0.5

        // Strength must reach the texture finite and non-negative — `Math.sqrt`
        // of a negative emits NaN, and the position clamp downstream would then
        // land the point at (0, 0).
        let strength = data.linkStrength?.[originalLinkIndex]
        if (strength === undefined || !Number.isFinite(strength) || strength < 0) {
          strength = 1 / Math.max(Math.min(degree, connectedDegree), 1)
        }
        biasAndStrength[linkIndex * 4 + 0] = bias
        biasAndStrength[linkIndex * 4 + 1] = Math.sqrt(strength)
        randomDistance[linkIndex * 4] = store.getRandomFloat(0, 1)

        linkIndex += 1
      }

      this.maxPointDegree = Math.max(this.maxPointDegree, connected.length)
    })

    this.linkInfoTexture = this.replaceTexture(this.linkInfoTexture, pointsTextureSize, linkInfo, 'link-info')
    this.linkIndicesTexture = this.replaceTexture(this.linkIndicesTexture, linksTextureSize, indices, 'link-indices')
    this.linkPropertiesTexture = this.replaceTexture(this.linkPropertiesTexture, linksTextureSize, biasAndStrength, 'link-properties')
    this.linkRandomDistanceTexture = this.replaceTexture(this.linkRandomDistanceTexture, linksTextureSize, randomDistance, 'link-random-distance')

    // The loop bound is a compile-time constant in GLSL, so a change in the
    // maximum degree needs a fresh program.
    this.runCommand?.destroy()
    this.runCommand = undefined
    void device
  }

  public initPrograms (): void {
    const { device, store, points } = this
    if (!points || !store.pointsTextureSize || !store.linksTextureSize) return
    this.runCommand ||= createQuadModel(device, {
      id: `force-link-${this.maxPointDegree}`,
      fs: forceLinkSpringFrag(this.maxPointDegree),
      parameters: REPLACE,
    })
  }

  public run (): void {
    const { points, store, config } = this
    const command = this.runCommand
    if (!command || !points?.previousPositionTexture || !points.velocityFbo) return
    if (!this.linkInfoTexture || !this.linkIndicesTexture) return
    if (!this.linkPropertiesTexture || !this.linkRandomDistanceTexture) return

    command.setUniforms({
      linkSpring: config.simulationLinkSpring,
      linkDistance: config.simulationLinkDistance,
      linkDistRandomVariationRange: ensureVec2(config.simulationLinkDistRandomVariationRange, [1, 1.2]),
      linksTextureSize: store.linksTextureSize,
      alpha: store.alpha,
    })
    command.setTextures({
      positionsTexture: points.previousPositionTexture,
      exitTexture: points.exitTexture,
      linkInfoTexture: this.linkInfoTexture,
      linkIndicesTexture: this.linkIndicesTexture,
      linkPropertiesTexture: this.linkPropertiesTexture,
      linkRandomDistanceTexture: this.linkRandomDistanceTexture,
    })
    points.velocityFbo.clear(0, 0, 0, 0)
    command.draw(points.velocityFbo)
  }

  public destroy (): void {
    this.linkInfoTexture?.destroy()
    this.linkIndicesTexture?.destroy()
    this.linkPropertiesTexture?.destroy()
    this.linkRandomDistanceTexture?.destroy()
    this.runCommand?.destroy()
    this.linkInfoTexture = undefined
    this.linkIndicesTexture = undefined
    this.linkPropertiesTexture = undefined
    this.linkRandomDistanceTexture = undefined
    this.runCommand = undefined
  }

  private replaceTexture (
    texture: Texture | undefined,
    size: number,
    data: Float32Array,
    id: string
  ): Texture {
    if (texture && !texture.destroyed && texture.width === size) {
      texture.write(data)
      return texture
    }
    texture?.destroy()
    return new Texture(this.device, { width: size, height: size, format: 'rgba32float', data, id })
  }
}

/**
 * Finest grid resolution per axis for a point count: ~2·√n, floored at 8²,
 * capped at `MAX_GRID_SIZE`.
 */
const MAX_GRID_SIZE = 512
const getFinestGridSize = (pointsNumber: number): number =>
  Math.min(MAX_GRID_SIZE, Math.max(8, Math.pow(2, Math.ceil(Math.log2(2 * Math.sqrt(pointsNumber))))))

/**
 * Points per finest-level cell that get exact pairwise repulsion each tick.
 *
 * A cell holding at most this many points is sampled exhaustively. Above it a
 * fresh random subset is drawn every tick and Horvitz–Thompson weighted —
 * unbiased, but the per-tick redraw makes the estimate noisy in proportion to
 * occupancy over slots, which shows up as per-point shimmer wherever something
 * keeps density high while alpha is still large.
 *
 * So the count scales down as the graph grows: small graphs get enough slots to
 * cover realistic occupancies exactly, while large graphs keep the cheap
 * estimator, where the noise is sub-pixel and the peel cost dominates instead.
 */
const getNearFieldSlotCount = (pointsNumber: number): number => {
  if (pointsNumber <= 16384) return 32
  if (pointsNumber <= 65536) return 16
  return 8
}

/**
 * Memory the near-field slot array is allowed, in bytes.
 *
 * The slot count above is tuned for desktop, where 32 slots over a 256² grid —
 * 17 MB — is unremarkable. On a phone sharing GPU memory with the rest of the
 * app it is not, and it is spent at exactly the size where the grid path first
 * engages. So the count is additionally capped to fit this budget.
 *
 * The trade is real and worth stating: fewer slots means a noisier Monte-Carlo
 * near field, visible as per-point shimmer while alpha is high in dense
 * regions. It binds only where the array would be large — small graphs keep
 * their full slot count, because their grids are small enough that 32 slots
 * cost little.
 */
const NEAR_FIELD_SLOT_BUDGET_BYTES = 4 * 1024 * 1024

/** Slot count for a grid, clamped to the memory budget. */
const getBudgetedSlotCount = (pointsNumber: number, gridSize: number): number => {
  const preferred = getNearFieldSlotCount(pointsNumber)
  // rg32float: two 32-bit channels per texel.
  const bytesPerSlot = gridSize * gridSize * 8
  if (bytesPerSlot <= 0) return preferred
  const affordable = Math.floor(NEAR_FIELD_SLOT_BUDGET_BYTES / bytesPerSlot)
  // Never below the count upstream uses for its largest graphs — past that the
  // estimator degrades faster than the memory saving is worth.
  return Math.max(8, Math.min(preferred, affordable))
}

/**
 * At or below this count the force is computed exactly in one all-pairs pass.
 *
 * Two reasons it wins there. It has zero sampling noise at any occupancy, where
 * the sampled near field jitters visibly once a small dense graph concentrates
 * hundreds of points in one cell. And it is cheaper: depth peeling is inherently
 * sequential — one render pass per slot — and at small counts that fixed cost
 * dominates the actual work.
 */
const ALL_PAIRS_MAX_POINTS = 4096

const PEEL_TARGETS = 2

type LevelTarget = { texture: Texture; fbo: Framebuffer; gridSize: number }
type SlotTarget = { texture: Texture; fbo: Framebuffer }

/**
 * GPU many-body repulsion.
 *
 * Small graphs take one exact all-pairs pass. Above that, a Barnes-Hut-style
 * grid pyramid handles the far field — each level covers its aligned 6×6 child
 * block minus the Chebyshev-1 shell, so the decomposition tiles space exactly
 * once — and an unbiased Monte-Carlo near field closes the remaining 3×3
 * neighbourhood by depth-peeling a random subset of each cell's points. Close
 * points therefore repel individually rather than through a cell centroid,
 * which is what keeps dense hubs from collapsing into disks.
 */
export class ForceManyBody extends CoreModule {
  private randomValuesTexture: Texture | undefined
  private pointIndices: GLBuffer | undefined
  private levels = 0
  private levelTargets = new Map<number, LevelTarget>()
  private nearFieldSlots = 0
  private slotsArrayTexture: Texture | undefined
  private peelTargets: SlotTarget[] = []

  private calculateLevelsCommand: Model | undefined
  private forceLevelCommand: Model | undefined
  private buildNearFieldSlotsCommand: Model | undefined
  private forceNearFieldCommand: Model | undefined
  private forceAllPairsCommand: Model | undefined

  private previousPointsTextureSize: number | undefined
  private previousPointsNumber: number | undefined

  /**
   * Whether to take the exact single-pass path.
   *
   * Also forced when the device cannot blend into float targets: the pyramid
   * accumulates every level's contribution additively, so without
   * `EXT_float_blend` only the last level would survive. All-pairs writes once
   * and stays correct, at O(n²) — slow on a big graph, but not wrong.
   */
  private get usesAllPairs (): boolean {
    if (!this.device.features.floatBlend) return true
    return (this.data.pointsNumber ?? 0) <= ALL_PAIRS_MAX_POINTS
  }

  public create (): void {
    const { device, store } = this
    if (!store.pointsTextureSize) return

    if (this.usesAllPairs) {
      this.destroyLevelTargets()
      this.levels = 0
    } else {
      this.createLevels()
    }

    // A tiny random nudge per point, which keeps exactly-coincident points from
    // staying stuck to each other — the repulsion between them is zero, so
    // nothing else would ever separate them.
    const totalPixels = store.pointsTextureSize * store.pointsTextureSize
    const randomValues = new Float32Array(totalPixels * 4)
    for (let i = 0; i < totalPixels; ++i) {
      randomValues[i * 4] = store.getRandomFloat(-1, 1) * 0.00001
      randomValues[i * 4 + 1] = store.getRandomFloat(-1, 1) * 0.00001
    }
    if (!this.randomValuesTexture || this.randomValuesTexture.width !== store.pointsTextureSize) {
      this.randomValuesTexture?.destroy()
      this.randomValuesTexture = new Texture(device, {
        width: store.pointsTextureSize,
        height: store.pointsTextureSize,
        format: 'rgba32float',
        data: randomValues,
        id: 'many-body-random',
      })
    } else {
      this.randomValuesTexture.write(randomValues)
    }

    if (!this.pointIndices || this.previousPointsTextureSize !== store.pointsTextureSize) {
      this.pointIndices?.destroy()
      this.pointIndices = new GLBuffer(device, 'vertex', createIndexesForBuffer(store.pointsTextureSize))
    }

    this.previousPointsTextureSize = store.pointsTextureSize
    this.previousPointsNumber = this.data.pointsNumber
  }

  public initPrograms (): void {
    const { device, store, data, points } = this
    if (!data.pointsNumber || !points || !store.pointsTextureSize) return

    this.forceAllPairsCommand ||= createQuadModel(device, {
      id: 'force-allpairs',
      fs: forceManyBodyForceAllpairsFrag,
      parameters: REPLACE,
    })

    if (this.usesAllPairs) return

    this.calculateLevelsCommand ||= new Model(device, {
      id: 'calculate-level',
      vs: forceManyBodyCalculateLevelVert,
      fs: forceManyBodyCalculateLevelFrag,
      topology: 'point-list',
      parameters: ADDITIVE,
    })
    this.forceLevelCommand ||= createQuadModel(device, {
      id: 'force-level',
      fs: forceManyBodyForceLevelFrag,
      parameters: ADDITIVE,
    })
    this.buildNearFieldSlotsCommand ||= new Model(device, {
      id: 'build-nearfield-slots',
      vs: forceManyBodyBuildNearfieldSlotsVert,
      fs: forceManyBodyBuildNearfieldSlotsFrag,
      topology: 'point-list',
      parameters: { blend: false, depthTest: true, depthWriteEnabled: true, depthCompare: 'less' },
    })
    this.forceNearFieldCommand ||= createQuadModel(device, {
      id: 'force-nearfield',
      fs: forceManyBodyForceNearfieldFrag,
      parameters: ADDITIVE,
    })
  }

  public run (): void {
    // Skip if the topology changed and `create()` has not caught up. Space size
    // is deliberately not guarded: grid allocation depends on the point count,
    // and every draw computes its cell size from the live space size.
    if (
      this.store.pointsTextureSize !== this.previousPointsTextureSize ||
      this.data.pointsNumber !== this.previousPointsNumber
    ) return

    if (this.usesAllPairs) {
      this.drawAllPairsForce()
      return
    }

    if (this.levelTargets.size === 0 || this.peelTargets.length !== PEEL_TARGETS || !this.slotsArrayTexture) return

    this.drawLevels()
    this.drawNearFieldSlots()
    this.drawForces()
  }

  public destroy (): void {
    this.calculateLevelsCommand?.destroy()
    this.forceLevelCommand?.destroy()
    this.buildNearFieldSlotsCommand?.destroy()
    this.forceNearFieldCommand?.destroy()
    this.forceAllPairsCommand?.destroy()
    this.randomValuesTexture?.destroy()
    this.pointIndices?.destroy()
    this.destroyLevelTargets()
    this.calculateLevelsCommand = undefined
    this.forceLevelCommand = undefined
    this.buildNearFieldSlotsCommand = undefined
    this.forceNearFieldCommand = undefined
    this.forceAllPairsCommand = undefined
    this.randomValuesTexture = undefined
    this.pointIndices = undefined
  }

  private drawAllPairsForce (): void {
    const { store, data, points } = this
    const command = this.forceAllPairsCommand
    if (!command || !points?.previousPositionTexture || !points.velocityFbo) return
    if (!this.randomValuesTexture || !data.pointsNumber) return

    command.setUniforms({
      pointsTextureSize: store.pointsTextureSize,
      pointsNumber: data.pointsNumber,
      alpha: store.alpha,
      repulsion: this.config.simulationRepulsion,
      // The near/far split radius and the per-tick velocity bound, derived from
      // the finest cell size the grid path would use at this count — so the two
      // paths agree about what "near" means.
      maxStep: 2 * (store.adjustedSpaceSize / getFinestGridSize(data.pointsNumber)),
    })
    command.setTextures({
      positionsTexture: points.previousPositionTexture,
      randomValues: this.randomValuesTexture,
      exitTexture: points.exitTexture,
    })
    points.velocityFbo.clear(0, 0, 0, 0)
    command.draw(points.velocityFbo)
  }

  private drawLevels (): void {
    const { store, data, points } = this
    const command = this.calculateLevelsCommand
    if (!command || !points?.previousPositionTexture || !data.pointsNumber || !this.pointIndices) return

    command.setAttributes({ pointIndices: { buffer: this.pointIndices, size: 2 } })
    // Unused texels of the point texture must not aggregate phantom mass into
    // cell (0, 0), so the draw is bounded by the real point count.
    command.vertexCount = data.pointsNumber
    command.setTextures({
      positionsTexture: points.previousPositionTexture,
      exitTexture: points.exitTexture,
    })

    for (let level = 0; level < this.levels; level += 1) {
      const target = this.levelTargets.get(level)
      if (!target || target.fbo.destroyed) continue
      command.setUniforms({
        levelGridSize: target.gridSize,
        // Derived per level from the space size so the power-of-two halving
        // chain stays bit-exact between levels; the coverage invariant relies
        // on the boundaries matching exactly.
        cellSize: store.adjustedSpaceSize / target.gridSize,
      })
      target.fbo.clear(0, 0, 0, 0)
      command.draw(target.fbo)
    }
  }

  private drawNearFieldSlots (): void {
    const { store, data, points } = this
    const command = this.buildNearFieldSlotsCommand
    if (!command || !points?.previousPositionTexture || !data.pointsNumber || !this.pointIndices) return
    if (!this.slotsArrayTexture) return
    const finest = this.levelTargets.get(this.levels - 1)
    if (!finest) return

    // One seed for every slot of a tick: peeling depends on a consistent hash
    // ordering across the passes, so a per-pass seed would let a point win twice.
    const randomSeed = store.getRandomFloat(0, 1)

    command.setAttributes({ pointIndices: { buffer: this.pointIndices, size: 2 } })
    command.vertexCount = data.pointsNumber

    for (let slot = 0; slot < this.nearFieldSlots; slot += 1) {
      const target = this.peelTargets[slot % PEEL_TARGETS]
      const previous = this.peelTargets[(slot + 1) % PEEL_TARGETS]
      if (!target || target.fbo.destroyed || !previous) continue

      command.setUniforms({
        pointsTextureSize: store.pointsTextureSize,
        levelGridSize: finest.gridSize,
        cellSize: store.adjustedSpaceSize / finest.gridSize,
        hasPreviousSlot: slot === 0 ? 0 : 1,
        randomSeed,
      })
      command.setTextures({
        positionsTexture: points.previousPositionTexture,
        exitTexture: points.exitTexture,
        // Pass 0 never samples it, but the binding must exist for the draw to
        // run — any texture that is not the render target will do.
        previousSlot: slot === 0 ? points.previousPositionTexture : previous.texture,
      })
      // An empty slot is index -1 with hash 1, which keeps later passes from
      // treating it as a candidate.
      target.fbo.clear(-1, 1, 0, 0, true)
      command.draw(target.fbo)

      this.copyIntoSlotLayer(target, slot, finest.gridSize)
    }
  }

  private drawForces (): void {
    const { store, points } = this
    const levelCommand = this.forceLevelCommand
    const nearFieldCommand = this.forceNearFieldCommand
    if (!levelCommand || !nearFieldCommand || !points?.previousPositionTexture) return
    if (!points.velocityFbo || !this.slotsArrayTexture || !this.randomValuesTexture) return

    points.velocityFbo.clear(0, 0, 0, 0)

    for (let level = 0; level < this.levels; level += 1) {
      const target = this.levelTargets.get(level)
      if (!target || target.texture.destroyed) continue
      const cellSize = store.adjustedSpaceSize / target.gridSize

      levelCommand.setUniforms({
        levelGridSize: target.gridSize,
        cellSize,
        isFirstLevel: level === 0 ? 1 : 0,
        alpha: store.alpha,
        repulsion: this.config.simulationRepulsion,
      })
      levelCommand.setTextures({
        positionsTexture: points.previousPositionTexture,
        levelTexture: target.texture,
      })
      levelCommand.draw(points.velocityFbo)

      // The finest level leaves only the 3×3 neighbourhood uncovered; the
      // near-field pass closes it with importance-weighted pairwise forces from
      // the peeled slot points.
      if (level === this.levels - 1) {
        nearFieldCommand.setUniforms({
          pointsTextureSize: store.pointsTextureSize,
          levelGridSize: target.gridSize,
          cellSize,
          alpha: store.alpha,
          repulsion: this.config.simulationRepulsion,
          slotCount: this.nearFieldSlots,
        })
        nearFieldCommand.setTextures({
          positionsTexture: points.previousPositionTexture,
          levelTexture: target.texture,
          randomValues: this.randomValuesTexture,
          slotsTexture: this.slotsArrayTexture,
        })
        nearFieldCommand.draw(points.velocityFbo)
      }
    }
  }

  /**
   * Publishes a peel pass's result as one layer of the array texture the
   * near-field force samples.
   *
   * Peeling cannot render into the array layers directly: pass k must sample
   * pass k−1's output, and sampling one layer of a texture while rendering into
   * another is a feedback loop.
   */
  private copyIntoSlotLayer (target: SlotTarget, slot: number, gridSize: number): void {
    const gl = this.device.gl
    const slots = this.slotsArrayTexture
    if (!slots) return
    this.device.bindFramebuffer(target.fbo.handle)
    this.device.bindTexture(0, slots.handle, gl.TEXTURE_2D_ARRAY)
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot, 0, 0, gridSize, gridSize)
  }

  /**
   * Allocates the level pyramid: grids of 4², 8², … up to the adaptive finest
   * resolution.
   *
   * A level's size depends only on its index, so any level already built is
   * still the right size and is skipped; only the missing ones are created, and
   * a shrinking pyramid drops the levels past the new finest.
   */
  private createLevels (): void {
    const { device } = this
    const pointsNumber = this.data.pointsNumber ?? 0
    const finestGridSize = getFinestGridSize(pointsNumber)
    this.levels = Math.log2(finestGridSize) - 1

    for (let level = 0; level < this.levels; level += 1) {
      if (this.levelTargets.has(level)) continue
      const gridSize = Math.pow(2, level + 2)
      const texture = new Texture(device, {
        width: gridSize, height: gridSize, format: 'rgba32float', id: `level-${level}`,
      })
      const fbo = new Framebuffer(device, { colorAttachments: [texture], id: `level-${level}` })
      this.levelTargets.set(level, { texture, fbo, gridSize })
    }

    for (const [level, target] of Array.from(this.levelTargets.entries())) {
      if (level >= this.levels) {
        target.fbo.destroy()
        target.texture.destroy()
        this.levelTargets.delete(level)
      }
    }

    const finest = this.levelTargets.get(this.levels - 1)
    if (finest) this.createNearFieldSlotTargets(finest)
  }

  private createNearFieldSlotTargets (finest: LevelTarget): void {
    const { device } = this
    const slots = getBudgetedSlotCount(this.data.pointsNumber ?? 0, finest.gridSize)
    // These follow the finest level's grid, which does change size as the graph
    // grows, and the slot count changes with the point count — so unlike the
    // levels, a match has to be checked rather than assumed.
    const existing = this.peelTargets[0]
    if (
      existing && !existing.texture.destroyed &&
      existing.texture.width === finest.gridSize &&
      this.peelTargets.length === PEEL_TARGETS &&
      this.slotsArrayTexture && !this.slotsArrayTexture.destroyed &&
      this.nearFieldSlots === slots
    ) return

    this.destroyNearFieldSlotTargets()
    this.nearFieldSlots = slots
    for (let i = 0; i < PEEL_TARGETS; i += 1) {
      const texture = new Texture(device, {
        width: finest.gridSize, height: finest.gridSize, format: 'rg32float', id: `peel-${i}`,
      })
      const fbo = new Framebuffer(device, {
        colorAttachments: [texture],
        depth: 'depth24',
        id: `peel-${i}`,
      })
      this.peelTargets.push({ texture, fbo })
    }
    this.slotsArrayTexture = new Texture(device, {
      width: finest.gridSize,
      height: finest.gridSize,
      depth: slots,
      format: 'rg32float',
      id: 'nearfield-slots',
    })
  }

  private destroyNearFieldSlotTargets (): void {
    for (const target of this.peelTargets) {
      target.fbo.destroy()
      target.texture.destroy()
    }
    this.peelTargets = []
    this.slotsArrayTexture?.destroy()
    this.slotsArrayTexture = undefined
    this.nearFieldSlots = 0
  }

  private destroyLevelTargets (): void {
    for (const target of this.levelTargets.values()) {
      target.fbo.destroy()
      target.texture.destroy()
    }
    this.levelTargets.clear()
    this.destroyNearFieldSlotTargets()
  }
}
