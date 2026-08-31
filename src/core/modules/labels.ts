import { GLBuffer, Model, Texture, getQuadBuffer, updateAttributeBuffer } from '../../gl'
import type { Framebuffer } from '../../gl'
import { labelsDrawLabelsFrag, labelsDrawLabelsVert } from '../shaders'
import type { Store } from '../store'
import type { Zoom } from '../zoom'
import type { Points } from './points'
import {
  validateLabelAtlasData,
  validateLabelAtlasPatch,
  validateLabelDrawData,
  type LabelAtlasData,
  type LabelAtlasPatch,
  type LabelDrawData,
  type LabelRendererStats,
} from '../labels'

const FLOATS_PER_INSTANCE = 21
const STRIDE = FLOATS_PER_INSTANCE * Float32Array.BYTES_PER_ELEMENT

const DRAW_PARAMETERS = {
  blend: true,
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one-minus-src-alpha',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one-minus-src-alpha',
  depthTest: false,
  depthWriteEnabled: false,
  depthCompare: 'always',
} as const

/** One instanced draw composited into the graph's existing framebuffer. */
export class Labels {
  private readonly points: Points
  private readonly store: Store
  private readonly zoom: Zoom
  private atlas: Texture | undefined
  private atlasDescriptor: LabelAtlasData | undefined
  private instances: GLBuffer | undefined
  private command: Model | undefined
  private count = 0
  private lastPacked: Float32Array | undefined
  private readonly stats: LabelRendererStats = {
    atlasBytes: 0,
    drawCalls: 0,
    instanceUploads: 0,
    instanceUploadBytes: 0,
    atlasUploads: 0,
    atlasUploadBytes: 0,
  }

  public constructor (points: Points, store: Store, zoom: Zoom) {
    this.points = points
    this.store = store
    this.zoom = zoom
  }

  public setAtlas (data: LabelAtlasData): void {
    validateLabelAtlasData(data)
    const sizeChanged = !this.atlas || this.atlas.width !== data.width || this.atlas.height !== data.height
    if (sizeChanged) {
      this.atlas?.destroy()
      this.atlas = new Texture(this.points.device, {
        width: data.width,
        height: data.height,
        format: 'r8unorm',
        filter: 'linear',
        data: data.pixels,
        id: 'label-atlas',
      })
    } else if (data.pixels) {
      this.atlas?.write(data.pixels)
    }
    this.atlasDescriptor = { width: data.width, height: data.height, format: data.format }
    this.stats.atlasBytes = data.width * data.height
    if (data.pixels) {
      this.stats.atlasUploads += 1
      this.stats.atlasUploadBytes += data.pixels.byteLength
    }
  }

  public updateAtlas (patches: LabelAtlasPatch | readonly LabelAtlasPatch[]): void {
    if (!this.atlas || !this.atlasDescriptor) throw new Error('setLabelAtlas must be called before updateLabelAtlas')
    const values = Array.isArray(patches) ? patches : [patches]
    for (const patch of values) {
      validateLabelAtlasPatch(patch, this.atlasDescriptor)
      this.atlas.writeSubImage(patch.pixels, patch.x, patch.y, patch.width, patch.height)
      this.stats.atlasUploads += 1
      this.stats.atlasUploadBytes += patch.pixels.byteLength
    }
  }

  public setLabels (data: LabelDrawData): void {
    validateLabelDrawData(data)
    this.count = data.count
    if (data.count === 0) {
      this.lastPacked = undefined
      return
    }

    const packed = interleave(data)
    if (floatArraysEqual(packed, this.lastPacked)) return
    this.lastPacked = packed
    this.instances = updateAttributeBuffer(this.points.device, this.instances, packed)
    this.stats.instanceUploads += 1
    this.stats.instanceUploadBytes += packed.byteLength
    this.ensureCommand()
  }

  public clear (): void {
    this.count = 0
    this.lastPacked = undefined
  }

