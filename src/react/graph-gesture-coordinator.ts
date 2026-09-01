/** The engine operations the native gesture layer is allowed to drive. */
export type GraphGestureTarget = {
  onPanStart: (x: number, y: number) => void
  onPanUpdate: (x: number, y: number, translationX: number, translationY: number) => void
  onPanEnd: (x: number, y: number) => void
  onPinchStart: () => void
  onPinchUpdate: (scale: number, focalX: number, focalY: number) => void
  onPinchEnd: () => void
  onTap: (x: number, y: number) => void
  onLongPress: (x: number, y: number) => void
}

export type PanGestureSample = {
  x: number
  y: number
  translationX: number
  translationY: number
}

export type PinchGestureSample = {
  scale: number
  focalX: number
  focalY: number
  pointerCount: number
}

export type GraphGestureCoordinatorState = Readonly<{
  mode: 'idle' | 'pan' | 'pinch'
  activePointerCount: number
  maxPointerCount: number
  didNavigate: boolean
  panRecognizerActive: boolean
  pinchRecognizerActive: boolean
}>

/**
 * Serialises simultaneous native pan and pinch recognisers for one controller.
 *
 * Recognition belongs to RNGH. This class owns only the transition mechanics
 * the graph needs after recognition: pinch takes priority over pan, pan may
 * resume after pinch from a fresh translation baseline, and every started
 * controller gesture ends exactly once.
 */
export class GraphGestureCoordinator {
  private readonly getTarget: () => GraphGestureTarget | undefined
  private mode: 'idle' | 'pan' | 'pinch' = 'idle'
  private activePointerCount = 0
  private maxPointerCount = 0
  private didNavigate = false
  private panRecognizerActive = false
  private pinchRecognizerActive = false
  private panRequiresFreshBaseline = false
  private panTranslationBaseX = 0
  private panTranslationBaseY = 0
  private lastPanX = 0
  private lastPanY = 0

  public constructor (getTarget: () => GraphGestureTarget | undefined) {
    this.getTarget = getTarget
  }

  public get state (): GraphGestureCoordinatorState {
    return {
      mode: this.mode,
      activePointerCount: this.activePointerCount,
      maxPointerCount: this.maxPointerCount,
      didNavigate: this.didNavigate,
      panRecognizerActive: this.panRecognizerActive,
      pinchRecognizerActive: this.pinchRecognizerActive,
    }
  }

  /** Records a pointer-down before any discrete callback may be committed. */
  public onTouchesDown (pointerCount: number): void {
    const count = Math.max(0, pointerCount)
    if (this.activePointerCount === 0) {
      this.maxPointerCount = 0
      this.didNavigate = false
      this.panRequiresFreshBaseline = false
    }
    this.activePointerCount = count
    this.maxPointerCount = Math.max(this.maxPointerCount, count)
  }

  /** Retains the completed sequence's intent until the next pointer-down. */
  public onTouchesUp (pointerCount: number): void {
    this.activePointerCount = Math.max(0, pointerCount)
  }

  public onPanStart (sample: PanGestureSample): void {
    this.panRecognizerActive = true
    this.didNavigate = true
    this.rememberPan(sample)
    if (this.mode === 'pinch' || this.mode === 'pan') return

    const target = this.getTarget()
    if (!target) return
    if (this.panRequiresFreshBaseline) {
      this.panTranslationBaseX = sample.translationX
      this.panTranslationBaseY = sample.translationY
      target.onPanStart(sample.x, sample.y)
      this.panRequiresFreshBaseline = false
    } else {
      this.panTranslationBaseX = 0
      this.panTranslationBaseY = 0
      target.onPanStart(
        sample.x - sample.translationX,
        sample.y - sample.translationY
      )
    }
    this.mode = 'pan'
  }

