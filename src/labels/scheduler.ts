export type LabelRefreshReason = 'initial' | 'frame' | 'view' | 'data'

/**
 * Coalesces expensive label policy work without leaving an idle timer alive.
 *
 * `request` never executes the callback inline: even an immediate data/final
 * refresh is queued so a graph-frame listener can return and let its host
 * present first. Motion requests observe the interval; explicit invalidations
 * may bypass it.
 */
export class LabelRefreshScheduler<TReason = LabelRefreshReason> {
  private readonly refresh: (reason: TReason) => void
  private readonly intervalMs: number
  private readonly clock: () => number
  private timeout: ReturnType<typeof setTimeout> | undefined
  private lastRefresh = -Infinity
  private pendingReason: TReason | undefined

  public constructor (
    refresh: (reason: TReason) => void,
    intervalMs = 100,
    clock: () => number = defaultClock
  ) {
    this.refresh = refresh
    this.intervalMs = Number.isFinite(intervalMs) ? Math.max(0, intervalMs) : 100
    this.clock = clock
  }

  public request (reason: TReason, immediate = false): void {
    this.pendingReason = reason
    if (this.timeout !== undefined) {
      if (!immediate) return
      clearTimeout(this.timeout)
    }
    const elapsed = this.clock() - this.lastRefresh
    const delay = immediate ? 0 : Math.max(0, this.intervalMs - elapsed)
    this.timeout = setTimeout(() => {
      this.timeout = undefined
      this.lastRefresh = this.clock()
      const pending = this.pendingReason
      this.pendingReason = undefined
      if (pending !== undefined) this.refresh(pending)
    }, delay)
  }

  public cancel (): void {
    if (this.timeout !== undefined) clearTimeout(this.timeout)
    this.timeout = undefined
    this.pendingReason = undefined
  }
}

function defaultClock (): number {
  return globalThis.performance?.now?.() ?? Date.now()
}
