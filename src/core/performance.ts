import type { DevicePerformanceCounters } from '../gl'

/** Per-frame host-side work. GPU completion still requires a platform trace. */
export type FramePerformanceSample = DevicePerformanceCounters & {
  timestamp: number
  frameCpuMs: number
  /** Previous completed GPU frame duration; omitted without timer-query support. */
  gpuMs?: number
  /** Time spent in expo-gl's present call, supplied by the React Native host. */
  presentMs?: number
  /** `frameCpuMs + presentMs` when sampled by the React Native host. */
  totalHostMs?: number
}

export function subtractPerformanceCounters (
  current: DevicePerformanceCounters,
  previous: DevicePerformanceCounters
): DevicePerformanceCounters {
  return {
    drawCalls: current.drawCalls - previous.drawCalls,
    bufferUploads: current.bufferUploads - previous.bufferUploads,
    bufferUploadBytes: current.bufferUploadBytes - previous.bufferUploadBytes,
    textureUploads: current.textureUploads - previous.textureUploads,
    textureUploadBytes: current.textureUploadBytes - previous.textureUploadBytes,
    readbacks: current.readbacks - previous.readbacks,
    readbackBytes: current.readbackBytes - previous.readbackBytes,
    readbackMs: current.readbackMs - previous.readbackMs,
  }
}
