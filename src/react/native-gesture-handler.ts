import { useEffect, useMemo, useState, type MutableRefObject } from 'react'
import { Gesture, type ComposedGesture } from 'react-native-gesture-handler'

import { GraphGestureCoordinator, type PanGestureSample } from './graph-gesture-coordinator'
import { GRAPH_GESTURE_SETTINGS } from './graph-gesture-settings'
import type { GestureController } from './gestures'

function panSample (event: PanGestureSample): PanGestureSample {
  return {
    x: event.x,
    y: event.y,
    translationX: event.translationX,
    translationY: event.translationY,
  }
}

/**
 * Builds the native recogniser graph for one Cosmos surface.
 *
 * Navigation has priority over discrete presses. The coordinator separately
 * records the complete native pointer stream because RNGH's tap recogniser
 * exposes `minPointers`, but no corresponding `maxPointers`.
 */
export function createNativeGraphGesture (
  coordinator: GraphGestureCoordinator
): ComposedGesture {
  const {
    tapSlop,
    tapMaxDuration,
    longPressDuration,
    longPressPointerCount,
  } = GRAPH_GESTURE_SETTINGS

  const pan = Gesture.Pan()
    .minDistance(tapSlop)
    .averageTouches(true)
    .runOnJS(true)
    .onTouchesDown((event) => coordinator.onTouchesDown(event.numberOfTouches))
    .onTouchesUp((event) => coordinator.onTouchesUp(event.numberOfTouches))
    .onTouchesCancelled(() => coordinator.cancel())
    .onStart((event) => coordinator.onPanStart(panSample(event)))
    .onUpdate((event) => coordinator.onPanUpdate(panSample(event)))
    .onFinalize((event) => coordinator.onPanFinalize(panSample(event)))

  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => coordinator.onPinchStart())
    .onUpdate((event) => coordinator.onPinchUpdate({
      scale: event.scale,
      focalX: event.focalX,
      focalY: event.focalY,
      pointerCount: event.numberOfPointers,
    }))
    .onFinalize(() => coordinator.onPinchFinalize())

  const longPress = Gesture.LongPress()
    .minDuration(longPressDuration)
    .maxDistance(tapSlop)
    .numberOfPointers(longPressPointerCount)
    .runOnJS(true)
    .onEnd((event, success) => {
      coordinator.onLongPress(event.x, event.y, success)
    })

  const tap = Gesture.Tap()
    .maxDistance(tapSlop)
    .maxDuration(tapMaxDuration)
    .runOnJS(true)
    .onEnd((event, success) => {
      coordinator.onTap(event.x, event.y, success)
    })

  return Gesture.Exclusive(
    Gesture.Simultaneous(pan, pinch),
    longPress,
    tap
  )
}

export function useNativeGestureHandling (
  gesturesRef: MutableRefObject<GestureController | undefined>
): ComposedGesture {
  const [coordinator] = useState(
    () => new GraphGestureCoordinator(() => gesturesRef.current)
  )
  const gesture = useMemo(() => createNativeGraphGesture(coordinator), [coordinator])

  useEffect(() => () => coordinator.cancel(), [coordinator])

  return gesture
}