  public draw (viewport: readonly [number, number, number, number], target?: Framebuffer | null): void {
    const command = this.command
    const positionsTexture = this.points.currentPositionTexture
    if (!command || !this.atlas || !positionsTexture || !this.instances || this.count === 0) return

    const { k, x, y } = this.zoom.eventTransform
    command.instanceCount = this.count
    command.setUniforms({
      pointsTextureSize: this.store.pointsTextureSize,
      pointsNumber: this.points.data.pointsNumber ?? 0,
      spaceSize: this.store.adjustedSpaceSize,
      screenSize: this.store.screenSize,
      spaceOffsets: this.store.spaceOffsets,
      viewTransform: [k, x, y],
    })
    command.setTextures({ positionsTexture, labelAtlas: this.atlas })
    command.draw(target, viewport)
    this.stats.drawCalls += 1
  }

  public getStats (): Readonly<LabelRendererStats> {
    return { ...this.stats }
  }

  public destroy (): void {
    this.command?.destroy()
    this.instances?.destroy()
    this.atlas?.destroy()
    this.command = undefined
    this.instances = undefined
    this.atlas = undefined
    this.atlasDescriptor = undefined
    this.count = 0
    this.lastPacked = undefined
    this.stats.atlasBytes = 0
  }

  private ensureCommand (): void {
    if (this.command || !this.instances) return
    this.command = new Model(this.points.device, {
      id: 'draw-labels',
      vs: labelsDrawLabelsVert,
      fs: labelsDrawLabelsFrag,
      attributes: bindings(this.points.device, this.instances),
      vertexCount: 4,
      instanceCount: this.count,
      topology: 'triangle-strip',
      parameters: DRAW_PARAMETERS,
    })
  }
}

function bindings (device: Points['device'], buffer: GLBuffer) {
  const instance = (size: number, offsetFloats: number) => ({
    buffer,
    size,
    stride: STRIDE,
    offset: offsetFloats * Float32Array.BYTES_PER_ELEMENT,
    divisor: 1,
  })
  return {
    vertexCoord: { buffer: getQuadBuffer(device), size: 2 },
    labelPointIndex: instance(1, 0),
    labelAnchor: instance(2, 1),
    labelSize: instance(2, 3),
    labelUvRect: instance(4, 5),
    labelVisible: instance(1, 9),
    labelTextColor: instance(4, 10),
    labelChipColor: instance(4, 14),
    labelPointRadius: instance(1, 18),
    labelMargin: instance(1, 19),
    labelCornerRadius: instance(1, 20),
  }
}

function interleave (data: LabelDrawData): Float32Array {
  const result = new Float32Array(data.count * FLOATS_PER_INSTANCE)
  for (let i = 0; i < data.count; i++) {
    const to = i * FLOATS_PER_INSTANCE
    result[to] = data.pointIndices[i] as number
    copy(result, to + 1, data.anchors, i * 2, 2)
    copy(result, to + 3, data.sizes, i * 2, 2)
    copy(result, to + 5, data.uvRects, i * 4, 4)
    result[to + 9] = data.visible[i] as number
    copy(result, to + 10, data.textColors, i * 4, 4)
    copy(result, to + 14, data.chipColors, i * 4, 4)
    result[to + 18] = data.pointRadii[i] as number
    result[to + 19] = data.margins[i] as number
    result[to + 20] = data.cornerRadii[i] as number
  }
  return result
}

function copy (target: Float32Array, targetOffset: number, source: Float32Array, sourceOffset: number, count: number): void {
  for (let i = 0; i < count; i++) target[targetOffset + i] = source[sourceOffset + i] as number
}

function floatArraysEqual (a: Float32Array, b: Float32Array | undefined): boolean {
  if (!b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]
    const right = b[i]
    if (left !== right && !(Number.isNaN(left) && Number.isNaN(right))) return false
  }
  return true
}
