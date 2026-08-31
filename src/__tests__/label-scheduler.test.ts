import { afterEach, describe, expect, it, vi } from 'vitest'
import { LabelRefreshScheduler } from '../labels'

afterEach(() => {
  vi.useRealTimers()
})

describe('LabelRefreshScheduler', () => {
  it('coalesces motion to the configured rate and keeps the newest reason', () => {
    vi.useFakeTimers()
    let now = 0
    const reasons: string[] = []
    const scheduler = new LabelRefreshScheduler((reason: string) => reasons.push(reason), 100, () => now)

    scheduler.request('initial', true)
    vi.runOnlyPendingTimers()
    expect(reasons).toEqual(['initial'])

    now = 10
    scheduler.request('frame')
    scheduler.request('view')
    vi.advanceTimersByTime(89)
    expect(reasons).toEqual(['initial'])
    now = 100
    vi.advanceTimersByTime(1)
    expect(reasons).toEqual(['initial', 'view'])
  })

  it('queues immediate work and has no recurring idle callback', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const scheduler = new LabelRefreshScheduler(refresh, 100, () => 0)

    scheduler.request('data', true)
    expect(refresh).not.toHaveBeenCalled()
    vi.runOnlyPendingTimers()
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('cancels pending work on unmount', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const scheduler = new LabelRefreshScheduler(refresh)
    scheduler.request('frame')
    scheduler.cancel()
    vi.runAllTimers()
    expect(refresh).not.toHaveBeenCalled()
  })
})
