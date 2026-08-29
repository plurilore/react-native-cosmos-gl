import { Model, Texture, Framebuffer, GLBuffer, createQuadModel, createIndexesForBuffer } from '../../gl'
import { CoreModule } from './core-module'
import {
  clustersCalculateCentermassVert,
  clustersCalculateCentermassFrag,
  clustersForceClusterFrag,
} from '../shaders'

const ADDITIVE = {
  blend: true,
  blendColorSrcFactor: 'one',
  blendColorDstFactor: 'one',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one',
  depthWriteEnabled: false,
  depthCompare: 'always',
} as const

const REPLACE = { blend: false, depthWriteEnabled: false, depthCompare: 'always' } as const

/**
 * Pulls each point toward its cluster's centroid.
 *
 * The centroid is not given — it is whatever the cluster's members currently
 * average to, so it is recomputed every tick: one additive pass sums each
 * point's position into its cluster's texel, and the force pass divides by the
 * count accumulated alongside. A cluster with an explicitly configured position
 * uses that instead, which is how you pin a group somewhere specific.
 */
export class Clusters extends CoreModule {
  public centermassFbo: Framebuffer | undefined
  public clusterCount: number | undefined

  private calculateCentermassCommand: Model | undefined
  private applyForcesCommand: Model | undefined
  private clusterTexture: Texture | undefined
  private clusterPositionsTexture: Texture | undefined
  private clusterForceCoefficientTexture: Texture | undefined
  private centermassTexture: Texture | undefined
  private pointIndices: GLBuffer | undefined
  private clustersTextureSize: number | undefined

  /**
   * Last computed centroids, reused while the simulation is idle and the
   * positions have not changed — the readback behind them stalls the pipeline,
   * and a stopped graph would otherwise pay for it on every query.
   */
  private cachedCentroidPositions: number[] | null = null
  private previousPointsTextureSize: number | undefined
  private previousClustersTextureSize: number | undefined
  private previousClusterCount: number | undefined

  public create (): void {
    this.cachedCentroidPositions = null
    const { device, store, data } = this
    const { pointsTextureSize } = store
    if (data.pointsNumber === undefined || (!data.pointClusters && !data.clusterPositions)) return

    // Cluster indices are the caller's own and need not be contiguous; the
    // count is the highest index seen plus one.
    this.clusterCount = (data.pointClusters ?? []).reduce<number>((max, clusterIndex) => {
      if (clusterIndex === undefined || clusterIndex < 0) return max
      return Math.max(max, clusterIndex)
    }, 0) + 1
    this.clustersTextureSize = Math.ceil(Math.sqrt(this.clusterCount))

    const sizesChanged =
      this.previousPointsTextureSize !== pointsTextureSize ||
      this.previousClustersTextureSize !== this.clustersTextureSize ||
      this.previousClusterCount !== this.clusterCount

    const pointsDataSize = pointsTextureSize * pointsTextureSize * 4
    const clustersDataSize = this.clustersTextureSize * this.clustersTextureSize * 4

    const clusterState = new Float32Array(pointsDataSize)
    // -1 marks "no configured position", so the force falls back to the
    // computed centroid.
    const clusterPositions = new Float32Array(clustersDataSize).fill(-1)
    const clusterForceCoefficient = new Float32Array(pointsDataSize).fill(1)

    if (data.clusterPositions) {
      for (let cluster = 0; cluster < this.clusterCount; ++cluster) {
        clusterPositions[cluster * 4 + 0] = data.clusterPositions[cluster * 2 + 0] ?? -1
        clusterPositions[cluster * 4 + 1] = data.clusterPositions[cluster * 2 + 1] ?? -1
      }
    }

    for (let i = 0; i < data.pointsNumber; ++i) {
      const clusterIndex = data.pointClusters?.[i]
      if (clusterIndex === undefined) {
        // Unclustered: -1 in both channels, which the shader reads as "no force".
        clusterState[i * 4 + 0] = -1
        clusterState[i * 4 + 1] = -1
      } else {
        clusterState[i * 4 + 0] = clusterIndex % this.clustersTextureSize
        clusterState[i * 4 + 1] = Math.floor(clusterIndex / this.clustersTextureSize)
      }
      if (data.clusterStrength) clusterForceCoefficient[i * 4 + 0] = data.clusterStrength[i] ?? 1
    }

    this.clusterTexture = replaceTexture(device, this.clusterTexture, pointsTextureSize, clusterState, sizesChanged, 'cluster')
    this.clusterForceCoefficientTexture = replaceTexture(
      device, this.clusterForceCoefficientTexture, pointsTextureSize, clusterForceCoefficient, sizesChanged, 'cluster-strength'
    )
    this.clusterPositionsTexture = replaceTexture(
      device, this.clusterPositionsTexture, this.clustersTextureSize, clusterPositions, sizesChanged, 'cluster-positions'
    )

    if (!this.centermassTexture || sizesChanged) {
      this.centermassFbo?.destroy()
      this.centermassTexture?.destroy()
      this.centermassTexture = new Texture(device, {
        width: this.clustersTextureSize,
        height: this.clustersTextureSize,
        format: 'rgba32float',
        data: new Float32Array(clustersDataSize),
        id: 'cluster-centermass',
      })
      this.centermassFbo = new Framebuffer(device, {
        colorAttachments: [this.centermassTexture], id: 'cluster-centermass',
      })
    }

    if (!this.pointIndices || sizesChanged) {
      this.pointIndices?.destroy()
      this.pointIndices = new GLBuffer(device, 'vertex', createIndexesForBuffer(pointsTextureSize))
    }

    this.previousPointsTextureSize = pointsTextureSize
    this.previousClustersTextureSize = this.clustersTextureSize
    this.previousClusterCount = this.clusterCount
  }

