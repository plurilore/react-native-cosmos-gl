import type { ComponentType } from 'react'
import type { GL } from '../gl'

/**
 * The subset of `expo-gl`'s context this library depends on.
 *
 * `endFrameEXP` is the part with no browser equivalent: expo-gl queues GL
 * commands and only presents the drawing buffer when it is called, so a frame
 * that forgets it renders nothing.
 */
export type ExpoWebGLRenderingContext = GL & {
  endFrameEXP: () => void
  drawingBufferWidth: number
  drawingBufferHeight: number
}

export type GLViewProps = {
  style?: unknown
  msaaSamples?: number
  onContextCreate: (gl: ExpoWebGLRenderingContext) => void
}

type ExpoGLModule = { GLView: ComponentType<GLViewProps> }

let cached: ExpoGLModule | undefined | null

/**
 * Resolves `expo-gl` at call time rather than through a static import.
 *
 * It is an optional peer dependency: consumers who bring their own WebGL2
 * context and drive `Graph` directly should not have to install it, and a
 * static import would make Metro resolve it for every consumer regardless.
 */
export function getGLView (): ComponentType<GLViewProps> {
  if (cached === undefined) {
    try {
      cached = require('expo-gl') as ExpoGLModule
    } catch {
      cached = null
    }
  }
  if (!cached) {
    throw new Error(
      '`react-native-cosmos-gl` needs `expo-gl` to create a WebGL2 surface, but it could not be ' +
      'resolved. Install it with `npx expo install expo-gl`, or drive the `Graph` class directly ' +
      'with a context you supply yourself.'
    )
  }
  return cached.GLView
}
