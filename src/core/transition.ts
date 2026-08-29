import type { GraphConfigInterface } from './config'

export enum TransitionProperty {
  Positions = 'positions',
  PointColors = 'pointColors',
  PointSizes = 'pointSizes',
  LinkColors = 'linkColors',
  LinkWidths = 'linkWidths',
}

export enum TransitionEasing {
  Linear = 'linear',
  QuadIn = 'quad-in',
  QuadOut = 'quad-out',
  QuadInOut = 'quad-in-out',
  CubicIn = 'cubic-in',
  CubicOut = 'cubic-out',
  CubicInOut = 'cubic-in-out',
  SinIn = 'sin-in',
  SinOut = 'sin-out',
  SinInOut = 'sin-in-out',
  ExpIn = 'exp-in',
  ExpOut = 'exp-out',
  ExpInOut = 'exp-in-out',
  CircleIn = 'circle-in',
  CircleOut = 'circle-out',
  CircleInOut = 'circle-in-out',
}

const HALF_PI = Math.PI / 2

/**
 * The d3-ease curves the engine offers, inlined.
 *
 * These are four-line functions, and taking them as a dependency would pull a
 * package into every React Native bundle for arithmetic we can state directly.
 * The formulas match d3-ease exactly, so a transition looks the same here as it
 * does on the web.
 */
const easingFunctions: Record<TransitionEasing, (t: number) => number> = {
  [TransitionEasing.Linear]: (t) => t,
  [TransitionEasing.QuadIn]: (t) => t * t,
  [TransitionEasing.QuadOut]: (t) => t * (2 - t),
  [TransitionEasing.QuadInOut]: (t) => ((t *= 2) <= 1 ? t * t : --t * (2 - t) + 1) / 2,
  [TransitionEasing.CubicIn]: (t) => t * t * t,
  [TransitionEasing.CubicOut]: (t) => --t * t * t + 1,
  [TransitionEasing.CubicInOut]: (t) => ((t *= 2) <= 1 ? t * t * t : (t -= 2) * t * t + 2) / 2,
  [TransitionEasing.SinIn]: (t) => (t === 1 ? 1 : 1 - Math.cos(t * HALF_PI)),
  [TransitionEasing.SinOut]: (t) => Math.sin(t * HALF_PI),
  [TransitionEasing.SinInOut]: (t) => (1 - Math.cos(Math.PI * t)) / 2,
  [TransitionEasing.ExpIn]: (t) => Math.pow(2, 10 * t - 10),
  [TransitionEasing.ExpOut]: (t) => 1 - Math.pow(2, -10 * t),
  [TransitionEasing.ExpInOut]: (t) =>
    ((t *= 2) <= 1 ? Math.pow(2, 10 * t - 10) : 2 - Math.pow(2, 10 - 10 * t)) / 2,
  [TransitionEasing.CircleIn]: (t) => 1 - Math.sqrt(1 - t * t),
  [TransitionEasing.CircleOut]: (t) => Math.sqrt(1 - --t * t),
  [TransitionEasing.CircleInOut]: (t) =>
    ((t *= 2) <= 1 ? 1 - Math.sqrt(1 - t * t) : Math.sqrt(1 - (t -= 2) * t) + 1) / 2,
}

/**
 * Drives timed transitions (positions / colors / sizes / …) between data updates.
 *
 * Three durations, three scopes:
 * - `config.transitionDuration` — the default (app lifetime);
 * - `overrideDuration` — the plan for the next cycle (this render only; armed by
 *   `setDurationOverride()`, consumed by `start()`);
 * - `activeDuration` — the running cycle's memory (set by `start()`, paces `step()`).
 *
 * The `duration` getter (override, else config) is the single rule for the next
 * cycle: `start()` resolves through it, so code predicting animate vs. snap
 * always matches what `start()` does. The cycle's memory never feeds back into
 * that rule.
 */
export class Transition {
  /** Last eased progress value in the `[0, 1]` range. */
  public progress = 1

