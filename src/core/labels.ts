/** A persistent single-channel text atlas owned by the graph renderer. */
export type LabelAtlasData = {
  width: number
  height: number
  format: 'r8unorm'
  /** Omit to allocate an empty atlas without uploading a multi-megabyte zero buffer. */
  pixels?: Uint8Array
}

/** An incremental update to an existing label atlas. */
export type LabelAtlasPatch = {
  x: number
  y: number
  width: number
  height: number
  pixels: Uint8Array
}

/**
 * Instances consumed by the inline label renderer.
 *
 * Every array is parallel and only its first `count` entries are read. Point
 * indices >= 0 sample the graph's live position texture; `-1` uses the direct
 * simulation-space anchor at the same slot.
 */
export type LabelDrawData = {
  count: number
  pointIndices: Float32Array
  anchors: Float32Array
  sizes: Float32Array
  uvRects: Float32Array
  visible: Float32Array
  textColors: Float32Array
  chipColors: Float32Array
  pointRadii: Float32Array
  margins: Float32Array
  cornerRadii: Float32Array
}

export type LabelRendererStats = {
  atlasBytes: number
  drawCalls: number
  instanceUploads: number
  instanceUploadBytes: number
  atlasUploads: number
  atlasUploadBytes: number
}

export function validateLabelAtlasData (data: LabelAtlasData): void {
  assertPositiveInteger(data.width, 'label atlas width')
  assertPositiveInteger(data.height, 'label atlas height')
  if (data.format !== 'r8unorm') throw new RangeError('label atlas format must be r8unorm')
  if (data.pixels && data.pixels.length !== data.width * data.height) {
    throw new RangeError(
      `label atlas pixels must contain ${data.width * data.height} bytes; received ${data.pixels.length}`
    )
  }
}

export function validateLabelAtlasPatch (
  patch: LabelAtlasPatch,
  atlas: Pick<LabelAtlasData, 'width' | 'height'>
): void {
  assertNonNegativeInteger(patch.x, 'label atlas patch x')
  assertNonNegativeInteger(patch.y, 'label atlas patch y')
  assertPositiveInteger(patch.width, 'label atlas patch width')
  assertPositiveInteger(patch.height, 'label atlas patch height')
  if (patch.x + patch.width > atlas.width || patch.y + patch.height > atlas.height) {
    throw new RangeError('label atlas patch exceeds atlas bounds')
  }
  if (patch.pixels.length !== patch.width * patch.height) {
    throw new RangeError(
      `label atlas patch must contain ${patch.width * patch.height} bytes; received ${patch.pixels.length}`
    )
  }
}

export function validateLabelDrawData (data: LabelDrawData): void {
  assertNonNegativeInteger(data.count, 'label count')
  requireLength(data.pointIndices, data.count, 'pointIndices')
  requireLength(data.anchors, data.count * 2, 'anchors')
  requireLength(data.sizes, data.count * 2, 'sizes')
  requireLength(data.uvRects, data.count * 4, 'uvRects')
  requireLength(data.visible, data.count, 'visible')
  requireLength(data.textColors, data.count * 4, 'textColors')
  requireLength(data.chipColors, data.count * 4, 'chipColors')
  requireLength(data.pointRadii, data.count, 'pointRadii')
  requireLength(data.margins, data.count, 'margins')
  requireLength(data.cornerRadii, data.count, 'cornerRadii')
}

function requireLength (array: ArrayLike<number>, length: number, name: string): void {
  if (array.length < length) {
    throw new RangeError(`${name} must contain at least ${length} values; received ${array.length}`)
  }
}

function assertPositiveInteger (value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`)
}

function assertNonNegativeInteger (value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`)
}
