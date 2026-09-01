import { beforeEach, describe, expect, it, vi } from 'vitest'

const gestureMock = vi.hoisted(() => {
  class FakeGesture {
    public readonly name: string
    public readonly config: Record<string, unknown> = {}
    public readonly handlers: Record<string, unknown> = {}

    public constructor (name: string) {
      this.name = name
    }

    public minDistance (value: number): this { return this.configure('minDistance', value) }
    public averageTouches (value: boolean): this { return this.configure('averageTouches', value) }
    public maxDistance (value: number): this { return this.configure('maxDistance', value) }
    public maxDuration (value: number): this { return this.configure('maxDuration', value) }
    public minDuration (value: number): this { return this.configure('minDuration', value) }
    public numberOfPointers (value: number): this { return this.configure('numberOfPointers', value) }
    public runOnJS (value: boolean): this { return this.configure('runOnJS', value) }
    public onTouchesDown (value: unknown): this { return this.handle('onTouchesDown', value) }
    public onTouchesUp (value: unknown): this { return this.handle('onTouchesUp', value) }
    public onTouchesCancelled (value: unknown): this { return this.handle('onTouchesCancelled', value) }
    public onStart (value: unknown): this { return this.handle('onStart', value) }
    public onUpdate (value: unknown): this { return this.handle('onUpdate', value) }
    public onFinalize (value: unknown): this { return this.handle('onFinalize', value) }
    public onEnd (value: unknown): this { return this.handle('onEnd', value) }

    private configure (key: string, value: unknown): this {
      this.config[key] = value
      return this
    }

    private handle (key: string, value: unknown): this {
      this.handlers[key] = value
      return this
    }
  }

  return {
    created: [] as FakeGesture[],
    compositions: [] as { kind: 'simultaneous' | 'exclusive'; gestures: unknown[] }[],
    FakeGesture,
  }
})

vi.mock('react-native-gesture-handler', () => {
  const create = (name: string) => (): InstanceType<typeof gestureMock.FakeGesture> => {
    const gesture = new gestureMock.FakeGesture(name)
    gestureMock.created.push(gesture)
    return gesture
  }
  const compose = (kind: 'simultaneous' | 'exclusive') => (...gestures: unknown[]) => {
    const composition = { kind, gestures }
    gestureMock.compositions.push(composition)
    return composition
  }

  return {
    Gesture: {
      Pan: create('pan'),
      Pinch: create('pinch'),
      LongPress: create('long-press'),
      Tap: create('tap'),
      Simultaneous: compose('simultaneous'),
      Exclusive: compose('exclusive'),
    },
  }
})

import { GraphGestureCoordinator } from '../react/graph-gesture-coordinator'
import { createNativeGraphGesture } from '../react/native-gesture-handler'

describe('native graph gesture composition', () => {
  beforeEach(() => {
    gestureMock.created.length = 0
    gestureMock.compositions.length = 0
  })

  it('gives simultaneous navigation priority over every discrete press', () => {
    const coordinator = new GraphGestureCoordinator(() => undefined)
    const result = createNativeGraphGesture(coordinator) as unknown as {
      kind: string
      gestures: unknown[]
    }

    expect(result.kind).toBe('exclusive')
    expect(result.gestures[0]).toMatchObject({ kind: 'simultaneous' })
    expect(gestureMock.created.map((gesture) => gesture.name)).toEqual([
      'pan',
      'pinch',
      'long-press',
      'tap',
    ])

    const [pan, pinch, longPress, tap] = gestureMock.created
    expect(pan?.config).toMatchObject({
      minDistance: 8,
      averageTouches: true,
      runOnJS: true,
    })
    expect(pinch?.config).toMatchObject({ runOnJS: true })
    expect(longPress?.config).toMatchObject({
      minDuration: 500,
      maxDistance: 8,
      numberOfPointers: 1,
      runOnJS: true,
    })
    expect(tap?.config).toMatchObject({
      maxDistance: 8,
      maxDuration: 500,
      runOnJS: true,
    })
    expect(result.gestures).toEqual([
      { kind: 'simultaneous', gestures: [pan, pinch] },
      longPress,
      tap,
    ])
  })
})