  private readonly config: GraphConfigInterface
  private startTime = 0
  /** Properties queued via `queue()`, awaiting `start()` to consume them. */
  private pendingProperties = new Set<TransitionProperty>()
  /** Properties currently animating in the running cycle. */
  private activeProperties = new Set<TransitionProperty>()
  private overrideDuration: number | undefined
  /**
   * Duration (ms) the running animation remembers for all its frames, so an
   * interrupting update with a different duration cannot change the length of a
   * cycle already in flight.
   */
  private activeDuration = 0

  public constructor (config: GraphConfigInterface) {
    this.config = config
  }

  /**
   * Duration (ms) the next `start()` will use: the render override if armed,
   * else the config default. `0` means snap.
   */
  public get duration (): number {
    return this.overrideDuration ?? this.config.transitionDuration
  }

  public get isPending (): boolean {
    return this.pendingProperties.size > 0
  }

  public get isActive (): boolean {
    return this.activeProperties.size > 0
  }

  /** Overrides `config.transitionDuration` for the cycle this render will start. */
  public setDurationOverride (duration?: number): void {
    this.overrideDuration = duration !== undefined && Number.isFinite(duration) ? duration : undefined
  }

  public isPendingFor (property: TransitionProperty): boolean {
    return this.pendingProperties.has(property)
  }

  public isActiveFor (property: TransitionProperty): boolean {
    return this.activeProperties.has(property)
  }

  public queue (property: TransitionProperty): void {
    this.pendingProperties.add(property)
  }

  public dequeue (property: TransitionProperty): void {
    this.pendingProperties.delete(property)
  }

  /**
   * Starts a queued transition cycle.
   *
   * - No pending queue → no-op.
   * - `duration > 0` → begin cycle; fire `onTransitionStart`.
   * - `duration <= 0` → pending is discarded; no cycle begins.
   */
  public start (now = currentTime()): void {
    // Consume the override even when nothing is pending, so it cannot linger
    // into a later render.
    const transitionDuration = this.duration
    this.overrideDuration = undefined

    if (!this.isPending) return

    if (transitionDuration <= 0) {
      const wasActive = this.isActive
      this.pendingProperties.clear()
      this.clearActiveCycle()
      if (wasActive) this.config.onTransitionEnd?.(true)
      return
    }

    if (this.isActive) this.end(true)

    this.activeDuration = transitionDuration
    this.startTime = now
    this.progress = 0
    this.activeProperties = new Set(this.pendingProperties)
    this.pendingProperties.clear()
    this.config.onTransitionStart?.()
  }

  /** Advances the active cycle. */
  public step (now = currentTime()): void {
    if (!this.isActive) return

    const transitionDuration = this.activeDuration
    if (transitionDuration <= 0) {
      this.end(true)
      return
    }

    const linear = Math.min((now - this.startTime) / transitionDuration, 1)
    const eased = this.applyEasing(linear)
    this.progress = eased
    this.config.onTransition?.(eased)

    if (linear >= 1) this.end(false)
  }

  public end (interrupted: boolean): void {
    if (!this.isActive) return
    this.clearActiveCycle()
    this.config.onTransitionEnd?.(interrupted)
  }

  /** Clears active cycle and pending queue without firing lifecycle callbacks. */
  public abort (): void {
    this.pendingProperties.clear()
    this.overrideDuration = undefined
    this.clearActiveCycle()
  }

  private applyEasing (t: number): number {
    const easing = this.config.transitionEasing as TransitionEasing
    return (easingFunctions[easing] ?? easingFunctions[TransitionEasing.Linear])(t)
  }

  private clearActiveCycle (): void {
    this.startTime = 0
    this.progress = 1
    this.activeProperties.clear()
  }
}

/**
 * A monotonic millisecond clock. `performance.now` exists on Hermes and in
 * browsers but is not guaranteed on every React Native runtime, so `Date.now`
 * backs it up.
 */
export function currentTime (): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}