  public onPanUpdate (sample: PanGestureSample): void {
    this.rememberPan(sample)
    if (!this.panRecognizerActive || this.mode === 'pinch') return

    const target = this.getTarget()
    if (!target) return
    if (this.mode === 'idle') {
      // The remaining finger after a pinch inherits the native recogniser's
      // old cumulative translation. Start a new graph segment at the current
      // position and subtract that history so the camera cannot jump.
      this.panTranslationBaseX = sample.translationX
      this.panTranslationBaseY = sample.translationY
      target.onPanStart(sample.x, sample.y)
      this.mode = 'pan'
      this.panRequiresFreshBaseline = false
    }
    target.onPanUpdate(
      sample.x,
      sample.y,
      sample.translationX - this.panTranslationBaseX,
      sample.translationY - this.panTranslationBaseY
    )
  }

  public onPanFinalize (sample?: PanGestureSample): void {
    if (sample) this.rememberPan(sample)
    this.panRecognizerActive = false
    if (this.mode !== 'pan') return
    this.getTarget()?.onPanEnd(this.lastPanX, this.lastPanY)
    this.mode = 'idle'
  }

  public onPinchStart (): void {
    this.pinchRecognizerActive = true
    this.didNavigate = true
    this.maxPointerCount = Math.max(this.maxPointerCount, 2)
    if (this.mode === 'pinch') return
    if (this.mode === 'pan') {
      this.getTarget()?.onPanEnd(this.lastPanX, this.lastPanY)
      this.mode = 'idle'
    }
    const target = this.getTarget()
    if (!target) return
    target.onPinchStart()
    this.mode = 'pinch'
  }

  public onPinchUpdate (sample: PinchGestureSample): void {
    if (!this.pinchRecognizerActive) return
    this.activePointerCount = Math.max(0, sample.pointerCount)
    this.maxPointerCount = Math.max(this.maxPointerCount, sample.pointerCount)

    // Android emits an ACTIVE pinch update for ACTION_POINTER_UP before it
    // finalises the recogniser. Its focal point has already collapsed from the
    // midpoint to the remaining finger, so applying that sample translates the
    // camera at release even though its cumulative scale has not changed.
    if (sample.pointerCount < 2) return

    const target = this.getTarget()
    if (!target) return
    if (this.mode !== 'pinch') {
      target.onPinchStart()
      this.mode = 'pinch'
    }
    target.onPinchUpdate(sample.scale, sample.focalX, sample.focalY)
  }

  public onPinchFinalize (): void {
    this.pinchRecognizerActive = false
    if (this.mode !== 'pinch') return
    this.getTarget()?.onPinchEnd()
    this.mode = 'idle'
    // Pan may already be active, or may activate only after the remaining
    // finger moves. Either way its native translation includes the pinch
    // history and must not be applied to the post-pinch camera transform.
    this.panRequiresFreshBaseline = true
  }

  public onTap (x: number, y: number, success: boolean): boolean {
    if (!success || !this.canCommitPress()) return false
    this.getTarget()?.onTap(x, y)
    return true
  }

  public onLongPress (x: number, y: number, success: boolean): boolean {
    if (!success || !this.canCommitPress()) return false
    this.getTarget()?.onLongPress(x, y)
    return true
  }

  /** Ends any controller gesture without committing a press. */
  public cancel (): void {
    if (this.mode === 'pan') this.getTarget()?.onPanEnd(this.lastPanX, this.lastPanY)
    if (this.mode === 'pinch') this.getTarget()?.onPinchEnd()
    this.mode = 'idle'
    this.activePointerCount = 0
    this.didNavigate = true
    this.panRecognizerActive = false
    this.pinchRecognizerActive = false
    this.panRequiresFreshBaseline = false
  }

  private canCommitPress (): boolean {
    return !this.didNavigate && this.maxPointerCount === 1
  }

  private rememberPan (sample: PanGestureSample): void {
    this.lastPanX = sample.x
    this.lastPanY = sample.y
  }
}
