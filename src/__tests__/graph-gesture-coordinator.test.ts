import { describe, expect, it, vi } from 'vitest'

import {
  GraphGestureCoordinator,
  type GraphGestureTarget,
  type PanGestureSample,
} from '../react/graph-gesture-coordinator'
import { GRAPH_GESTURE_SETTINGS } from '../react/graph-gesture-settings'

function target (): GraphGestureTarget {
  return {
    onPanStart: vi.fn(),
    onPanUpdate: vi.fn(),
    onPanEnd: vi.fn(),
    onPinchStart: vi.fn(),
    onPinchUpdate: vi.fn(),
    onPinchEnd: vi.fn(),
    onTap: vi.fn(),
    onLongPress: vi.fn(),
  }
}

function pan (
  x: number,
  y: number,
  translationX: number,
  translationY: number
): PanGestureSample {
  return { x, y, translationX, translationY }
}

describe('GraphGestureCoordinator', () => {
  it('keeps press and navigation recognition thresholds aligned', () => {
    expect(GRAPH_GESTURE_SETTINGS).toEqual({
      tapSlop: 8,
      tapMaxDuration: 500,
      longPressDuration: 500,
      longPressPointerCount: 1,
    })
  })

  it('commits an ordinary one-pointer tap once', () => {
    const gestures = target()
    const coordinator = new GraphGestureCoordinator(() => gestures)
    coordinator.onTouchesDown(1)
    coordinator.onTouchesUp(0)

    expect(coordinator.onTap(12, 18, true)).toBe(true)
    expect(gestures.onTap).toHaveBeenCalledOnce()
    expect(gestures.onTap).toHaveBeenCalledWith(12, 18)
  })

  it('commits a successful stationary long press only at its end', () => {
    const gestures = target()
    const coordinator = new GraphGestureCoordinator(() => gestures)
    coordinator.onTouchesDown(1)

    expect(gestures.onLongPress).not.toHaveBeenCalled()
    coordinator.onTouchesUp(0)
    expect(coordinator.onLongPress(20, 30, true)).toBe(true)
    expect(gestures.onLongPress).toHaveBeenCalledOnce()
  })

  it('never turns a pan that returns to its origin into a tap', () => {
    const gestures = target()
    const coordinator = new GraphGestureCoordinator(() => gestures)
    coordinator.onTouchesDown(1)
    coordinator.onPanStart(pan(18, 10, 8, 0))
    coordinator.onPanUpdate(pan(30, 10, 20, 0))
    coordinator.onPanUpdate(pan(10, 10, 0, 0))
    coordinator.onPanFinalize(pan(10, 10, 0, 0))
    coordinator.onTouchesUp(0)

    expect(coordinator.onTap(10, 10, true)).toBe(false)
    expect(gestures.onTap).not.toHaveBeenCalled()
    expect(gestures.onPanStart).toHaveBeenCalledWith(10, 10)
    expect(gestures.onPanEnd).toHaveBeenCalledOnce()
  })

  it('never commits a pinch that returns to scale one as a press', () => {
    const gestures = target()
    const coordinator = new GraphGestureCoordinator(() => gestures)
    coordinator.onTouchesDown(1)
    coordinator.onTouchesDown(2)
    coordinator.onPinchStart()
    coordinator.onPinchUpdate({ scale: 1.6, focalX: 30, focalY: 40, pointerCount: 2 })
    coordinator.onPinchUpdate({ scale: 1, focalX: 30, focalY: 40, pointerCount: 2 })
    coordinator.onPinchFinalize()
    coordinator.onTouchesUp(0)

    expect(coordinator.onTap(30, 40, true)).toBe(false)
    expect(coordinator.onLongPress(30, 40, true)).toBe(false)
    expect(gestures.onTap).not.toHaveBeenCalled()
    expect(gestures.onLongPress).not.toHaveBeenCalled()
  })

  it('rejects a stationary two-finger sequence even if the tap recognizer succeeds', () => {
    const gestures = target()
    const coordinator = new GraphGestureCoordinator(() => gestures)
    coordinator.onTouchesDown(1)
    coordinator.onTouchesDown(2)
    coordinator.onTouchesUp(1)
    coordinator.onTouchesUp(0)

    expect(coordinator.onTap(5, 6, true)).toBe(false)
    expect(gestures.onTap).not.toHaveBeenCalled()
    expect(coordinator.state.maxPointerCount).toBe(2)
  })

  it('serialises pan to pinch and resumes pan from a zeroed baseline', () => {
    const gestures = target()
    const coordinator = new GraphGestureCoordinator(() => gestures)
    coordinator.onTouchesDown(1)
    coordinator.onPanStart(pan(18, 22, 8, 2))
    coordinator.onPanUpdate(pan(22, 26, 12, 6))
    coordinator.onTouchesDown(2)
    coordinator.onPinchStart()
    coordinator.onPinchUpdate({ scale: 1.3, focalX: 40, focalY: 50, pointerCount: 2 })
    coordinator.onTouchesUp(1)
    coordinator.onPinchFinalize()
    coordinator.onPanUpdate(pan(52, 62, 31, 37))
    coordinator.onPanUpdate(pan(55, 66, 34, 41))
    coordinator.onTouchesUp(0)
    coordinator.onPanFinalize(pan(55, 66, 34, 41))

    expect(gestures.onPanStart).toHaveBeenNthCalledWith(1, 10, 20)
    expect(gestures.onPanStart).toHaveBeenNthCalledWith(2, 52, 62)
    expect(gestures.onPanUpdate).toHaveBeenLastCalledWith(55, 66, 3, 4)
    expect(gestures.onPanEnd).toHaveBeenCalledTimes(2)
    expect(gestures.onPinchStart).toHaveBeenCalledOnce()
    expect(gestures.onPinchEnd).toHaveBeenCalledOnce()
  })

  it('zeroes pan that activates only after a pinch has ended', () => {
    const gestures = target()
    const coordinator = new GraphGestureCoordinator(() => gestures)
    coordinator.onTouchesDown(2)
    coordinator.onPinchStart()
    coordinator.onPinchUpdate({ scale: 1.4, focalX: 40, focalY: 50, pointerCount: 2 })
    coordinator.onTouchesUp(1)
    coordinator.onPinchFinalize()
    coordinator.onPanStart(pan(70, 80, 35, 42))
    coordinator.onPanUpdate(pan(74, 85, 39, 47))

    expect(gestures.onPanStart).toHaveBeenCalledWith(70, 80)
    expect(gestures.onPanUpdate).toHaveBeenCalledWith(74, 85, 4, 5)
  })

  it('handles either lift order without duplicating gesture endings', () => {
    for (const panFinalizesFirst of [false, true]) {
      const gestures = target()
      const coordinator = new GraphGestureCoordinator(() => gestures)
      coordinator.onTouchesDown(2)
      coordinator.onPanStart(pan(20, 20, 0, 0))
      coordinator.onPinchStart()
      if (panFinalizesFirst) coordinator.onPanFinalize(pan(20, 20, 0, 0))
      coordinator.onTouchesUp(0)
      coordinator.onPinchFinalize()
      coordinator.onPanFinalize(pan(20, 20, 0, 0))

      // Pinch takes ownership by ending the active pan; later native
      // finalisation must not end that pan a second time.
      expect(gestures.onPanEnd).toHaveBeenCalledOnce()
      expect(gestures.onPinchEnd).toHaveBeenCalledOnce()
    }
  })

  it('ignores Android terminal pinch updates after the focal point collapses', () => {
    const gestures = target()
    const coordinator = new GraphGestureCoordinator(() => gestures)
    coordinator.onTouchesDown(2)
    coordinator.onPinchStart()
    coordinator.onPinchUpdate({
      scale: 1.4,
      focalX: 40,
      focalY: 50,
      pointerCount: 2,
    })

    coordinator.onTouchesUp(1)
    coordinator.onPinchUpdate({
      scale: 1.4,
      focalX: 170,
      focalY: 210,
      pointerCount: 1,
    })

    expect(gestures.onPinchUpdate).toHaveBeenCalledOnce()
    expect(gestures.onPinchUpdate).toHaveBeenCalledWith(1.4, 40, 50)
    expect(coordinator.state.mode).toBe('pinch')
    expect(coordinator.state.activePointerCount).toBe(1)

    coordinator.onPinchFinalize()
    expect(gestures.onPinchEnd).toHaveBeenCalledOnce()
  })

  it('lets a later pinch cancel a long hold before its callback commits', () => {
    const gestures = target()
    const coordinator = new GraphGestureCoordinator(() => gestures)
    coordinator.onTouchesDown(1)
    coordinator.onTouchesDown(2)
    coordinator.onPinchStart()
    coordinator.onTouchesUp(0)
    coordinator.onPinchFinalize()

    expect(coordinator.onLongPress(10, 10, true)).toBe(false)
    expect(gestures.onLongPress).not.toHaveBeenCalled()
  })

  it('cancels each active mode once and never commits a press', () => {
    const panGestures = target()
    const panCoordinator = new GraphGestureCoordinator(() => panGestures)
    panCoordinator.onTouchesDown(1)
    panCoordinator.onPanStart(pan(10, 10, 0, 0))
    panCoordinator.cancel()
    panCoordinator.cancel()
    expect(panGestures.onPanEnd).toHaveBeenCalledOnce()
    expect(panCoordinator.onTap(10, 10, true)).toBe(false)

    const pinchGestures = target()
    const pinchCoordinator = new GraphGestureCoordinator(() => pinchGestures)
    pinchCoordinator.onTouchesDown(2)
    pinchCoordinator.onPinchStart()
    pinchCoordinator.cancel()
    pinchCoordinator.cancel()
    expect(pinchGestures.onPinchEnd).toHaveBeenCalledOnce()
    expect(pinchCoordinator.onLongPress(10, 10, true)).toBe(false)
  })
})