  public initPrograms (): void {
    const { device, store, points } = this
    if (!points || !store.pointsTextureSize) return

    this.calculateCentermassCommand ||= new Model(device, {
      id: 'cluster-centermass',
      vs: clustersCalculateCentermassVert,
      fs: clustersCalculateCentermassFrag,
      topology: 'point-list',
      parameters: ADDITIVE,
    })
    this.applyForcesCommand ||= createQuadModel(device, {
      id: 'force-cluster',
      fs: clustersForceClusterFrag,
      parameters: REPLACE,
    })
  }

  public run (): void {
    const { data, store, points } = this
    if (!data.pointClusters && !data.clusterPositions) return
    // The centroid sum accumulates by additive blending; without it the pass
    // would keep only the last point of each cluster.
    if (!this.device.features.floatBlend) return

    this.calculateCentermass()

    const command = this.applyForcesCommand
    if (!command || !points?.previousPositionTexture || !points.velocityFbo) return
    if (!this.clusterTexture || !this.centermassTexture) return
    if (!this.clusterPositionsTexture || !this.clusterForceCoefficientTexture) return

    command.setUniforms({
      alpha: store.alpha,
      clusterCoefficient: this.config.simulationCluster,
    })
    command.setTextures({
      clusterTexture: this.clusterTexture,
      centermassTexture: this.centermassTexture,
      clusterPositionsTexture: this.clusterPositionsTexture,
      clusterForceCoefficient: this.clusterForceCoefficientTexture,
      positionsTexture: points.previousPositionTexture,
    })
    points.velocityFbo.clear(0, 0, 0, 0)
    command.draw(points.velocityFbo)
  }

  /**
   * Current cluster centroids as `[x0, y0, x1, y1, …]`.
   *
   * Costs a readback, so the result is cached whenever the simulation is idle
   * and nothing has moved the points since.
   */
  public getCentroidPositions (): readonly number[] {
    const simulationInactive = !this.config.enableSimulation || !this.store.isSimulationRunning
    if (simulationInactive && this.points?.areClusterCentroidsUpToDate && this.cachedCentroidPositions) {
      return this.cachedCentroidPositions
    }

    this.calculateCentermass()
    if (!this.centermassFbo || this.clusterCount === undefined || !this.clustersTextureSize) return []

    const size = this.clustersTextureSize
    const pixels = new Float32Array(size * size * 4)
    this.centermassFbo.readPixels(pixels)

    const positions: number[] = new Array<number>(this.clusterCount * 2).fill(0)
    for (let i = 0; i < this.clusterCount; i += 1) {
      const sumX = pixels[i * 4 + 0] as number
      const sumY = pixels[i * 4 + 1] as number
      const count = pixels[i * 4 + 2] as number
      // An empty cluster has no centroid; leave it at the origin rather than
      // dividing by zero and emitting NaN into the caller's array.
      if (count > 0) {
        positions[i * 2] = sumX / count
        positions[i * 2 + 1] = sumY / count
      }
    }

    if (simulationInactive && this.points) {
      this.cachedCentroidPositions = positions
      this.points.areClusterCentroidsUpToDate = true
    }
    return positions
  }

  public destroy (): void {
    this.centermassFbo?.destroy()
    for (const texture of [
      this.clusterTexture, this.clusterPositionsTexture,
      this.clusterForceCoefficientTexture, this.centermassTexture,
    ]) texture?.destroy()
    this.pointIndices?.destroy()
    this.calculateCentermassCommand?.destroy()
    this.applyForcesCommand?.destroy()
    this.centermassFbo = undefined
    this.clusterTexture = undefined
    this.clusterPositionsTexture = undefined
    this.clusterForceCoefficientTexture = undefined
    this.centermassTexture = undefined
    this.pointIndices = undefined
    this.calculateCentermassCommand = undefined
    this.applyForcesCommand = undefined
    this.cachedCentroidPositions = null
  }

  /** Sums every point's position into its cluster's texel. */
  private calculateCentermass (): void {
    const { points, data } = this
    const command = this.calculateCentermassCommand
    if (!command || !points?.previousPositionTexture || !this.pointIndices) return
    if (!this.centermassFbo || !this.clusterTexture) return

    command.setAttributes({ pointIndices: { buffer: this.pointIndices, size: 2 } })
    command.vertexCount = data.pointsNumber ?? 0
    command.setUniforms({ clustersTextureSize: this.clustersTextureSize ?? 0 })
    command.setTextures({
      clusterTexture: this.clusterTexture,
      positionsTexture: points.previousPositionTexture,
      exitTexture: points.exitTexture,
    })
    this.centermassFbo.clear(0, 0, 0, 0)
    command.draw(this.centermassFbo)
  }
}

function replaceTexture (
  device: Texture['device'],
  texture: Texture | undefined,
  size: number,
  data: Float32Array,
  sizesChanged: boolean,
  id: string
): Texture {
  if (texture && !texture.destroyed && !sizesChanged) {
    texture.write(data)
    return texture
  }
  texture?.destroy()
  return new Texture(device, { width: size, height: size, format: 'rgba32float', data, id })
}
